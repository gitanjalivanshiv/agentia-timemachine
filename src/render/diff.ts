import type {ThreeWay} from '../core/conflict.js'
import type {Statement, StatementSummary} from '../core/describe.js'
import {formatStatementSummary} from '../core/describe.js'
import {style} from './style.js'

export interface DiffHeader {
  title: string
  from: string
  to: string
}

const COLOUR = {'+': style.green, '-': style.red, '~': style.yellow, '↕': style.dim}

/** Terminal rendering: a header, one coloured line per statement, and the summary line. */
export function renderText(statements: Statement[], summary: StatementSummary, header: DiffHeader): string {
  const lines = [`${style.bold(header.title)} ${style.dim(`${header.from} → ${header.to}`)}`, '']
  if (statements.length === 0) {
    lines.push(style.dim('No differences.'))
    return lines.join('\n')
  }
  for (const s of statements) lines.push(COLOUR[s.sign](`${s.sign} ${s.text}`))
  lines.push('', style.bold(formatStatementSummary(summary)))
  return lines.join('\n')
}

/**
 * Markdown for pull-request comments. Statements go in a ```diff block so GitHub colours added and
 * removed lines; changes (`~`) and moves (`↕`) are prefixed with `!` and `#`, which the diff
 * highlighter shows as neutral or comment lines.
 */
export function renderMarkdown(statements: Statement[], summary: StatementSummary, header: DiffHeader): string {
  const lines = [`#### ${escapeMd(header.title)}`, '', `\`${header.from}\` → \`${header.to}\` · **${formatStatementSummary(summary)}**`, '']
  if (statements.length === 0) {
    lines.push('_No differences._')
    return lines.join('\n')
  }
  lines.push('```diff')
  for (const s of statements) {
    const prefix = s.sign === '~' ? '!' : s.sign === '↕' ? '#' : s.sign
    lines.push(`${prefix} ${s.text.replace(/```/g, "'''")}`)
  }
  lines.push('```')
  return lines.join('\n')
}

function escapeMd(text: string): string {
  return text.replace(/([\\`*_[\]#|<>])/g, '\\$1')
}

/** The view shown when an edit is blocked: their changes, your changes, and where they collide. */
export function renderThreeWay(name: string, view: ThreeWay, keptFile?: string): string {
  const section = (title: string, statements: Statement[]) => [
    `  ${style.bold(title)}`,
    ...(statements.length > 0 ? statements.map((s) => `    ${COLOUR[s.sign](`${s.sign} ${s.text}`)}`) : [style.dim('    (none)')]),
  ]
  const lines = [
    `${style.red('✋ Blocked:')} ${style.bold(name)} was changed in Copado after your edit started. Nothing was saved.`,
    '',
    ...section('Their changes (base → live now)', view.theirs),
    '',
    ...section('Your changes (base → yours)', view.yours),
    '',
  ]
  if (view.conflicts.length > 0) {
    lines.push(`  ${style.bold(style.red('Conflicts'))}`)
    for (const c of view.conflicts) lines.push(`    ${style.red('✖')} theirs ${c.theirs}`, `      yours  ${c.yours}`)
  } else {
    lines.push(`  ${style.green('No overlapping changes:')} your edits can be re-applied on top of the current version (--merge).`)
  }
  if (keptFile) lines.push('', `  Your edited document is kept at ${style.cyan(keptFile)}`)
  return lines.join('\n')
}
