/**
 * Plan: for every tracked template, what would change in Copado if the committed version (a git ref,
 * default HEAD) were applied. Also checks the *base*: the last snapshot (last commit that wrote meta.json).
 * If Copado changed since then, someone else's change would be overwritten, so apply refuses.
 */
import type {AgentiaClient} from '../agentia/client.js'
import {TimemachineError} from '../agentia/errors.js'
import {TemplateDetailSchema, type TemplateDetail, type TemplateListItem} from '../agentia/schemas.js'
import {keyMap, type Config, type TrackedTemplate} from '../store/config.js'
import type {Store} from '../store/store.js'
import {hashDocument} from './canonical.js'
import {describeChanges, summariseStatements, type Statement, type StatementSummary} from './describe.js'
import {diffTemplates} from './differ.js'
import {findSaveBlockers, type SaveBlocker} from './inspect.js'
import {fetchLive, type LiveTemplate} from './snapshot.js'

export type PlanStatus = 'changes' | 'in-sync' | 'no-snapshot' | 'base-drifted' | 'error'

export interface PlanEntry {
  template: {id: string; name: string; slug: string}
  status: PlanStatus
  /** live → committed: what apply would do. */
  statements: Statement[]
  summary: StatementSummary
  /** Changes made in Copado since the last snapshot (only for `base-drifted`). */
  driftSinceBase: Statement[]
  saveBlockers: SaveBlocker[]
  error?: {code: string; message: string}
}

export interface PlanItem extends PlanEntry {
  /** Internal: what apply needs. Not part of the JSON output. */
  live?: LiveTemplate
  committed?: TemplateDetail
  listed?: TemplateListItem
}

const EMPTY: StatementSummary = {added: 0, removed: 0, changed: 0, moved: 0}

export async function computePlan(
  client: AgentiaClient,
  store: Store,
  config: Config,
  templates: {tracked: TrackedTemplate; listed: TemplateListItem}[],
  ref: string,
): Promise<PlanItem[]> {
  const keys = keyMap(config)
  const items: PlanItem[] = []
  for (const {tracked, listed} of templates) {
    const base = {
      template: {id: tracked.id, name: tracked.name, slug: tracked.slug},
      statements: [],
      summary: EMPTY,
      driftSinceBase: [],
      saveBlockers: [],
    }
    try {
      const committedJson = await store.showAt(ref, store.templateRel(tracked.slug, 'template.json'))
      if (committedJson === undefined) {
        items.push({...base, status: 'no-snapshot'})
        continue
      }
      const committed = TemplateDetailSchema.parse(JSON.parse(committedJson))
      const live = await fetchLive(client, listed, config)
      const statements = describeChanges(diffTemplates({detail: live.detail}, {detail: committed}, {keys, ignore: config.ignore}))
      const item: PlanItem = {
        ...base,
        status: statements.length === 0 ? 'in-sync' : 'changes',
        statements,
        summary: summariseStatements(statements),
        saveBlockers: statements.length === 0 ? [] : findSaveBlockers(committed),
        live,
        committed,
        listed,
      }
      if (item.status === 'changes') {
        const snapshotDoc = await lastSnapshotDocument(store, tracked.slug, ref)
        if (snapshotDoc && hashDocument(snapshotDoc, keys) !== live.hash) {
          item.status = 'base-drifted'
          item.driftSinceBase = describeChanges(diffTemplates({detail: snapshotDoc}, {detail: live.detail}, {keys, ignore: config.ignore}))
        }
      }
      items.push(item)
    } catch (error) {
      if (!(error instanceof TimemachineError)) throw error
      items.push({...base, status: 'error', error: {code: error.code, message: error.message}})
    }
  }
  return items
}

/**
 * The live state recorded by the last snapshot at or before `ref`: the template.json of the last commit
 * that wrote meta.json (snapshots write meta.json; hand edits in a pull request do not).
 */
export async function lastSnapshotDocument(store: Store, slug: string, ref: string): Promise<unknown | undefined> {
  const commit = (await store.git.raw(['log', '-1', '--format=%H', ref, '--', store.templateRel(slug, 'meta.json')]).catch(() => '')).trim()
  if (!commit) return undefined
  const json = await store.showAt(commit, store.templateRel(slug, 'template.json'))
  return json === undefined ? undefined : JSON.parse(json)
}

/** Strips internal fields for JSON output. */
export function publicEntry(item: PlanItem): PlanEntry {
  const {live: _live, committed: _committed, listed: _listed, ...entry} = item
  return entry
}
