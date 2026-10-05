/**
 * Runners execute `agentia <args>` and return raw stdout + exit code. They know nothing about
 * Copado; AgentiaClient interprets the output. Swapping the runner is how tests (FakeRunner),
 * fixture capture (RecordingRunner, TM_RECORD=1) and a future first-party plugin API plug in.
 */
import {spawn} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {AgentiaNotInstalledError, AgentiaTimeoutError} from './errors.js'

export interface RunOptions {
  /** Working directory. Project-scoped Agentia auth is only found from the project root. */
  cwd: string
  timeoutMs: number
  /** Written to stdin (used for `--stdin` JSON bodies). */
  input?: string
}

export interface RunResult {
  stdout: string
  exitCode: number
}

export interface Runner {
  run(args: string[], options: RunOptions): Promise<RunResult>
}

/** Spawns the real binary: `TM_AGENTIA_BIN` or `agentia` on PATH. */
export class ProcessRunner implements Runner {
  constructor(readonly bin: string = process.env.TM_AGENTIA_BIN || 'agentia') {}

  run(args: string[], {cwd, timeoutMs, input}: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd,
        env: {...process.env, NO_COLOR: '1', FORCE_COLOR: '0'},
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
      const out: Buffer[] = []
      child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
      // stderr carries spinners and human text only; with --json all results go to stdout.
      child.stderr?.resume()

      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new AgentiaTimeoutError(args.join(' '), timeoutMs))
      }, timeoutMs)

      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        reject(error.code === 'ENOENT' ? new AgentiaNotInstalledError(this.bin) : error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({stdout: Buffer.concat(out).toString('utf8'), exitCode: code ?? 1})
      })

      if (input !== undefined && child.stdin) {
        child.stdin.end(input)
      }
    })
  }
}

export interface FakeResponse {
  exitCode?: number
  /** Raw stdout, or a value that is JSON-serialised. */
  stdout: unknown
}

export interface FakeCall {
  args: string[]
  cwd: string
  input?: string
}

/**
 * Replays canned responses keyed by the argument list without `--json`, e.g.
 * `"cicd data template list"`. An array value is consumed in order; its last entry repeats.
 */
export class FakeRunner implements Runner {
  readonly calls: FakeCall[] = []
  private readonly responses: Map<string, FakeResponse[]>

  constructor(responses: Record<string, FakeResponse | FakeResponse[]>) {
    this.responses = new Map(Object.entries(responses).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]))
  }

  static key(args: string[]): string {
    return args.filter((a) => a !== '--json').join(' ')
  }

  async run(args: string[], {cwd, input}: RunOptions): Promise<RunResult> {
    this.calls.push({args, cwd, input})
    const key = FakeRunner.key(args)
    const queue = this.responses.get(key)
    if (!queue || queue.length === 0) {
      throw new Error(`FakeRunner: no response for "agentia ${key}". Known: ${[...this.responses.keys()].join(' | ')}`)
    }
    const response = queue.length > 1 ? queue.shift()! : queue[0]
    const stdout = typeof response.stdout === 'string' ? response.stdout : JSON.stringify(response.stdout)
    return {stdout, exitCode: response.exitCode ?? 0}
  }
}

/**
 * Wraps another runner and writes every call + output to `dir` (git-ignored fixtures/raw/recorded).
 * Enabled with TM_RECORD=1. Recordings contain real org data: scrub them with
 * `node scripts/scrub-fixtures.mjs` before committing anything derived from them.
 */
export class RecordingRunner implements Runner {
  private seq = 0

  constructor(
    private readonly inner: Runner,
    private readonly dir: string,
  ) {}

  async run(args: string[], options: RunOptions): Promise<RunResult> {
    const result = await this.inner.run(args, options)
    fs.mkdirSync(this.dir, {recursive: true})
    const slug = FakeRunner.key(args)
      .replace(/[^\w-]+/g, '_')
      .slice(0, 80)
    const file = path.join(this.dir, `${Date.now()}-${String(++this.seq).padStart(3, '0')}-${slug}.json`)
    fs.writeFileSync(
      file,
      JSON.stringify({args: args.filter((a) => a !== '--json'), exitCode: result.exitCode, stdout: result.stdout}, null, 2),
    )
    return result
  }
}
