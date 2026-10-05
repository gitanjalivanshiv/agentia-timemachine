import type {Command} from '@oclif/core'
import {vi} from 'vitest'

import {AgentiaClient} from '../src/agentia/client.js'
import type {Runner} from '../src/agentia/runner.js'
import {TimemachineCommand} from '../src/base-command.js'
import {ROOT} from './helpers.js'

export interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
  /** Parsed stdout when the command ran with --json. */
  json: <T = unknown>() => T
}

type CommandClass = {run(argv?: string[], opts?: string): Promise<unknown>} & typeof Command

/**
 * Runs an oclif command in-process with an injected runner, capturing console output
 * (oclif 4 writes through console.log/error) and the exit code.
 */
export async function runCli(command: CommandClass, argv: string[], runner?: Runner, cwd?: string): Promise<CliResult> {
  let stdout = ''
  let stderr = ''
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    stdout += `${a.join(' ')}\n`
  })
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderr += `${a.join(' ')}\n`
  })
  const factory = TimemachineCommand.clientFactory
  if (runner) TimemachineCommand.clientFactory = (root) => new AgentiaClient({runner, cwd: root})
  const previousCwd = process.cwd()
  if (cwd) process.chdir(cwd)
  let exitCode: number
  process.exitCode = undefined
  try {
    await command.run(argv, ROOT)
    exitCode = Number(process.exitCode ?? 0)
  } catch (error) {
    const exit = (error as {oclif?: {exit?: number}}).oclif?.exit
    if (exit === undefined) throw error
    exitCode = exit
  } finally {
    process.exitCode = undefined
    process.chdir(previousCwd)
    TimemachineCommand.clientFactory = factory
    log.mockRestore()
    err.mockRestore()
  }
  return {exitCode, stdout, stderr, json: <T>() => JSON.parse(stdout) as T}
}
