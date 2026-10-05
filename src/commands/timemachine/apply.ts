import {Args, Flags} from '@oclif/core'

import {ConfirmationRequiredError, ExitCode, TimemachineError} from '../../agentia/errors.js'
import {TimemachineCommand} from '../../base-command.js'
import {applyDetail, type ApplyResult} from '../../core/apply.js'
import {shortHash} from '../../core/canonical.js'
import {computePlan, publicEntry, type PlanEntry} from '../../core/plan.js'
import {checkOrgBusy, resolveLockPath} from '../../core/org-lock.js'
import {resolveTracked} from '../../core/targets.js'
import {renderPlanText} from '../../render/plan.js'
import {confirm, isInteractive} from '../../render/prompt.js'
import {style} from '../../render/style.js'
import {Store} from '../../store/store.js'

export type ApplyOutcome = 'applied' | 'in-sync' | 'blocked' | 'failed' | 'skipped'

export interface ApplyEntry {
  template: PlanEntry['template']
  outcome: ApplyOutcome
  reason?: string
  apply?: ApplyResult
  undo?: string
}

export interface ApplyCommandResult {
  ref: string
  dryRun: boolean
  results: ApplyEntry[]
}

export default class TimemachineApply extends TimemachineCommand {
  static override summary = 'Apply the committed template versions (e.g. after a pull request is merged) to Copado.'
  static override description = `For each tracked template whose committed version (default HEAD) differs from Copado, saves it through the
same safe path as restore and edit: lock, re-check, pre-change snapshot, save, read-back verification,
post-change snapshot.

A template is skipped (blocked) when Copado changed after its last snapshot (someone else's change would
be overwritten) or when Copado would reject the document. Review first with \`timemachine plan\`.`

  static override examples = [
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %> --yes',
    '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New" --ref main --yes --json',
  ]

  static override strict = false
  static override args = {
    templates: Args.string({description: 'Tracked template names, Ids or slugs (default: all tracked).', required: false}),
  }

  static override flags = {
    ref: Flags.string({description: 'Git ref with the versions to apply.', default: 'HEAD'}),
    yes: Flags.boolean({char: 'y', description: 'Do not ask for confirmation.'}),
    'dry-run': Flags.boolean({description: 'Show the plan only; write nothing.'}),
    'ignore-busy': Flags.boolean({description: 'Proceed even if the shared org lock file exists.'}),
  }

  public async run(): Promise<ApplyCommandResult> {
    const {argv, flags} = await this.parse(TimemachineApply)
    const store = Store.require(process.cwd())
    const config = store.loadConfig()
    const client = this.createClient(store.root)
    const agentiaVersion = await client.assertSupportedVersion()
    const targets = await resolveTracked(client, config, argv as string[])
    const ref = (await store.git.revparse(['--short', flags.ref])).trim()

    const plan = await computePlan(client, store, config, targets, flags.ref)
    if (!this.jsonEnabled()) this.log(renderPlanText(plan.map(publicEntry), ref))

    const results: ApplyEntry[] = []
    const ready = plan.filter((p) => p.status === 'changes' && p.saveBlockers.length === 0)
    for (const p of plan) {
      if (ready.includes(p)) continue
      const reason =
        p.status === 'base-drifted'
          ? 'Copado changed since the last snapshot'
          : p.saveBlockers.length > 0
            ? p.saveBlockers.map((b) => b.fix).join(' ')
            : p.status === 'error'
              ? p.error?.message
              : p.status === 'no-snapshot'
                ? `no version committed at ${ref}`
                : undefined
      results.push({
        template: p.template,
        outcome: p.status === 'in-sync' ? 'in-sync' : p.status === 'no-snapshot' ? 'skipped' : 'blocked',
        reason,
      })
    }

    if (ready.length === 0 || flags['dry-run']) {
      if (flags['dry-run'] && ready.length > 0 && !this.jsonEnabled()) this.log(style.dim('\nDry run: nothing was written.'))
      for (const p of ready) results.push({template: p.template, outcome: 'skipped', reason: 'dry run'})
      this.finish(results)
      return {ref, dryRun: Boolean(flags['dry-run']), results}
    }

    checkOrgBusy(resolveLockPath(config.orgBusyFile), flags['ignore-busy'])
    if (!flags.yes) {
      if (this.jsonEnabled() || !isInteractive()) throw new ConfirmationRequiredError('Applying templates')
      if (!(await confirm(`\nApply ${ready.length} template${ready.length === 1 ? '' : 's'} from ${ref} to Copado?`))) {
        this.log('Cancelled. Nothing was written.')
        return {ref, dryRun: false, results}
      }
    }

    for (const p of ready) {
      try {
        const apply = await applyDetail({
          client,
          store,
          template: p.listed!,
          target: p.committed!,
          expectedLiveHash: p.live!.hash,
          action: 'apply',
          reasonBefore: `before apply ${ref}`,
          reasonAfter: `apply ${ref}`,
          ignoreBusy: flags['ignore-busy'],
          agentiaVersion,
        })
        const undo = `agentia timemachine restore "${p.template.name}" --to ${apply.before.commit.slice(0, 7)}`
        results.push({template: p.template, outcome: 'applied', apply, undo})
        if (!this.jsonEnabled()) {
          this.log(
            `${style.green('✔')} Applied ${style.bold(p.template.name)} and verified (hash ${shortHash(apply.after.hash)}). Undo: ${style.cyan(undo)}`,
          )
        }
      } catch (error) {
        if (!(error instanceof TimemachineError) || error.code === 'AUTH_MISSING' || error.code === 'ORG_BUSY') throw error
        results.push({template: p.template, outcome: 'failed', reason: error.message})
        if (!this.jsonEnabled()) this.log(`${style.red('✖')} ${p.template.name}: ${error.message}`)
      }
    }
    this.finish(results)
    return {ref, dryRun: false, results}
  }

  /** Non-zero exit when anything was blocked or failed. */
  private finish(results: ApplyEntry[]): void {
    const bad = results.filter((r) => r.outcome === 'blocked' || r.outcome === 'failed')
    if (bad.length === 0) return
    if (!this.jsonEnabled()) for (const r of bad) this.log(`${style.yellow('!')} ${r.template.name}: ${r.outcome}: ${r.reason}`)
    this.fail(
      bad.some((r) => r.reason?.includes('Copado changed'))
        ? ExitCode.Conflict
        : bad.some((r) => r.outcome === 'failed')
          ? ExitCode.Generic
          : ExitCode.Validation,
    )
  }
}
