import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {AgentiaClient} from '../../src/agentia/client.js'
import {ExitCode} from '../../src/agentia/errors.js'
import type {FakeRunner} from '../../src/agentia/runner.js'
import {TimemachineCommand} from '../../src/base-command.js'
import TimemachineStatus, {type StatusRow} from '../../src/commands/timemachine/status.js'
import {NO_FILTER_ID, READY_ID, ROOT, fixture, scenario} from '../helpers.js'

let stdout = ''
let stderr = ''
const originalFactory = TimemachineCommand.clientFactory

function useRunner(runner: FakeRunner): FakeRunner {
  TimemachineCommand.clientFactory = () => new AgentiaClient({runner, cwd: ROOT})
  return runner
}

/** Runs the command and returns its exit code (0 when it returns normally). */
async function run(argv: string[]): Promise<number> {
  process.exitCode = undefined
  try {
    await TimemachineStatus.run(argv, ROOT)
    const code = Number(process.exitCode ?? 0)
    process.exitCode = undefined
    return code
  } catch (error) {
    const exit = (error as {oclif?: {exit?: number}}).oclif?.exit
    if (exit === undefined) throw error
    return exit
  }
}

beforeEach(() => {
  stdout = ''
  stderr = ''
  // oclif 4 writes through console.log / console.error
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout += `${args.join(' ')}\n`
  })
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr += `${args.join(' ')}\n`
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  TimemachineCommand.clientFactory = originalFactory
})

describe('timemachine status', () => {
  it('shows a ready template and a blocked one with its fix', async () => {
    useRunner(scenario('demo'))
    expect(await run([])).toBe(0)
    expect(stdout).toMatch(/TM Demo - Accounts New\s+Account\s+v2\s+ready/)
    expect(stdout).toMatch(/TM Demo – Accounts\s+Account\s+v2\s+blocked \(filters\)/)
    expect(stdout).toContain('TM Demo – Accounts: Add a main object filter for Account (Main Object Filter tab).')
  })

  it('returns the Agentia-style JSON envelope', async () => {
    useRunner(scenario('demo'))
    expect(await run(['--json'])).toBe(0)
    const out = JSON.parse(stdout) as {status: number; result: StatusRow[]}
    expect(out.status).toBe(0)
    expect(out.result).toEqual([
      expect.objectContaining({id: NO_FILTER_ID, format: 'v2', saveable: false}),
      expect.objectContaining({id: READY_ID, format: 'v2', saveable: true, saveBlockers: []}),
    ])
  })

  it('flags legacy templates and how to convert them', async () => {
    useRunner(scenario('legacy'))
    expect(await run([])).toBe(0)
    expect(stdout).toMatch(/TM Demo - Accounts New\s+Account\s+legacy\s+needs v2 conversion/)
    expect(stdout).toContain(`agentia cicd data template convert-old ${READY_ID}`)
  })

  it('limits the report to the named templates', async () => {
    const runner = useRunner(scenario('demo'))
    expect(await run(['TM Demo - Accounts New', '--json'])).toBe(0)
    expect((JSON.parse(stdout) as {result: StatusRow[]}).result.map((r) => r.id)).toEqual([READY_ID])
    expect(runner.calls.filter((c) => c.args[3] === 'get-detail')).toHaveLength(1)
  })

  it('keeps going when one template fails, and says why', async () => {
    useRunner(scenario('demo', {[`cicd data template get-detail ${READY_ID}`]: fixture('error-lgn-001')}))
    expect(await run(['--json'])).toBe(0)
    const rows = (JSON.parse(stdout) as {result: StatusRow[]}).result
    expect(rows.find((r) => r.id === READY_ID)).toMatchObject({format: 'error', error: {code: 'SOURCE_ORG_LOGIN'}})
  })

  it('stops with exit 3 and a hint when Agentia is not authenticated', async () => {
    useRunner(scenario('demo', {'cicd data template list': fixture('error-auth-missing')}))
    expect(await run([])).toBe(ExitCode.AuthMissing)
    expect(stderr).toContain('CICD API key is not configured')
    expect(stderr).toContain('Run `agentia setup` in this project folder')
    expect(stderr).not.toMatch(/at .*\.ts:\d+/) // no stack trace without --debug
  })

  it('reports errors as JSON with the exit code as status', async () => {
    useRunner(scenario('demo', {'cicd data template list': fixture('error-auth-missing')}))
    expect(await run(['--json'])).toBe(ExitCode.AuthMissing)
    expect(JSON.parse(stdout)).toMatchObject({status: ExitCode.AuthMissing, error: {code: 'AUTH_MISSING', hint: expect.any(String)}})
  })

  it('exits 4 for an unknown template name', async () => {
    useRunner(scenario('demo'))
    expect(await run(['Does not exist'])).toBe(ExitCode.NotFound)
    expect(stderr).toContain('Data template "Does not exist" was not found.')
  })

  it('refuses an Agentia CLI older than the minimum', async () => {
    useRunner(scenario('demo', {'--version': {stdout: '@copado/agentia-cli/1.0.0-beta.0 darwin-arm64'}}))
    expect(await run([])).toBe(ExitCode.AgentiaUnavailable)
    expect(stderr).toContain('agentia update')
  })
})
