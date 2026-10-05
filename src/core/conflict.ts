/**
 * Three-way comparison for a blocked edit: what *they* changed (base → live) and what *you* changed
 * (base → your document), and which of your changes collide with theirs (same path, or one inside an
 * element the other added/removed, with different outcomes).
 */
import type {KeyMap} from './canonical.js'
import {describeChanges, type Statement} from './describe.js'
import {diffTemplates, type Change} from './differ.js'

export interface Conflict {
  path: string
  theirs: string
  yours: string
}

export interface ThreeWay {
  theirs: Statement[]
  yours: Statement[]
  conflicts: Conflict[]
  /** True when no path was changed by both sides (an automatic merge would be possible). */
  disjoint: boolean
}

export function threeWay(base: unknown, theirs: unknown, yours: unknown, keys?: KeyMap): ThreeWay {
  const theirChanges = diffTemplates({detail: base}, {detail: theirs}, {keys})
  const yourChanges = diffTemplates({detail: base}, {detail: yours}, {keys})
  const theirStatements = describeChanges(theirChanges)
  const yourStatements = describeChanges(yourChanges)

  const conflicts: Conflict[] = []
  for (const y of yourChanges) {
    for (const t of theirChanges) {
      if (!overlaps(y.path, t.path)) continue
      if (y.path === t.path && JSON.stringify(y.after) === JSON.stringify(t.after) && y.type === t.type) continue // same change on both sides
      conflicts.push({
        path: y.path.length <= t.path.length ? y.path : t.path,
        theirs: statementFor(theirStatements, t),
        yours: statementFor(yourStatements, y),
      })
    }
  }
  return {theirs: theirStatements, yours: yourStatements, conflicts: dedupe(conflicts), disjoint: conflicts.length === 0}
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || a.startsWith(`${b}[`) || b.startsWith(`${a}.`) || b.startsWith(`${a}[`)
}

function statementFor(statements: Statement[], change: Change): string {
  const s = statements.find((st) => st.changes.includes(change))
  return s ? `${s.sign} ${s.text}` : change.path
}

function dedupe(conflicts: Conflict[]): Conflict[] {
  const seen = new Set<string>()
  return conflicts.filter((c) => {
    const k = `${c.theirs}|${c.yours}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
