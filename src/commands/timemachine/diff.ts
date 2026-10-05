import {Args, Flags} from '@oclif/core'

import {matchTemplate} from '../../agentia/client.js'
import {ExitCode, NoSnapshotError, TimemachineError} from '../../agentia/errors.js'
import {TimemachineCommand} from '../../base-command.js'
import {hashDocument, shortHash} from '../../core/canonical.js'
import {describeChanges, summariseStatements, type Statement, type StatementSummary} from '../../core/describe.js'
import {diffTemplates, type TemplateState} from '../../core/differ.js'
import {fetchLive} from '../../core/snapshot.js'
import {renderMarkdown, renderText} from '../../render/diff.js'
import {keyMap, type TrackedTemplate} from '../../store/config.js'
import {Store} from '../../store/store.js'
import {findTracked} from './history.js'

export interface DiffSide {
  ref: string
  label: string
  hash: string
}

export interface DiffResult {
  template: {id: string; name: string; slug: string}
  from: DiffSide
  to: DiffSide
  identical: boolean
  summary: StatementSummary
  statements: Statement[]
}

const LIVE = 'live'

export default class TimemachineDiff extends TimemachineCommand {
  static override summary = 'Show what changed in a data template, in human terms.'
  static override description = `Compares two versions of a template's v2 detail document (plus advanced filters and matching formulas)
by JSON path and prints statements such as "+ field Region__c added to Account".

Versions are snapshot refs from \`timemachine history\` (any git ref works) or "live" (read from Copado now).
Default: the last snapshot → live.`

  static override examples = [
    '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New"',
    '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New" --from 36e5bbd --to live',
    '<%= config.bin %> <%= command.id %> tm-demo-accounts-new --from HEAD~2 --to HEAD --format md',
    '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New" --json',
  ]

  static override args = {
    template: Args.string({description: 'Tracked template name, Id or slug.', required: true}),
  }

  static override flags = {
    from: Flags.string({description: 'Older version: a snapshot ref or "live". Default: last snapshot.'}),
    to: Flags.string({description: 'Newer version: a snapshot ref or "live".', default: LIVE}),
    format: Flags.string({description: 'Human output format.', options: ['text', 'md'], default: 'text'}),
    'exit-code': Flags.boolean({description: 'Exit with 1 when there are differences (like `git diff --exit-code`).'}),
  }

  public async run(): Promise<DiffResult> {
    const {args, flags} = await this.parse(TimemachineDiff)
    const store = Store.require(process.cwd())
    const config = store.loadConfig()
    const tracked = findTracked(config.templates, args.template)

    const lastSnapshot = (await store.history(tracked.slug, 1))[0]
    const fromRef = flags.from ?? lastSnapshot?.commit
    if (!fromRef) throw new NoSnapshotError(tracked.name)

    const keys = keyMap(config)
    const load = async (ref: string): Promise<{state: TemplateState; side: DiffSide}> => {
      if (ref === LIVE) {
        const client = this.createClient(store.root)
        await client.assertSupportedVersion()
        const live = await fetchLive(client, matchTemplate(await client.listTemplates(), tracked.id), config)
        return {state: live, side: {ref: LIVE, label: LIVE, hash: live.hash}}
      }
      const state = await loadSnapshot(store, tracked, ref)
      const sha = (await store.git.revparse([ref]).catch(() => ref)).trim()
      return {state, side: {ref: sha, label: sha.slice(0, 7), hash: hashDocument(state.detail, keys)}}
    }

    const [from, to] = await Promise.all([load(fromRef), load(flags.to)])
    const statements = describeChanges(diffTemplates(from.state, to.state, {keys, ignore: config.ignore}))
    const summary = summariseStatements(statements)
    const result: DiffResult = {
      template: {id: tracked.id, name: tracked.name, slug: tracked.slug},
      from: from.side,
      to: to.side,
      identical: statements.length === 0,
      summary,
      statements,
    }

    if (!this.jsonEnabled()) {
      const header = {title: tracked.name, from: from.side.label, to: to.side.label}
      this.log(flags.format === 'md' ? renderMarkdown(statements, summary, header) : renderText(statements, summary, header))
      if (flags.format !== 'md' && from.side.hash !== to.side.hash) this.log(`\n${shortHash(from.side.hash)} → ${shortHash(to.side.hash)}`)
    }
    if (flags['exit-code'] && !result.identical) this.fail(1)
    return result
  }
}

/** A template's detail + extras as stored at a git ref. */
export async function loadSnapshot(store: Store, tracked: TrackedTemplate, ref: string): Promise<TemplateState> {
  const detail = await store.showAt(ref, store.templateRel(tracked.slug, 'template.json'))
  if (detail === undefined) {
    throw new TimemachineError('NO_SNAPSHOT', `"${tracked.name}" has no snapshot at "${ref}".`, ExitCode.NotFound, {
      hint: `See the available versions with \`agentia timemachine history "${tracked.name}"\`.`,
    })
  }
  const extras = await store.showAt(ref, store.templateRel(tracked.slug, 'extras.json'))
  return {detail: JSON.parse(detail), extras: extras ? JSON.parse(extras) : {}}
}
