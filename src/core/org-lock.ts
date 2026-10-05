/**
 * Optional cross-tool lock for shared orgs. When `orgBusyFile` is configured, every multi-step write
 * (restore, edit, apply) refuses to start while the file exists, writes `timemachine: <action> started
 * <time>` into it while running, and always removes it afterwards, also on failure.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {OrgBusyError} from '../agentia/errors.js'

export function resolveLockPath(file: string | undefined): string | undefined {
  if (!file) return undefined
  return path.resolve(file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : file)
}

/** Throws OrgBusyError if the lock file exists (unless `ignoreBusy`). Returns its contents if ignored. */
export function checkOrgBusy(file: string | undefined, ignoreBusy = false): string | undefined {
  if (!file || !fs.existsSync(file)) return undefined
  const contents = fs.readFileSync(file, 'utf8')
  if (!ignoreBusy) throw new OrgBusyError(file, contents)
  return contents
}

/** Runs `fn` while holding the lock. No-op wrapper when no lock file is configured. */
export async function withOrgLock<T>(file: string | undefined, action: string, fn: () => Promise<T>, ignoreBusy = false): Promise<T> {
  if (!file) return fn()
  checkOrgBusy(file, ignoreBusy)
  fs.mkdirSync(path.dirname(file), {recursive: true})
  try {
    fs.writeFileSync(file, `timemachine: ${action} started ${new Date().toISOString()}\n`, {flag: ignoreBusy ? 'w' : 'wx'})
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new OrgBusyError(file, fs.readFileSync(file, 'utf8'))
    throw error
  }
  try {
    return await fn()
  } finally {
    fs.rmSync(file, {force: true})
  }
}
