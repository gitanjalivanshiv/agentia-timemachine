/**
 * Canonical JSON + hashing for template documents.
 *
 * Two forms:
 * - `toStorageJson`: what we write to `.timemachine/…/template.json`. Object keys are sorted (clean git
 *   diffs) but array order is kept exactly as Copado returned it, so `restore` saves back a faithful
 *   document.
 * - `canonicalize` / `hashDocument`: the identity used for change detection and concurrency checks.
 *   Keys are sorted and keyed collections (columns by name, filter rows by order, …) are sorted by
 *   their key, so a mere reordering is not a change. Object keys whose value is `null` are dropped:
 *   Copado's save path strips nulls (e.g. inside filter rows), so `null` and "absent" must be equal or a
 *   restored document would never verify.
 */
import {createHash} from 'node:crypto'

/**
 * Natural keys for arrays of objects, by schema path. A schema path joins object keys with `.` and
 * writes array elements as `[]`, e.g. `details[].columns`. Configurable per project.
 */
export type KeyMap = Record<string, string>

export const DEFAULT_KEYS: KeyMap = {
  details: 'templateId',
  'details[].columns': 'name',
  'details[].rawFilters': 'order',
  'details[].parentTemplates': 'templateId',
  'details[].childTemplates': 'templateId',
}

export function childPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key
}

/** Returns a deep copy with sorted object keys and keyed arrays sorted by their natural key. */
export function canonicalize(value: unknown, keys: KeyMap = DEFAULT_KEYS, schemaPath = ''): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalize(v, keys, `${schemaPath}[]`))
    const key = keys[schemaPath]
    if (key && items.every((i) => isPlainObject(i) && key in i)) {
      return [...items].sort((a, b) => compareKeys((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
    }
    return items
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort()) {
      if (value[k] === null) continue
      out[k] = canonicalize(value[k], keys, childPath(schemaPath, k))
    }
    return out
  }
  return value
}

/** Sorted keys, original array order, 2-space indent, trailing newline. */
export function toStorageJson(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`
}

/** SHA-256 (hex) of the canonical form. */
export function hashDocument(value: unknown, keys: KeyMap = DEFAULT_KEYS): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value, keys)))
    .digest('hex')
}

export function shortHash(hash: string): string {
  return hash.slice(0, 12)
}

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k])
    return out
  }
  return value
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareKeys(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'en')
}
