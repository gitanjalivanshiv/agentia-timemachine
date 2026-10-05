import type {AgentiaClient} from '../agentia/client.js'
import {LegacyTemplateError, TemplateNotFoundError} from '../agentia/errors.js'
import type {TemplateDetail, TemplateListItem} from '../agentia/schemas.js'

export type TemplateFormat = 'v2' | 'legacy'

/** A required detail field that is null/empty. Copado's gateway strips such values and then rejects the save. */
export interface SaveBlocker {
  /** JSON path in the detail document, e.g. `details[0].limit`. */
  path: string
  object: string
  field: 'filters' | 'rawFilters' | 'limit'
  /** What to do in the Copado UI. */
  fix: string
}

export interface TemplateInspection {
  template: TemplateListItem
  format: TemplateFormat
  /** Present for v2 templates. */
  detail?: TemplateDetail
  saveBlockers: SaveBlocker[]
}

/**
 * Classifies a listed template:
 * - `v2`: `get-detail` works (and reports any save blockers).
 * - `legacy`: `get-detail` fails with DAT-004 but `get` works. Built in the Copado UI and not yet
 *   converted; `agentia cicd data template convert-old <id>` fixes it.
 */
export async function inspectTemplate(client: AgentiaClient, template: TemplateListItem): Promise<TemplateInspection> {
  try {
    const detail = await client.getDetail(template.id)
    return {template, format: 'v2', detail, saveBlockers: findSaveBlockers(detail)}
  } catch (error) {
    if (!(error instanceof TemplateNotFoundError)) throw error
    try {
      await client.getGraph(template.id)
    } catch {
      throw error // neither representation exists: genuinely not found
    }
    return {template, format: 'legacy', saveBlockers: []}
  }
}

/**
 * The v2 detail of a listed template. A legacy template (DAT-004 on `get-detail`, but `get` works)
 * raises LegacyTemplateError with the `convert-old` hint instead of a misleading "not found".
 */
export async function fetchDetail(client: AgentiaClient, template: TemplateListItem): Promise<TemplateDetail> {
  try {
    return await client.getDetail(template.id)
  } catch (error) {
    if (!(error instanceof TemplateNotFoundError)) throw error
    try {
      await client.getGraph(template.id)
    } catch {
      throw error
    }
    throw new LegacyTemplateError(template.name, template.id)
  }
}

/**
 * Finds required fields that are null or empty. Phase 0 proved `save-detail` rejects them with
 * 422 MDW-003 "(missing)", because null and [] are stripped before Copado validates the body.
 */
export function findSaveBlockers(detail: TemplateDetail): SaveBlocker[] {
  const blockers: SaveBlocker[] = []
  detail.details.forEach((d, i) => {
    const object = d.table
    if (!d.filters || d.filters.length === 0) {
      blockers.push({
        path: `details[${i}].filters`,
        object,
        field: 'filters',
        fix: `Add a main object filter for ${object} (Main Object Filter tab).`,
      })
    }
    if (!d.rawFilters || d.rawFilters.length === 0) {
      blockers.push({
        path: `details[${i}].rawFilters`,
        object,
        field: 'rawFilters',
        fix: `Add a main object filter for ${object} (Main Object Filter tab).`,
      })
    }
    if (d.limit === null || d.limit === undefined) {
      blockers.push({
        path: `details[${i}].limit`,
        object,
        field: 'limit',
        fix: `Set "Max. Record Limit" for ${object} (Main Object Filter tab).`,
      })
    }
  })
  return blockers
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}
