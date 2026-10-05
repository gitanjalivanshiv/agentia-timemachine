/**
 * Three-way merge for blocked edits: re-applies *your* changes (base → yours) on top of *theirs* (live).
 * Only used when the three-way view has no conflicts; any path that cannot be applied cleanly aborts the
 * merge rather than guessing.
 */
import {TimemachineError, ExitCode} from '../agentia/errors.js'
import {isPlainObject} from './canonical.js'
import type {Change} from './differ.js'

type Segment = {kind: 'prop'; name: string} | {kind: 'key'; key: string; value: string} | {kind: 'index'; index: number}

export class MergeError extends TimemachineError {
  constructor(path: string, problem: string) {
    super('CONFLICT', `Could not merge automatically at ${path}: ${problem}. Nothing was saved.`, ExitCode.Conflict, {
      hint: 'Start the edit again from the current version (`edit --abort`, then `edit --start`) and re-apply your changes.',
    })
  }
}

/** Parses `detail.details[templateId=x].columns[name=Fax].isSelected` into segments (without the root). */
export function parsePath(path: string): Segment[] {
  const segments: Segment[] = []
  for (const m of path.matchAll(/\[([^\]=]+)=([^\]]*)\]|\[(\d+)\]|([^.[\]]+)/g)) {
    if (m[1] !== undefined) segments.push({kind: 'key', key: m[1], value: m[2]})
    else if (m[3] !== undefined) segments.push({kind: 'index', index: Number(m[3])})
    else segments.push({kind: 'prop', name: m[4]})
  }
  return segments.slice(1) // drop "detail" / "extras"
}

/** Returns a copy of `doc` with `changes` (computed against another base) applied. */
export function applyChanges<T>(doc: T, changes: Change[]): T {
  const out = structuredClone(doc) as unknown
  for (const change of changes) {
    if (change.type === 'moved') continue // order of keyed collections is not meaningful
    const segments = parsePath(change.path)
    const last = segments.pop()!
    let node: unknown = out
    for (const seg of segments) node = step(node, seg, change.path)

    if (last.kind === 'prop') {
      if (!isPlainObject(node)) throw new MergeError(change.path, 'parent is not an object')
      if (change.type === 'removed') delete node[last.name]
      else node[last.name] = structuredClone(change.after)
    } else if (last.kind === 'key') {
      if (!Array.isArray(node)) throw new MergeError(change.path, 'parent is not a list')
      const index = node.findIndex((i) => isPlainObject(i) && String(i[last.key]) === last.value)
      if (change.type === 'added') {
        if (index >= 0) throw new MergeError(change.path, 'it was also added by someone else')
        node.push(structuredClone(change.after))
      } else if (change.type === 'removed') {
        if (index < 0) throw new MergeError(change.path, 'it was already removed')
        node.splice(index, 1)
      } else throw new MergeError(change.path, 'unexpected change on a list element')
    } else {
      if (!Array.isArray(node)) throw new MergeError(change.path, 'parent is not a list')
      // primitive lists (filter text): add / remove by value
      if (change.type === 'added' && !node.some((v) => JSON.stringify(v) === JSON.stringify(change.after))) node.push(change.after)
      if (change.type === 'removed') {
        const i = node.findIndex((v) => JSON.stringify(v) === JSON.stringify(change.before))
        if (i >= 0) node.splice(i, 1)
      }
    }
  }
  return out as T
}

function step(node: unknown, seg: Segment, path: string): unknown {
  if (seg.kind === 'prop') {
    if (!isPlainObject(node) || !(seg.name in node)) throw new MergeError(path, `"${seg.name}" no longer exists`)
    return node[seg.name]
  }
  if (!Array.isArray(node)) throw new MergeError(path, 'expected a list')
  if (seg.kind === 'index') return node[seg.index]
  const found = node.find((i) => isPlainObject(i) && String(i[seg.key]) === seg.value)
  if (found === undefined) throw new MergeError(path, `${seg.key}=${seg.value} no longer exists`)
  return found
}
