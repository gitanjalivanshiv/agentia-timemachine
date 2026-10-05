/**
 * The snapshot repository: `.timemachine/` inside a git working tree.
 *
 *   .timemachine/
 *     config.json
 *     templates/<slug>/template.json   v2 detail document (sorted keys, original array order)
 *     templates/<slug>/extras.json     advanced filters + record matching formulas (fetched separately)
 *     templates/<slug>/meta.json       id, name, hashes, fetchedAt, source command, CLI version
 *     .lock/                           in-progress safe edits (git-ignored)
 *
 * Every snapshot is one git commit touching only that template's folder (+ config.json).
 */
import fs from 'node:fs'
import path from 'node:path'

import {simpleGit, type SimpleGit} from 'simple-git'
import {z} from 'zod'

import {GitError, NotInitialisedError} from '../agentia/errors.js'
import {toStorageJson} from '../core/canonical.js'
import {ConfigSchema, defaultConfig, type Config} from './config.js'

export const TM_DIR = '.timemachine'

export const SnapshotMetaSchema = z.looseObject({
  templateId: z.string(),
  name: z.string(),
  mainObject: z.string().nullish(),
  /** Canonical SHA-256 of template.json: the concurrency identity. */
  hash: z.string(),
  extrasHash: z.string(),
  /** Copado's `lastModified` at fetch time. */
  lastModified: z.string().nullish(),
  fetchedAt: z.string(),
  sourceCommand: z.string(),
  agentiaVersion: z.string().nullish(),
})
export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>

export interface SnapshotFiles {
  detail: unknown
  extras: unknown
  meta: SnapshotMeta
}

export interface HistoryEntry {
  commit: string
  shortCommit: string
  date: string
  author: string
  subject: string
  trailers: Record<string, string>
}

export class Store {
  readonly git: SimpleGit

  constructor(readonly root: string) {
    this.git = simpleGit({baseDir: root})
  }

  /** Nearest ancestor of `start` that contains `.timemachine/config.json`. */
  static find(start: string): Store | undefined {
    let dir = path.resolve(start)
    while (true) {
      if (fs.existsSync(path.join(dir, TM_DIR, 'config.json'))) return new Store(dir)
      const parent = path.dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  }

  static require(start: string): Store {
    const store = Store.find(start)
    if (!store) throw new NotInitialisedError(start)
    return store
  }

  get dir(): string {
    return path.join(this.root, TM_DIR)
  }

  get configPath(): string {
    return path.join(this.dir, 'config.json')
  }

  /** Path relative to the store root, with forward slashes (git pathspec). */
  rel(...parts: string[]): string {
    return path.posix.join(TM_DIR, ...parts)
  }

  templateRel(slug: string, file?: string): string {
    return file ? this.rel('templates', slug, file) : this.rel('templates', slug)
  }

  // ---------- config ----------

  exists(): boolean {
    return fs.existsSync(this.configPath)
  }

  loadConfig(): Config {
    if (!this.exists()) return defaultConfig()
    return ConfigSchema.parse(JSON.parse(fs.readFileSync(this.configPath, 'utf8')))
  }

  saveConfig(config: Config): void {
    fs.mkdirSync(this.dir, {recursive: true})
    fs.writeFileSync(
      this.configPath,
      toStorageJson({...config, templates: [...config.templates].sort((a, b) => a.slug.localeCompare(b.slug))}),
    )
  }

  // ---------- snapshots (working tree) ----------

  readSnapshot(slug: string): SnapshotFiles | undefined {
    const file = (name: string) => path.join(this.root, this.templateRel(slug, name))
    if (!fs.existsSync(file('meta.json'))) return undefined
    return {
      detail: readJson(file('template.json')),
      extras: fs.existsSync(file('extras.json')) ? readJson(file('extras.json')) : {},
      meta: SnapshotMetaSchema.parse(readJson(file('meta.json'))),
    }
  }

  writeSnapshot(slug: string, files: SnapshotFiles): string[] {
    const dir = path.join(this.root, this.templateRel(slug))
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(path.join(dir, 'template.json'), toStorageJson(files.detail))
    fs.writeFileSync(path.join(dir, 'extras.json'), toStorageJson(files.extras))
    fs.writeFileSync(path.join(dir, 'meta.json'), toStorageJson(files.meta))
    return ['template.json', 'extras.json', 'meta.json'].map((f) => this.templateRel(slug, f))
  }

  // ---------- git ----------

  async isRepo(): Promise<boolean> {
    try {
      return await this.git.checkIsRepo()
    } catch {
      return false
    }
  }

  async ensureRepo(): Promise<boolean> {
    if (await this.isRepo()) return false
    await this.git.init(['--initial-branch=main'])
    return true
  }

  async hasCommits(): Promise<boolean> {
    try {
      await this.git.raw(['rev-parse', '--verify', 'HEAD'])
      return true
    } catch {
      return false
    }
  }

  async gitUser(): Promise<string> {
    const name = (await this.git.raw(['config', '--get', 'user.name']).catch(() => '')).trim()
    const email = (await this.git.raw(['config', '--get', 'user.email']).catch(() => '')).trim()
    if (!name || !email) {
      throw new GitError(
        'Git needs your name and email to record who took a snapshot.',
        'Run `git config user.name "Your Name"` and `git config user.email you@example.com`, then retry.',
      )
    }
    return name
  }

  /** Stages and commits exactly `paths`; other staged changes in the repo are left alone. */
  async commit(paths: string[], message: string): Promise<string> {
    try {
      await this.git.add(paths)
      await this.git.raw(['commit', '-m', message, '--only', '--', ...paths])
      return (await this.git.revparse(['HEAD'])).trim()
    } catch (error) {
      if (error instanceof GitError) throw error
      throw new GitError(`git commit failed: ${(error as Error).message.split('\n')[0]}`)
    }
  }

  /** Is there anything to commit for these paths? */
  async hasChanges(paths: string[]): Promise<boolean> {
    const status = await this.git.raw(['status', '--porcelain', '--', ...paths])
    return status.trim().length > 0
  }

  /** Snapshot commits that touched a template's folder, newest first. */
  async history(slug: string, limit?: number): Promise<HistoryEntry[]> {
    if (!(await this.hasCommits())) return []
    const SEP = '\u001f'
    const END = '\u001e'
    const args = ['log', `--format=%H${SEP}%h${SEP}%aI${SEP}%an${SEP}%s${SEP}%b${END}`]
    if (limit) args.push(`-n${limit}`)
    args.push('--', this.templateRel(slug))
    const out = await this.git.raw(args)
    return out
      .split(END)
      .map((r) => r.trim())
      .filter(Boolean)
      .map((record) => {
        const [commit, shortCommit, date, author, subject, body = ''] = record.split(SEP)
        return {commit, shortCommit, date, author, subject, trailers: parseTrailers(body)}
      })
  }

  /** A file's content at a git ref, or undefined if it did not exist there. */
  async showAt(ref: string, relPath: string): Promise<string | undefined> {
    try {
      return await this.git.show([`${ref}:${relPath}`])
    } catch {
      return undefined
    }
  }
}

/** Parses `Key: value` trailer lines from a commit body. */
export function parseTrailers(body: string): Record<string, string> {
  const trailers: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const match = /^([A-Z][A-Za-z-]+):\s?(.*)$/.exec(line.trim())
    if (match) trailers[match[1]] = match[2]
  }
  return trailers
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
