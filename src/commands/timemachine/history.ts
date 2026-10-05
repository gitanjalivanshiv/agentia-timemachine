import {Args, Flags} from '@oclif/core'

import {NoSnapshotError, TemplateNotFoundError} from '../../agentia/errors.js'
import {TimemachineCommand} from '../../base-command.js'
import {hashDocument, shortHash} from '../../core/canonical.js'
import {style, table} from '../../render/style.js'
import {keyMap} from '../../store/config.js'
import type {TrackedTemplate} from '../../store/config.js'
import {Store, type HistoryEntry} from '../../store/store.js'

export interface HistoryRow {
  ref: string
  commit: string
  date: string
  author: string
  hash: string | null
  change: string | null
  reason: string | null
  subject: string
}

export default class TimemachineHistory extends TimemachineCommand {
  static override summary = 'Show the snapshot timeline of a data template.'
  static override description = `Lists every snapshot of a template, newest first: version ref (use it with diff/restore --to), date,
author, reason and a one-line change summary. Reads the local snapshot repository only.`

  static override examples = [
    '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New"',
    '<%= config.bin %> <%= command.id %> tm-demo-accounts-new --limit 5 --json',
  ]

  static override args = {
    template: Args.string({description: 'Tracked template name, Id or slug.', required: true}),
  }

  static override flags = {
    limit: Flags.integer({char: 'n', description: 'Show at most this many snapshots.'}),
  }

  public async run(): Promise<HistoryRow[]> {
    const {args, flags} = await this.parse(TimemachineHistory)
    const store = Store.require(process.cwd())
    const tracked = findTracked(store.loadConfig().templates, args.template)
    const entries = await store.history(tracked.slug, flags.limit)
    if (entries.length === 0) throw new NoSnapshotError(tracked.name)

    const keys = keyMap(store.loadConfig())
    const rows = await Promise.all(
      entries.map(async (e) => {
        const doc = await store.showAt(e.commit, store.templateRel(tracked.slug, 'template.json'))
        return toRow(e, doc ? shortHash(hashDocument(JSON.parse(doc), keys)) : null)
      }),
    )
    if (!this.jsonEnabled()) {
      this.log(`${style.bold(tracked.name)} ${style.dim(`(.timemachine/templates/${tracked.slug})`)}\n`)
      this.log(
        table(
          ['REF', 'DATE', 'AUTHOR', 'HASH', 'CHANGE', 'REASON'],
          rows.map((r) => [
            style.cyan(r.ref),
            r.date.replace('T', ' ').slice(0, 16),
            r.author,
            r.hash ?? '',
            r.change ?? '',
            r.reason ?? '',
          ]),
        ),
      )
      this.log(style.dim(`\nCompare with: agentia timemachine diff "${tracked.name}" --from <REF>`))
    }
    return rows
  }
}

/** Matches a tracked template by Id (15/18), slug or name (case-insensitive). Local only. */
export function findTracked(templates: TrackedTemplate[], ref: string): TrackedTemplate {
  const r = ref.trim().toLowerCase()
  const found = templates.find((t) => t.id === ref || t.id.slice(0, 15) === ref.slice(0, 15) || t.slug === r || t.name.toLowerCase() === r)
  if (!found) throw new TemplateNotFoundError(ref, {hint: 'Only tracked templates have history. See .timemachine/config.json.'})
  return found
}

function toRow(e: HistoryEntry, hash: string | null): HistoryRow {
  return {
    ref: e.shortCommit,
    commit: e.commit,
    date: e.date,
    author: e.author,
    // Recomputed from the stored file so hashes are comparable with `status` and `diff`.
    hash,
    change: e.trailers['Change'] ?? null,
    reason: e.trailers['Reason'] ?? null,
    subject: e.subject,
  }
}
