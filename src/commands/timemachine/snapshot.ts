import {Args, Flags} from '@oclif/core'

import {ExitCode, TemplateNotFoundError, TimemachineError} from '../../agentia/errors.js'
import {TimemachineCommand} from '../../base-command.js'
import {shortHash} from '../../core/canonical.js'
import {snapshotTemplate, type SnapshotResult} from '../../core/snapshot.js'
import {formatStatementSummary} from '../../core/describe.js'
import {resolveTargets} from '../../core/targets.js'
import {style} from '../../render/style.js'
import {Store} from '../../store/store.js'

export interface SnapshotFailure {
  ref: string
  error: {code: string; message: string; hint?: string}
}

export interface SnapshotCommandResult {
  snapshots: SnapshotResult[]
  failures: SnapshotFailure[]
}

/** Errors that would hit every template: stop at once. */
const FATAL = new Set<number>([ExitCode.AuthMissing, ExitCode.AgentiaUnavailable])

export default class TimemachineSnapshot extends TimemachineCommand {
  static override summary = 'Save the live state of data templates into the snapshot repository.'
  static override description = `Fetches each template's v2 detail document (plus advanced filters and record matching formulas), writes it
under .timemachine/templates/<slug>/ and commits it, but only when something changed. Otherwise it reports "unchanged".
Naming a template that is not tracked yet starts tracking it.`

  static override examples = [
    '<%= config.bin %> <%= command.id %> --all',
    '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New" --reason "before adding Region"',
    '<%= config.bin %> <%= command.id %> --all --dry-run --json',
  ]

  static override strict = false
  static override args = {
    templates: Args.string({description: 'Template names, Ids or slugs.', required: false}),
  }

  static override flags = {
    all: Flags.boolean({description: 'Snapshot every tracked template.'}),
    reason: Flags.string({char: 'r', description: 'Why this snapshot was taken (stored in the commit).'}),
    'dry-run': Flags.boolean({description: 'Fetch and compare, but write nothing.'}),
  }

  public async run(): Promise<SnapshotCommandResult> {
    const {argv, flags} = await this.parse(TimemachineSnapshot)
    const refs = argv as string[]
    if (refs.length === 0 && !flags.all) this.error('Name one or more templates, or use --all.', {exit: ExitCode.Usage})

    const store = Store.require(process.cwd())
    const client = this.createClient(store.root)
    const agentiaVersion = await client.assertSupportedVersion()
    const config = store.loadConfig()
    if (refs.length === 0 && config.templates.length === 0) {
      this.error('No templates are tracked yet.', {
        exit: ExitCode.Usage,
        suggestions: ['agentia timemachine init --track "<template name>"'],
      })
    }

    const {templates, missing} = await resolveTargets(client, config, refs)
    const result: SnapshotCommandResult = {
      snapshots: [],
      failures: missing.map((m) => ({
        ref: m.name,
        error: {code: 'TEMPLATE_NOT_FOUND', message: new TemplateNotFoundError(m.name).message},
      })),
    }

    // Sequential: each snapshot is its own commit.
    for (const template of templates) {
      try {
        const snap = await snapshotTemplate(client, store, template, {reason: flags.reason, dryRun: flags['dry-run'], agentiaVersion})
        result.snapshots.push(snap)
        if (!this.jsonEnabled()) this.log(describe(snap))
      } catch (error) {
        if (!(error instanceof TimemachineError) || FATAL.has(error.exitCode)) throw error
        result.failures.push({ref: template.name, error: {code: error.code, message: error.message, hint: error.hint}})
        if (!this.jsonEnabled())
          this.log(`${style.red('✖')} ${template.name}: ${error.message}${error.hint ? `\n  ${style.dim('→')} ${error.hint}` : ''}`)
      }
    }
    if (!this.jsonEnabled()) {
      for (const m of missing) this.log(`${style.red('✖')} ${m.name}: tracked, but no longer found in Copado.`)
    }

    if (result.failures.length > 0) this.fail(result.snapshots.length > 0 ? ExitCode.Generic : failureExit(result.failures))
    return result
  }
}

function describe(s: SnapshotResult): string {
  const hash = style.dim(`(${shortHash(s.hash)})`)
  const dry = s.dryRun ? style.yellow(' [dry run, nothing written]') : ''
  if (s.outcome === 'unchanged') return `${style.dim('=')} ${s.name} ${hash} unchanged`
  const commit = s.commit ? style.dim(` commit ${s.commit.slice(0, 7)}`) : ''
  if (s.outcome === 'created') return `${style.green('✔')} ${s.name} ${hash} first snapshot${commit}${dry}`
  return `${style.green('✔')} ${s.name} ${hash} ${formatStatementSummary(s.change!)}${commit}${dry}`
}

function failureExit(failures: SnapshotFailure[]): number {
  const codes: Record<string, number> = {TEMPLATE_LEGACY: ExitCode.Legacy, TEMPLATE_NOT_FOUND: ExitCode.NotFound}
  return codes[failures[0].error.code] ?? ExitCode.Generic
}
