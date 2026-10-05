/**
 * Semantic diff of two template states (detail document + extras), by JSON path.
 *
 * - Keyed collections (objects by templateId, columns by name, filter rows by order, advanced filters by
 *   uuid, formulas by id; configurable) are matched by key, so reordering shows as `moved`, not as a
 *   remove + add.
 * - Every change carries an `entity` describing what it is about (object, field, filter, …), so renderers
 *   can speak the template's language. Anything not recognised still produces a generic path-level change:
 *   nothing is ever hidden.
 * - Field selection (`columns[].isSelected` false → true) is reported as `added`/`removed`: in a v2 document
 *   every described field is present, and "adding a field" to a template means selecting it.
 */
import {DEFAULT_KEYS, childPath, isPlainObject, type KeyMap} from './canonical.js'

export type ChangeType = 'added' | 'removed' | 'changed' | 'moved'

export type EntityKind = 'template' | 'object' | 'field' | 'filter' | 'filterText' | 'relation' | 'advancedFilter' | 'formula' | 'value'

export interface Entity {
  kind: EntityKind
  /** sObject the change belongs to (e.g. `Account`), when known. */
  object?: string
  /** Field API name, filter text, formula/filter name, … */
  name?: string
  /** For relations: `parent` or `child`. */
  role?: 'parent' | 'child'
}

export interface Change {
  type: ChangeType
  /** Unambiguous path, e.g. `detail.details[templateId=a0U…].columns[name=Fax].isSelected`. */
  path: string
  /** Path pattern used for keys/ignore, e.g. `details[].columns[].isSelected`. */
  schemaPath: string
  entity: Entity
  /** For changes inside an entity: the property that changed (e.g. `externalId`). */
  property?: string
  before?: unknown
  after?: unknown
  /** For `moved`: position before/after. */
  from?: number
  to?: number
}

export interface TemplateState {
  detail: unknown
  extras?: unknown
}

export interface DiffOptions {
  /** Natural keys for detail-document collections (defaults to DEFAULT_KEYS). */
  keys?: KeyMap
  /** Schema paths (or prefixes) to leave out of the result, e.g. `details[].columns[].anonymizerType`. */
  ignore?: string[]
}

/** Keys for the extras document. */
const EXTRAS_KEYS: KeyMap = {
  advancedFilters: 'uuid',
}

export interface ChangeSummary {
  added: number
  removed: number
  changed: number
  moved: number
}

/** Diffs detail and extras of two template states. */
export function diffTemplates(before: TemplateState, after: TemplateState, options: DiffOptions = {}): Change[] {
  const keys = options.keys ?? DEFAULT_KEYS
  const changes = [
    ...diffDocument(before.detail, after.detail, {keys, root: 'detail'}),
    ...diffDocument(before.extras ?? {}, after.extras ?? {}, {keys: EXTRAS_KEYS, root: 'extras', formulas: true}),
  ]
  const ignore = options.ignore ?? []
  return ignore.length === 0
    ? changes
    : changes.filter((c) => !ignore.some((p) => c.schemaPath === p || c.schemaPath.startsWith(`${p}.`) || c.schemaPath.startsWith(`${p}[`)))
}

interface WalkOptions {
  keys: KeyMap
  root: 'detail' | 'extras'
  formulas?: boolean
}

interface Context {
  object?: string
  entity?: Entity
}

export function diffDocument(before: unknown, after: unknown, options: WalkOptions): Change[] {
  const changes: Change[] = []
  walk(before, after, options.root, '', {})
  return changes

  function keyFor(schemaPath: string): string | undefined {
    if (options.keys[schemaPath]) return options.keys[schemaPath]
    // extras: recordMatchingFormulas.<Object> arrays are keyed by id
    if (options.formulas && /^recordMatchingFormulas\.[^.[\]]+$/.test(schemaPath)) return 'id'
    return undefined
  }

  function walk(a: unknown, b: unknown, path: string, schemaPath: string, ctx: Context): void {
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const k of union(Object.keys(a), Object.keys(b))) {
        const p = `${path}.${k}`
        const sp = childPath(schemaPath, k)
        const child = contextFor(sp, ctx, b, a)
        // null ≡ absent: Copado's save path strips null-valued keys
        const inA = k in a && a[k] !== null
        const inB = k in b && b[k] !== null
        if (!inA && !inB) continue
        if (!inA && !(k in a)) push('added', p, sp, child, k, undefined, b[k])
        else if (!inB && !(k in b)) push('removed', p, sp, child, k, a[k], undefined)
        else walk(a[k], b[k], p, sp, child)
      }
      return
    }

    const key = keyFor(schemaPath)
    if (key && Array.isArray(a) && Array.isArray(b) && [...a, ...b].every((i) => isPlainObject(i) && key in i)) {
      diffKeyed(a as Record<string, unknown>[], b as Record<string, unknown>[], key, path, schemaPath, ctx)
      return
    }

    if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every((i) => !isPlainObject(i) && !Array.isArray(i))) {
      diffPrimitiveList(a, b, path, schemaPath, ctx)
      return
    }

    if (JSON.stringify(a) !== JSON.stringify(b)) push('changed', path, schemaPath, ctx, lastSegment(schemaPath), a, b)
  }

  function diffKeyed(
    a: Record<string, unknown>[],
    b: Record<string, unknown>[],
    key: string,
    path: string,
    schemaPath: string,
    ctx: Context,
  ): void {
    const id = (item: Record<string, unknown>) => String(item[key])
    const ia = new Map(a.map((item, i) => [id(item), {item, i}]))
    const ib = new Map(b.map((item, i) => [id(item), {item, i}]))
    const elementSchema = `${schemaPath}[]`

    for (const [k, {item}] of ia) {
      if (!ib.has(k))
        push('removed', `${path}[${key}=${k}]`, elementSchema, contextFor(elementSchema, ctx, item), undefined, item, undefined)
    }
    for (const [k, {item}] of ib) {
      const elementPath = `${path}[${key}=${k}]`
      const elementCtx = contextFor(elementSchema, ctx, item, ia.get(k)?.item)
      if (!ia.has(k)) push('added', elementPath, elementSchema, elementCtx, undefined, undefined, item)
      else walk(ia.get(k)!.item, item, elementPath, elementSchema, elementCtx)
    }

    // Moves: common elements whose relative order changed (outside the longest common subsequence).
    const commonA = a.map(id).filter((k) => ib.has(k))
    const commonB = b.map(id).filter((k) => ia.has(k))
    const stable = new Set(lcs(commonA, commonB))
    for (const k of commonB) {
      if (stable.has(k)) continue
      const {item, i} = ib.get(k)!
      changes.push({
        type: 'moved',
        path: `${path}[${key}=${k}]`,
        schemaPath: elementSchema,
        entity: contextFor(elementSchema, ctx, item).entity ?? {kind: 'value', object: ctx.object},
        from: ia.get(k)!.i,
        to: i,
      })
    }
  }

  function diffPrimitiveList(a: unknown[], b: unknown[], path: string, schemaPath: string, ctx: Context): void {
    const sa = a.map((v) => JSON.stringify(v))
    const sb = b.map((v) => JSON.stringify(v))
    const entity: Entity =
      schemaPath === 'details[].filters' ? {kind: 'filterText', object: ctx.object} : (ctx.entity ?? {kind: 'value', object: ctx.object})
    sa.forEach((v, i) => {
      if (!sb.includes(v))
        changes.push({
          type: 'removed',
          path: `${path}[${i}]`,
          schemaPath: `${schemaPath}[]`,
          entity: {...entity, name: String(a[i])},
          before: a[i],
        })
    })
    sb.forEach((v, i) => {
      if (!sa.includes(v))
        changes.push({
          type: 'added',
          path: `${path}[${i}]`,
          schemaPath: `${schemaPath}[]`,
          entity: {...entity, name: String(b[i])},
          after: b[i],
        })
    })
    const commonA = sa.filter((v) => sb.includes(v))
    const commonB = sb.filter((v) => sa.includes(v))
    const stable = new Set(lcs(commonA, commonB))
    commonB.forEach((v) => {
      if (stable.has(v)) return
      changes.push({
        type: 'moved',
        path: `${path}[${sb.indexOf(v)}]`,
        schemaPath: `${schemaPath}[]`,
        entity: {...entity, name: String(JSON.parse(v))},
        from: sa.indexOf(v),
        to: sb.indexOf(v),
      })
    })
  }

  function push(
    type: ChangeType,
    path: string,
    schemaPath: string,
    ctx: Context,
    property: string | undefined,
    before: unknown,
    after: unknown,
  ): void {
    let t = type
    // Selecting/deselecting a field is how fields are added to / removed from a v2 template.
    if (schemaPath === 'details[].columns[].isSelected' && type === 'changed') {
      if (before !== true && after === true) t = 'added'
      else if (before === true && after !== true) t = 'removed'
    }
    const entity = ctx.entity ?? {kind: 'value' as const, object: ctx.object}
    const isWholeEntity = property === undefined
    changes.push({
      type: t,
      path,
      schemaPath,
      entity,
      ...(isWholeEntity ? {} : {property}),
      ...(before === undefined ? {} : {before}),
      ...(after === undefined ? {} : {after}),
    })
  }

  /** Works out which entity a schema path belongs to, carrying the object name down. */
  function contextFor(schemaPath: string, parent: Context, item?: unknown, other?: unknown): Context {
    const rec = (isPlainObject(item) ? item : isPlainObject(other) ? other : {}) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? undefined : String(v))
    if (options.root === 'detail') {
      if (schemaPath === 'details[]') {
        const object = str(rec.table) ?? parent.object
        return {object, entity: {kind: 'object', object}}
      }
      if (schemaPath === 'details[].columns[]')
        return {object: parent.object, entity: {kind: 'field', object: parent.object, name: str(rec.name)}}
      if (schemaPath === 'details[].rawFilters[]') {
        return {object: parent.object, entity: {kind: 'filter', object: parent.object, name: str(rec.finalValue) ?? `#${str(rec.order)}`}}
      }
      if (schemaPath === 'details[].parentTemplates[]' || schemaPath === 'details[].childTemplates[]') {
        const name = str(rec.templateName) ?? str(rec.table) ?? str(rec.apiName) ?? str(rec.templateId)
        return {
          object: parent.object,
          entity: {kind: 'relation', object: parent.object, name, role: schemaPath.includes('parent') ? 'parent' : 'child'},
        }
      }
      if (schemaPath.startsWith('details[]'))
        return {object: parent.object, entity: parent.entity ?? {kind: 'object', object: parent.object}}
      if (!schemaPath.includes('.') && !schemaPath.includes('[')) return {entity: {kind: 'template'}}
      return parent
    }
    // extras
    if (schemaPath === 'advancedFilters[]') return {entity: {kind: 'advancedFilter', name: str(rec.filterName) ?? str(rec.uuid)}}
    const formula = /^recordMatchingFormulas\.([^.[\]]+)/.exec(schemaPath)
    if (formula) {
      const object = formula[1]
      if (schemaPath.endsWith('[]')) return {object, entity: {kind: 'formula', object, name: str(rec.name) ?? str(rec.id)}}
      return {object, entity: parent.entity ?? {kind: 'formula', object}}
    }
    return parent
  }
}

export function summarise(changes: Change[]): ChangeSummary {
  const s: ChangeSummary = {added: 0, removed: 0, changed: 0, moved: 0}
  for (const c of changes) s[c.type]++
  return s
}

export function formatSummary(s: ChangeSummary): string {
  const parts = [`${s.added} added`, `${s.removed} removed`, `${s.changed} changed`]
  if (s.moved > 0) parts.push(`${s.moved} moved`)
  return parts.join(' · ')
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])]
}

function lastSegment(schemaPath: string): string | undefined {
  const seg = schemaPath.split('.').pop()
  return seg && !seg.endsWith('[]') ? seg : undefined
}

/** Longest common subsequence of two key sequences (O(n·m); template collections are small). */
export function lcs(a: string[], b: string[]): string[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({length: n + 1}, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(a[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return out
}
