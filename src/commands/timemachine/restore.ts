import {Args, Flags} from '@oclif/core'

import {matchTemplate} from '../../agentia/client.js'
import {ConfirmationRequiredError, SaveBlockedError} from '../../agentia/errors.js'
import {TemplateDetailSchema} from '../../agentia/schemas.js'
import {TimemachineCommand} from '../../base-command.js'
import {applyDetail, type ApplyResult} from '../../core/apply.js'
import {hashDocument, shortHash} from '../../core/canonical.js'
import {describeChanges, formatStatementSummary, summariseStatements, type Statement} from '../../core/describe.js'
import {diffTemplates} from '../../core/differ.js'
import {findSaveBlockers} from '../../core/inspect.js'
import {checkOrgBusy, resolveLockPath} from '../../core/org-lock.js'
import {fetchLive} from '../../core/snapshot.js'
import {renderText} from '../../render/diff.js'
import {confirm, isInteractive} from '../../render/prompt.js'
import {style} from '../../render/style.js'
import {keyMap} from '../../store/config.js'
import {Store} from '../../store/store.js'
import {loadSnapshot} from './diff.js'
import {findTracked} from './history.js'

export interface RestoreResult {
  template: {id: string; name: string; slug: string}
  target: {ref: string; hash: string}
  outcome: 'restored' | 'already-current' | 'dry-run' | 'cancelled'
  /** What changes live → target (in the detail document). */
  statements: Statement[]
  /** Differences in advanced filters / matching formulas, which restore does not write. */
  extrasNotRestored: Statement[]
  apply?: ApplyResult
  /** Command that undoes this restore. */
  undo?: string
}

export default class TimemachineRestore extends TimemachineCommand {
  static override summary = 'Restore a data template to an earlier snapshot.'
  static override description = `Shows what will change (live → target) and asks for confirmation. Then it:
  1. snapshots the current live state, so the restore can itself be undone,
  2. saves the target version with \`agentia cicd data template save-detail\`,
  3. reads the template back and verifies its hash matches the target,
  4. snapshots the restored state and prints the command to undo.

Only the v2 detail document is restored. Advanced filters and record matching formulas are separate Copado
resources; differences in them are listed but not written.`

  static override examples = [
    '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New" --to 36e5bbd',
    '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New" --to 36e5bbd --dry-run',
    '<%= config.bin %> <%= command.id %> tm-demo-accounts-new --to HEAD~1 --yes --json',
  ]

  static override args = {
    template: Args.string({description: 'Tracked template name, Id or slug.', required: true}),
  }

  static override flags = {
    to: Flags.string({description: 'Snapshot ref to restore (from `timemachine history`).', required: true}),
    yes: Flags.boolean({char: 'y', description: 'Do not ask for confirmation.'}),
    'dry-run': Flags.boolean({description: 'Show what would change and write nothing.'}),
    'ignore-busy': Flags.boolean({description: 'Proceed even if the shared org lock file exists.'}),
  }

  public async run(): Promise<RestoreResult> {
    const {args, flags} = await this.parse(TimemachineRestore)
    const store = Store.require(process.cwd())
    const config = store.loadConfig()
    const keys = keyMap(config)
    const tracked = findTracked(config.templates, args.template)

    const targetState = await loadSnapshot(store, tracked, flags.to)
    const target = TemplateDetailSchema.parse(targetState.detail)
    const targetRef = (await store.git.revparse([flags.to])).trim()
    const targetHash = hashDocument(target, keys)

    const client = this.createClient(store.root)
    const agentiaVersion = await client.assertSupportedVersion()
    const template = matchTemplate(await client.listTemplates(), tracked.id)
    const live = await fetchLive(client, template, config)

    const all = describeChanges(diffTemplates(live, targetState, {keys, ignore: config.ignore}))
    const statements = all.filter((s) => !isExtras(s))
    const extrasNotRestored = all.filter(isExtras)
    const base = {
      template: {id: tracked.id, name: tracked.name, slug: tracked.slug},
      target: {ref: targetRef, hash: targetHash},
      statements,
      extrasNotRestored,
    }
    const label = targetRef.slice(0, 7)

    if (live.hash === targetHash) {
      if (!this.jsonEnabled()) {
        this.log(`${style.green('✔')} ${tracked.name} already matches ${label}. Nothing to restore.`)
        this.warnExtras(extrasNotRestored)
      }
      return {...base, outcome: 'already-current'}
    }

    if (!this.jsonEnabled()) {
      this.log(renderText(statements, summariseStatements(statements), {title: `Restore ${tracked.name}`, from: 'live', to: label}))
      this.warnExtras(extrasNotRestored)
    }

    const blockers = findSaveBlockers(target)
    if (blockers.length > 0)
      throw new SaveBlockedError(
        tracked.name,
        blockers.map((b) => b.fix),
      )

    if (flags['dry-run']) {
      if (!this.jsonEnabled()) this.log(style.dim('\nDry run: nothing was written.'))
      return {...base, outcome: 'dry-run'}
    }

    checkOrgBusy(resolveLockPath(config.orgBusyFile), flags['ignore-busy'])
    if (!flags.yes) {
      if (this.jsonEnabled() || !isInteractive()) throw new ConfirmationRequiredError('Restoring a template')
      const summary = formatStatementSummary(summariseStatements(statements))
      if (!(await confirm(`\nRestore ${tracked.name} to ${label} (${summary})?`))) {
        this.log('Cancelled. Nothing was written.')
        return {...base, outcome: 'cancelled'}
      }
    }

    const apply = await applyDetail({
      client,
      store,
      template,
      target,
      expectedLiveHash: live.hash,
      action: 'restore',
      reasonBefore: `before restore to ${label}`,
      reasonAfter: `restore to ${label}`,
      ignoreBusy: flags['ignore-busy'],
      agentiaVersion,
    })
    const undo = `agentia timemachine restore "${tracked.name}" --to ${apply.before.commit.slice(0, 7)}`

    if (!this.jsonEnabled()) {
      this.log(`\n${style.green('✔')} Restored ${style.bold(tracked.name)} to ${label} and verified (hash ${shortHash(apply.after.hash)}).`)
      this.log(`  Previous version saved as ${style.cyan(apply.before.commit.slice(0, 7))}.`)
      this.log(`  Undo: ${style.cyan(undo)}`)
    }
    return {...base, outcome: 'restored', apply, undo}
  }

  private warnExtras(extras: Statement[]): void {
    if (extras.length === 0) return
    this.log(`\n${style.yellow('!')} Not restored (separate Copado resources, change them with \`agentia cicd data filter|formula\`):`)
    for (const s of extras) this.log(`  ${s.sign} ${s.text}`)
  }
}

function isExtras(s: Statement): boolean {
  return s.entity.kind === 'advancedFilter' || s.entity.kind === 'formula' || s.changes.every((c) => c.path.startsWith('extras'))
}
