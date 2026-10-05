import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {FakeRunner, type FakeResponse} from '../src/agentia/runner.js'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FAKE_BIN = path.join(ROOT, 'scripts', 'fake-agentia.mjs')

export const VERSION_OK: FakeResponse = {stdout: '@copado/agentia-cli/1.0.0-beta.2 darwin-arm64 node-v24.18.0\n'}

/** A scrubbed fixture from fixtures/agentia as a FakeRunner response. */
export function fixture(name: string): FakeResponse {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'agentia', `${name}.json`), 'utf8')) as FakeResponse
}

/** The `result` of a success fixture, deep-copied. */
export function fixtureResult<T = unknown>(name: string): T {
  return structuredClone((fixture(name).stdout as {result: T}).result)
}

export function ok(result: unknown): FakeResponse {
  return {exitCode: 0, stdout: {result, status: 0, transactionId: 'tx-test'}}
}

type ScenarioEntry = string | FakeResponse
/** Builds a FakeRunner from a scenario file (same format as scripts/fake-agentia.mjs). */
export function scenario(name: string, overrides: Record<string, FakeResponse | FakeResponse[]> = {}): FakeRunner {
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'scenarios', `${name}.json`), 'utf8')) as {
    responses: Record<string, ScenarioEntry | ScenarioEntry[]>
  }
  const resolve = (e: ScenarioEntry): FakeResponse => (typeof e === 'string' ? fixture(e.replace(/\.json$/, '')) : e)
  const responses: Record<string, FakeResponse | FakeResponse[]> = {}
  for (const [key, value] of Object.entries(file.responses)) responses[key] = Array.isArray(value) ? value.map(resolve) : resolve(value)
  return new FakeRunner({...responses, ...overrides})
}

export const READY_ID = 'a0U000000000004AAA' // "TM Demo - Accounts New": v2, filter, limit
export const NO_FILTER_ID = 'a0U000000000001AAA' // "TM Demo – Accounts": v2, no filter

/** A fresh temp directory (removed by the OS eventually; tests also clean up). */
export function tempDir(prefix = 'tm-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * Gives a repo a local git identity. (simple-git strips ambient GIT_* env vars, so GIT_CONFIG_GLOBAL
 * cannot be used; local config also keeps the developer's real config out of tests.)
 */
export function useGitIdentity(repoDir: string, name = 'Test User', email = 'test@example.com'): void {
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', name])
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', email])
}

/** A temp folder that is already a git repo with a local identity (what `timemachine init` expects). */
export function tempRepo(): string {
  const dir = tempDir('tm-ws-')
  execFileSync('git', ['-C', dir, 'init', '-q', '--initial-branch=main'])
  useGitIdentity(dir)
  return dir
}
