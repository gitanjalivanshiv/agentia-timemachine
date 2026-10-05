/**
 * Turns raw path-level changes into human statements in the template's language:
 *
 *   + field Region__c added to Account
 *   ~ filter on Account: Type = 'Customer' → Type IN ('Customer','Partner')
 *   - relation Contact → Account removed
 *
 * Related changes are grouped into one statement (all properties of one filter row; the derived
 * filter text). The summary counts statements, so "3 added" means three things a person would name.
 * Every raw change belongs to exactly one statement, so nothing is hidden.
 */
import type {Change, ChangeType, Entity} from './differ.js'

export interface Statement {
  type: ChangeType
  /** `+` added · `-` removed · `~` changed · `↕` moved */
  sign: '+' | '-' | '~' | '↕'
  text: string
  entity: Entity
  /** The raw changes this statement covers. */
  changes: Change[]
}

export interface StatementSummary {
  added: number
  removed: number
  changed: number
  moved: number
}

const SIGN: Record<ChangeType, Statement['sign']> = {added: '+', removed: '-', changed: '~', moved: '↕'}

export function describeChanges(changes: Change[]): Statement[] {
  const statements: Statement[] = []
  const used = new Set<Change>()
  const take = (list: Change[]) => list.forEach((c) => used.add(c))

  // 1. Filter rows: one statement per row, built from finalValue when it changed.
  const filterRows = groupBy(
    changes.filter((c) => c.entity.kind === 'filter'),
    (c) => entityPath(c.path, 'rawFilters'),
  )
  for (const group of filterRows.values()) {
    take(group)
    const whole = group.find((c) => c.property === undefined && c.type !== 'moved')
    const object = group[0].entity.object ?? '?'
    if (whole) {
      const text = finalValue(whole.type === 'added' ? whole.after : whole.before) ?? whole.entity.name ?? '(filter)'
      statements.push(
        make(whole.type, `filter on ${object}: ${text}${whole.type === 'added' ? ' added' : ' removed'}`, whole.entity, group),
      )
      continue
    }
    const moved = group.filter((c) => c.type === 'moved')
    const edits = group.filter((c) => c.type !== 'moved')
    if (edits.length > 0) {
      const fv = edits.find((c) => c.property === 'finalValue')
      const text = fv
        ? `filter on ${object}: ${fmt(fv.before)} → ${fmt(fv.after)}`
        : `filter on ${object} (${group[0].entity.name}): ${edits.map((c) => `${c.property} ${fmt(c.before)} → ${fmt(c.after)}`).join(', ')}`
      statements.push(make('changed', text, group[0].entity, edits))
    }
    for (const m of moved)
      statements.push(make('moved', `filter on ${object} reordered: ${m.entity.name} (${m.from! + 1} → ${m.to! + 1})`, m.entity, [m]))
  }

  // 2. Derived filter text: covered by the filter rows of the same object when there are any.
  const objectsWithRowChanges = new Set([...filterRows.values()].map((g) => g[0].entity.object))
  for (const c of changes.filter((x) => x.entity.kind === 'filterText')) {
    take([c])
    if (objectsWithRowChanges.has(c.entity.object)) {
      attach(statements, c)
      continue
    }
    if (c.type === 'moved') statements.push(make('moved', `filter text on ${c.entity.object} reordered: ${c.entity.name}`, c.entity, [c]))
    else statements.push(make(c.type, `filter on ${c.entity.object}: ${c.entity.name} ${c.type}`, c.entity, [c]))
  }

  // 3. Fields: one statement per field and kind of change.
  const fields = groupBy(
    changes.filter((c) => c.entity.kind === 'field' && !used.has(c)),
    (c) => entityPath(c.path, 'columns'),
  )
  const fieldMoves = new Map<string, Change[]>()
  for (const group of fields.values()) {
    take(group)
    const {object = '?', name = '?'} = group[0].entity
    for (const c of group) {
      if (c.type === 'moved') {
        const list = fieldMoves.get(object) ?? []
        list.push(c)
        fieldMoves.set(object, list)
      }
    }
    const whole = group.find((c) => c.property === undefined && c.type !== 'moved')
    if (whole) {
      const value = (whole.type === 'added' ? whole.after : whole.before) as {isSelected?: boolean} | undefined
      const selected = value?.isSelected === true
      const text =
        whole.type === 'added'
          ? selected
            ? `field ${name} added to ${object}`
            : `field ${name} now available on ${object} (not selected)`
          : selected
            ? `field ${name} removed from ${object}`
            : `field ${name} no longer available on ${object} (was not selected)`
      statements.push(
        make(
          whole.type,
          text,
          group[0].entity,
          group.filter((c) => c.type !== 'moved'),
        ),
      )
      continue
    }
    const selection = group.find((c) => c.property === 'isSelected' && c.type !== 'changed' && c.type !== 'moved')
    if (selection) {
      statements.push(
        make(
          selection.type,
          selection.type === 'added' ? `field ${name} added to ${object}` : `field ${name} removed from ${object}`,
          group[0].entity,
          [selection],
        ),
      )
    }
    const edits = group.filter((c) => c !== selection && c.type !== 'moved')
    if (edits.length > 0) {
      statements.push(
        make('changed', `field ${name} on ${object}: ${edits.map((e) => describeProperty(e)).join(', ')}`, group[0].entity, edits),
      )
    }
  }
  for (const [object, moves] of fieldMoves) {
    const text =
      moves.length === 1
        ? `field ${moves[0].entity.name} moved in ${object} (${moves[0].from! + 1} → ${moves[0].to! + 1})`
        : `${moves.length} fields reordered in ${object}`
    statements.push(make('moved', text, {kind: 'field', object}, moves))
  }

  // 4. Everything else, one statement per change.
  for (const c of changes) {
    if (used.has(c)) continue
    used.add(c)
    statements.push(make(c.type, describeOther(c), c.entity, [c]))
  }

  return order(statements)
}

export function summariseStatements(statements: Statement[]): StatementSummary {
  const s: StatementSummary = {added: 0, removed: 0, changed: 0, moved: 0}
  for (const st of statements) s[st.type]++
  return s
}

export function formatStatementSummary(s: StatementSummary): string {
  const parts = [`${s.added} added`, `${s.removed} removed`, `${s.changed} changed`]
  if (s.moved > 0) parts.push(`${s.moved} moved`)
  return parts.join(' · ')
}

// ---------- helpers ----------

function describeOther(c: Change): string {
  const {entity} = c
  const verb = c.type === 'moved' ? `moved (${c.from! + 1} → ${c.to! + 1})` : c.type
  switch (entity.kind) {
    case 'object': {
      if (c.property === undefined && c.type !== 'moved') {
        const v = (c.type === 'added' ? c.after : c.before) as {columns?: {isSelected?: boolean}[]} | undefined
        const n = v?.columns?.filter((x) => x.isSelected).length
        return `object ${entity.object} ${c.type}${n !== undefined ? ` (${n} field${n === 1 ? '' : 's'} selected)` : ''}`
      }
      if (c.type === 'moved') return `object ${entity.object} ${verb}`
      return `${entity.object}: ${describeProperty(c, relativeToObject(c.path))}`
    }
    case 'relation': {
      const arrow = entity.role === 'child' ? `${entity.name} → ${entity.object}` : `${entity.object} → ${entity.name}`
      if (c.property === undefined) return `relation ${arrow} ${verb}`
      return `relation ${arrow}: ${describeProperty(c)}`
    }
    case 'advancedFilter':
      if (c.property === undefined) return `advanced filter ${entity.name} ${verb}`
      return `advanced filter ${entity.name}: ${describeProperty(c)}`
    case 'formula':
      if (c.property === undefined && c.type !== 'moved')
        return `matching formula ${entity.name ?? ''} on ${entity.object} ${c.type}`.replace('  ', ' ')
      return `matching formula ${entity.name ?? ''} on ${entity.object}: ${describeProperty(c)}`.replace('  ', ' ')
    case 'template':
      return `template: ${describeProperty(c, c.path.replace(/^detail\./, ''))}`
    default:
      return `${c.path}: ${c.type === 'added' ? `added ${fmt(c.after)}` : c.type === 'removed' ? `removed (was ${fmt(c.before)})` : `${fmt(c.before)} → ${fmt(c.after)}`}`
  }
}

function describeProperty(c: Change, label = c.property ?? lastPathSegment(c.path)): string {
  if (c.type === 'added') return `${label} added (${fmt(c.after)})`
  if (c.type === 'removed') return `${label} removed (was ${fmt(c.before)})`
  return `${label} ${fmt(c.before)} → ${fmt(c.after)}`
}

/** `detail.details[templateId=x].externalIdGeneration.fields` → `externalIdGeneration.fields` */
function relativeToObject(path: string): string {
  return path.replace(/^detail\.details\[[^\]]+\]\.?/, '') || path
}

function lastPathSegment(path: string): string {
  return path.split('.').pop() ?? path
}

/** Path up to and including the element of `collection`, e.g. `…rawFilters[order=1]`. */
function entityPath(path: string, collection: string): string {
  const match = new RegExp(`^(.*?\\.${collection}\\[[^\\]]+\\])`).exec(path)
  return match ? match[1] : path
}

function finalValue(v: unknown): string | undefined {
  return v && typeof v === 'object' && typeof (v as {finalValue?: unknown}).finalValue === 'string'
    ? (v as {finalValue: string}).finalValue
    : undefined
}

/** Short, readable value rendering. */
export function fmt(v: unknown): string {
  if (v === undefined) return '∅'
  if (v === null) return '(not set)'
  if (typeof v === 'string') return v === '' ? '""' : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const json = JSON.stringify(v)
  return json.length > 80 ? `${json.slice(0, 77)}…` : json
}

function make(type: ChangeType, text: string, entity: Entity, changes: Change[]): Statement {
  return {type, sign: SIGN[type], text, entity, changes}
}

/** Adds a change to the statement for the same object's filter rows (derived text). */
function attach(statements: Statement[], c: Change): void {
  const target = statements.find((s) => s.entity.kind === 'filter' && s.entity.object === c.entity.object)
  if (target) target.changes.push(c)
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = map.get(k) ?? []
    list.push(item)
    map.set(k, list)
  }
  return map
}

const KIND_ORDER: Entity['kind'][] = [
  'template',
  'object',
  'field',
  'filter',
  'filterText',
  'relation',
  'advancedFilter',
  'formula',
  'value',
]
const TYPE_ORDER: ChangeType[] = ['added', 'removed', 'changed', 'moved']

/** Stable presentation order: by object, then kind, then type, then text. */
function order(statements: Statement[]): Statement[] {
  return [...statements].sort(
    (a, b) =>
      (a.entity.object ?? '').localeCompare(b.entity.object ?? '') ||
      KIND_ORDER.indexOf(a.entity.kind) - KIND_ORDER.indexOf(b.entity.kind) ||
      TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
      a.text.localeCompare(b.text),
  )
}
