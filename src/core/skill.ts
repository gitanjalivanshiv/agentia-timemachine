/**
 * Installs the bundled Agent Skill (skills/timemachine) into a project for a coding agent, using the same
 * folders as `agentia setup skills create`: .agents/skills, .claude/skills, .cursor/skills.
 * Files carry a managed marker; existing unmanaged files are only replaced with --force.
 */
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

export const SKILL_NAME = 'timemachine'
export const MANAGED_MARKER = '<!-- timemachine managed skill file: agentia timemachine skill install -->'
export const TARGETS = {agents: '.agents/skills', claude: '.claude/skills', cursor: '.cursor/skills'} as const
export type SkillTarget = keyof typeof TARGETS

const AGENTS_START = '<!-- timemachine:managed:start -->'
const AGENTS_END = '<!-- timemachine:managed:end -->'

export interface InstalledFile {
  path: string
  action: 'created' | 'updated' | 'unchanged'
}

export interface InstallResult {
  target: SkillTarget
  dir: string
  files: InstalledFile[]
}

/** The skill folder shipped with the plugin (works from src/ and dist/). */
export function bundledSkillDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'skills', SKILL_NAME, 'SKILL.md')
    if (fs.existsSync(candidate)) return path.dirname(candidate)
    dir = path.dirname(dir)
  }
  throw new Error('The bundled timemachine skill was not found. Reinstall the plugin.')
}

export class UnmanagedSkillError extends Error {
  constructor(readonly file: string) {
    super(`${file} exists and was not installed by timemachine.`)
  }
}

export function installSkill(root: string, target: SkillTarget, force = false): InstallResult {
  const source = bundledSkillDir()
  const dir = path.join(root, TARGETS[target], SKILL_NAME)
  const files = listFiles(source)
  // Check everything before writing anything.
  for (const rel of files) {
    const dest = path.join(dir, rel)
    if (fs.existsSync(dest) && !force && !fs.readFileSync(dest, 'utf8').includes(MANAGED_MARKER)) throw new UnmanagedSkillError(dest)
  }
  const installed: InstalledFile[] = []
  for (const rel of files) {
    const dest = path.join(dir, rel)
    const content = fs.readFileSync(path.join(source, rel), 'utf8')
    const before = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : undefined
    if (before === content) {
      installed.push({path: dest, action: 'unchanged'})
      continue
    }
    fs.mkdirSync(path.dirname(dest), {recursive: true})
    fs.writeFileSync(dest, content)
    installed.push({path: dest, action: before === undefined ? 'created' : 'updated'})
  }
  return {target, dir, files: installed}
}

/**
 * Adds (or refreshes) a short managed block in AGENTS.md pointing agents at the skill. Agents that read
 * AGENTS.md (Codex, Cursor, Copado's own setup) then find it without being told.
 */
export function updateAgentsMd(root: string, targets: SkillTarget[]): InstalledFile | undefined {
  const paths = targets.filter((t) => t !== 'claude').map((t) => `${TARGETS[t]}/${SKILL_NAME}/SKILL.md`)
  if (paths.length === 0) return undefined
  const file = path.join(root, 'AGENTS.md')
  const block = [
    AGENTS_START,
    '## Copado data templates: use Time Machine',
    '',
    `Before changing, reviewing or restoring a Copado Release Data Template, load the \`${SKILL_NAME}\` skill (${paths.map((p) => `\`${p}\``).join(', ')}).`,
    'Change templates with `agentia timemachine edit --file`, never with `agentia cicd data template save-detail`.',
    AGENTS_END,
  ].join('\n')
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined
  let after: string
  if (before === undefined) after = `${block}\n`
  else if (before.includes(AGENTS_START) && before.includes(AGENTS_END)) {
    after = before.replace(new RegExp(`${escape(AGENTS_START)}[\\s\\S]*?${escape(AGENTS_END)}`), block)
  } else after = `${before.trimEnd()}\n\n${block}\n`
  if (after === before) return {path: file, action: 'unchanged'}
  fs.writeFileSync(file, after)
  return {path: file, action: before === undefined ? 'created' : 'updated'}
}

function listFiles(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((e) => {
    const rel = path.join(prefix, e.name)
    return e.isDirectory() ? listFiles(path.join(dir, e.name), rel) : [rel]
  })
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
