import fs from 'node:fs'
import path from 'node:path'

import {Command, Flags} from '@oclif/core'

import {AgentiaClient} from './agentia/client.js'
import {ExitCode, TimemachineError} from './agentia/errors.js'
import {style} from './render/style.js'

export type ClientFactory = (projectRoot: string) => AgentiaClient

/**
 * Base for all `agentia timemachine …` commands.
 * - `--json` output mirrors Agentia's envelope: `{result, status: 0}` / `{error, status: <exit code>}`.
 * - Typed errors print a message + hint (no stack trace unless --debug) and exit with their code.
 * - `agentia` is always spawned from the project root, where project-scoped Agentia auth lives.
 */
export abstract class TimemachineCommand extends Command {
  static override enableJsonFlag = true

  static override baseFlags = {
    debug: Flags.boolean({description: 'Show stack traces and internal details.', helpGroup: 'GLOBAL'}),
  }

  /** Tests replace this to inject a FakeRunner. */
  static clientFactory: ClientFactory = (projectRoot) => new AgentiaClient({cwd: projectRoot})

  private debugEnabled = false

  protected get projectRoot(): string {
    return findProjectRoot(process.cwd())
  }

  /** A client that spawns `agentia` from `root` (default: the nearest project root). */
  protected createClient(root?: string): AgentiaClient {
    return TimemachineCommand.clientFactory(root ?? this.projectRoot)
  }

  public override async init(): Promise<void> {
    await super.init()
    this.debugEnabled = this.argv.includes('--debug')
  }

  /** `status` in the success envelope; set with fail() when a command finishes with partial failures. */
  private jsonStatus = 0

  protected override toSuccessJson(result: unknown): unknown {
    return {result, status: this.jsonStatus}
  }

  /**
   * Ends with a non-zero exit code without throwing. The plugin ships its own @oclif/core, so the host
   * `agentia` CLI does not recognise our ExitError and would print "Error: EEXIT"; setting
   * process.exitCode and returning normally avoids that.
   */
  protected fail(code: number): void {
    this.jsonStatus = code
    process.exitCode = code
  }

  protected override toErrorJson(err: unknown): unknown {
    if (err instanceof TimemachineError) return {error: err.toJSON(), status: err.exitCode}
    const message = err instanceof Error ? err.message : String(err)
    const exit = (err as {oclif?: {exit?: number}})?.oclif?.exit
    if (exit !== undefined) return {error: {code: 'USAGE', message, exitCode: exit}, status: exit}
    return {error: {code: 'UNEXPECTED', message, exitCode: ExitCode.Generic}, status: ExitCode.Generic}
  }

  /** Reports every error ourselves (message + hint, JSON when asked) and never rethrows to the host. */
  protected override async catch(err: Error & {oclif?: {exit?: number}; code?: string; suggestions?: string[]}): Promise<unknown> {
    if (err.code === 'EEXIT') {
      process.exitCode = err.oclif?.exit ?? 0
      return
    }
    const typed = err instanceof TimemachineError ? err : undefined
    const exitCode = typed?.exitCode ?? err.oclif?.exit ?? ExitCode.Generic

    if (this.jsonEnabled()) {
      this.logJson(this.toErrorJson(err))
    } else {
      const lines = [`${style.red('✖')} ${err.message}`]
      const hint = typed?.hint ?? err.suggestions?.join(' · ')
      if (hint) lines.push(`  ${style.dim('→')} ${hint}`)
      if (typed?.details.transactionId) lines.push(`  ${style.dim(`Copado transaction: ${typed.details.transactionId}`)}`)
      if (this.debugEnabled && err.stack) lines.push(style.dim(err.stack))
      else if (!typed && err.oclif?.exit === undefined) lines.push(`  ${style.dim('Run again with --debug for details.')}`)
      this.logToStderr(lines.join('\n'))
    }
    process.exitCode = exitCode
  }
}

/**
 * The nearest ancestor containing `.timemachine/`, else one containing `.agentia/` (project-scoped
 * Agentia auth), else the current directory.
 */
export function findProjectRoot(start: string): string {
  for (const marker of ['.timemachine', '.agentia']) {
    let dir = path.resolve(start)
    while (true) {
      if (fs.existsSync(path.join(dir, marker))) return dir
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return path.resolve(start)
}
