import {Args} from '@oclif/core'

import {ExitCode, TimemachineError} from '../../agentia/errors.js'
import type {TemplateListItem} from '../../agentia/schemas.js'
import {TimemachineCommand} from '../../base-command.js'
import {hashDocument, shortHash} from '../../core/canonical.js'
import {inspectTemplate, mapLimit, type SaveBlocker, type TemplateFormat} from '../../core/inspect.js'
import {resolveTargets} from '../../core/targets.js'
import {style, table} from '../../render/style.js'
import {defaultConfig, keyMap} from '../../store/config.js'
import {EditSessions} from '../../core/edit-session.js'
import {Store} from '../../store/store.js'

export type SnapshotState = 'in-sync' | 'drifted' | 'never' | 'untracked' | 'unknown'

export interface StatusRow {
  id: string
  name: string
  mainObject: string | null
  lastModified: string | null
  format: TemplateFormat | 'error' | 'missing'
  /** True when `save-detail` would accept the current document (v2, no blockers). */
  saveable: boolean
  saveBlockers: SaveBlocker[]
  /** Live vs last snapshot. `untracked` outside a workspace or for untracked templates. */
  snapshot: SnapshotState
  lastSnapshotHash: string | null
  liveHash: string | null
  error?: {code: string; message: string}
  /** Edit sessions in progress in this workspace (`timemachine edit --start`). */
  editSessions: {session: string; startedAt: string; startedBy: string}[]
}

/** Errors that would make every row fail: surface them once instead of per template. */
const FATAL_EXIT_CODES = new Set<number>([ExitCode.AuthMissing, ExitCode.AgentiaUnavailable])

export default class TimemachineStatus extends TimemachineCommand {
  static override summary = 'Show tracked data templates: in sync, drifted, never snapshotted, legacy or blocked.'
  static override description = `In a timemachine workspace this reports the tracked templates (or the ones you name). Outside a workspace it
reports every template in the org. For each template:

  SNAPSHOT  in sync · drifted since <hash> (changed in Copado since the last snapshot) · never snapshotted
  FORMAT    v2, or legacy (built in the Copado UI; run \`agentia cicd data template convert-old <id>\` once)
  SAVE      ready, or blocked until a required field is filled in (shown with the fix)`

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New"',
    '<%= config.bin %> <%= command.id %> --json',
  ]

  static override strict = false
  static override args = {
    templates: Args.string({description: 'Template names, Ids or slugs (default: tracked templates).', required: false}),
  }

  public async run(): Promise<StatusRow[]> {
    const {argv} = await this.parse(TimemachineStatus)
    const refs = argv as string[]
    const store = Store.find(process.cwd())
    const client = this.createClient(store?.root)
    await client.assertSupportedVersion()

    const config = store?.loadConfig()
    let templates: TemplateListItem[]
    let missing: {id: string; name: string}[] = []
    if (refs.length > 0 || (config && config.templates.length > 0)) {
      ;({templates, missing} = await resolveTargets(client, config ?? defaultConfig(), refs))
    } else if (config) {
      templates = [] // workspace with nothing tracked
    } else {
      templates = await client.listTemplates()
    }

    const keys = config ? keyMap(config) : undefined
    const rows = await mapLimit(templates, 4, async (template): Promise<StatusRow> => {
      const tracked = config?.templates.find((t) => t.id === template.id)
      const last = tracked ? store!.readSnapshot(tracked.slug) : undefined
      // Recomputed from the stored document (not meta.json) so canonicalisation changes never look like drift.
      const lastHash = last ? hashDocument(last.detail, keys) : null
      const base = {
        id: template.id,
        name: template.name,
        mainObject: template.mainObject ?? null,
        lastModified: template.lastModified ?? null,
        lastSnapshotHash: lastHash,
        editSessions: tracked
          ? new EditSessions(store!)
              .list(tracked.slug)
              .map((e) => ({session: e.info.session, startedAt: e.info.startedAt, startedBy: e.info.startedBy}))
          : [],
      }
      try {
        const inspection = await inspectTemplate(client, template)
        const liveHash = inspection.detail ? hashDocument(inspection.detail, keys) : null
        let snapshot: SnapshotState = 'unknown'
        if (!tracked) snapshot = 'untracked'
        else if (!last) snapshot = 'never'
        else if (liveHash !== null) snapshot = liveHash === lastHash ? 'in-sync' : 'drifted'
        return {
          ...base,
          format: inspection.format,
          saveable: inspection.format === 'v2' && inspection.saveBlockers.length === 0,
          saveBlockers: inspection.saveBlockers,
          snapshot,
          liveHash,
        }
      } catch (error) {
        if (!(error instanceof TimemachineError) || FATAL_EXIT_CODES.has(error.exitCode)) throw error
        return {
          ...base,
          format: 'error',
          saveable: false,
          saveBlockers: [],
          snapshot: 'unknown',
          liveHash: null,
          error: {code: error.code, message: error.message},
        }
      }
    })
    for (const m of missing) {
      rows.push({
        id: m.id,
        name: m.name,
        mainObject: null,
        lastModified: null,
        format: 'missing',
        saveable: false,
        saveBlockers: [],
        snapshot: 'unknown',
        lastSnapshotHash: null,
        liveHash: null,
        editSessions: [],
        error: {code: 'TEMPLATE_NOT_FOUND', message: 'Tracked, but no longer found in Copado.'},
      })
    }

    if (!this.jsonEnabled()) this.render(rows, Boolean(store))
    return rows
  }

  private render(rows: StatusRow[], inWorkspace: boolean): void {
    if (rows.length === 0) {
      this.log(inWorkspace ? 'No templates are tracked yet. Run `agentia timemachine init --track "<name>"`.' : 'No data templates found.')
      return
    }
    const headers = inWorkspace
      ? ['TEMPLATE', 'SNAPSHOT', 'FORMAT', 'SAVE', 'LAST MODIFIED']
      : ['TEMPLATE', 'OBJECT', 'FORMAT', 'STATE', 'LAST MODIFIED']
    this.log(
      table(
        headers,
        rows.map((r) => {
          const modified = (r.lastModified ?? '').replace(/\.\d{3}\+0000$/, 'Z')
          return inWorkspace
            ? [r.name, describeSnapshot(r), r.format, describeSave(r), modified]
            : [r.name, r.mainObject ?? '', r.format, describeSave(r), modified]
        }),
      ),
    )
    const notes = rows.flatMap((r) => {
      if (r.format === 'legacy') {
        return [`${style.yellow('!')} ${r.name}: convert once with \`agentia cicd data template convert-old ${r.id}\` (writes to the org).`]
      }
      if (r.format === 'error' || r.format === 'missing') return [`${style.red('✖')} ${r.name}: ${r.error?.message}`]
      const out = [...new Set(r.saveBlockers.map((b) => b.fix))].map((fix) => `${style.yellow('!')} ${r.name}: ${fix}`)
      for (const e of r.editSessions) {
        out.push(
          `${style.cyan('✎')} ${r.name}: edit in progress (session ${e.session}, ${e.startedBy}, since ${e.startedAt.slice(0, 16).replace('T', ' ')})`,
        )
      }
      if (r.snapshot === 'drifted') {
        out.push(
          `${style.yellow('~')} ${r.name}: changed in Copado since the last snapshot. Run \`agentia timemachine snapshot "${r.name}"\` to record it.`,
        )
      }
      return out
    })
    if (notes.length > 0) this.log(`\n${notes.join('\n')}`)
    if (!inWorkspace) this.log(style.dim('\nNot in a timemachine workspace. Run `agentia timemachine init` to start versioning templates.'))
  }
}

function describeSnapshot(row: StatusRow): string {
  const last = row.lastSnapshotHash ? shortHash(row.lastSnapshotHash) : ''
  switch (row.snapshot) {
    case 'in-sync':
      return style.green(`in sync (${last})`)
    case 'drifted':
      return style.yellow(`drifted since ${last}`)
    case 'never':
      return style.yellow('never snapshotted')
    case 'untracked':
      return style.dim('untracked')
    default:
      return style.dim('—')
  }
}

function describeSave(row: StatusRow): string {
  if (row.format === 'legacy') return style.yellow('needs v2 conversion')
  if (row.format === 'error' || row.format === 'missing') return style.red('error')
  if (!row.saveable) {
    const fields = [...new Set(row.saveBlockers.map((b) => (b.field === 'rawFilters' ? 'filters' : b.field)))]
    return style.yellow(`blocked (${fields.join(', ')})`)
  }
  return style.green('ready')
}
