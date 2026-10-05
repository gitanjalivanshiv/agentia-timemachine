/**
 * Edit sessions: the base an edit started from, kept in `.timemachine/.lock/<slug>/<session>/`
 * (git-ignored). Several people (or terminals) can hold sessions on the same template; whoever saves
 * second is blocked because live no longer matches their base.
 *
 *   base.json     the live document when the edit started (the base of the three-way view)
 *   edit.json     the working copy people edit
 *   session.json  template, base hash, Copado lastModified, who/when
 */
import fs from 'node:fs'
import path from 'node:path'

import {z} from 'zod'

import {toStorageJson} from './canonical.js'
import type {Store} from '../store/store.js'

export const SessionInfoSchema = z.object({
  templateId: z.string(),
  name: z.string(),
  slug: z.string(),
  session: z.string(),
  baseHash: z.string(),
  baseLastModified: z.string().nullish(),
  startedAt: z.string(),
  startedBy: z.string(),
})
export type SessionInfo = z.infer<typeof SessionInfoSchema>

export interface EditSession {
  info: SessionInfo
  dir: string
  baseFile: string
  editFile: string
}

export class EditSessions {
  constructor(private readonly store: Store) {}

  dir(slug: string, session: string): string {
    return path.join(this.store.dir, '.lock', slug, session)
  }

  get(slug: string, session: string): EditSession | undefined {
    const dir = this.dir(slug, session)
    const infoFile = path.join(dir, 'session.json')
    if (!fs.existsSync(infoFile)) return undefined
    return {
      info: SessionInfoSchema.parse(JSON.parse(fs.readFileSync(infoFile, 'utf8'))),
      dir,
      baseFile: path.join(dir, 'base.json'),
      editFile: path.join(dir, 'edit.json'),
    }
  }

  list(slug: string): EditSession[] {
    const root = path.join(this.store.dir, '.lock', slug)
    if (!fs.existsSync(root)) return []
    return fs
      .readdirSync(root)
      .map((s) => this.get(slug, s))
      .filter((s): s is EditSession => s !== undefined)
  }

  start(info: SessionInfo, base: unknown): EditSession {
    const dir = this.dir(info.slug, info.session)
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(path.join(dir, 'base.json'), toStorageJson(base))
    fs.writeFileSync(path.join(dir, 'edit.json'), toStorageJson(base))
    fs.writeFileSync(path.join(dir, 'session.json'), toStorageJson(info))
    return this.get(info.slug, info.session)!
  }

  readBase(session: EditSession): unknown {
    return JSON.parse(fs.readFileSync(session.baseFile, 'utf8'))
  }

  remove(session: EditSession): void {
    fs.rmSync(session.dir, {recursive: true, force: true})
    const parent = path.dirname(session.dir)
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent)
  }
}
