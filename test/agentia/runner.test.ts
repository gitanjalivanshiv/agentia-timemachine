import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {afterAll, describe, expect, it} from 'vitest'

import {AgentiaClient} from '../../src/agentia/client.js'
import {AgentiaNotInstalledError, AgentiaTimeoutError} from '../../src/agentia/errors.js'
import {FakeRunner, ProcessRunner, RecordingRunner} from '../../src/agentia/runner.js'
import {FAKE_BIN, ROOT, ok} from '../helpers.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-runner-'))
afterAll(() => fs.rmSync(tmp, {recursive: true, force: true}))

describe('ProcessRunner', () => {
  it('runs the fake agentia binary end to end', async () => {
    process.env.TM_FAKE_SCENARIO = path.join(ROOT, 'fixtures', 'scenarios', 'demo.json')
    const client = new AgentiaClient({runner: new ProcessRunner(FAKE_BIN), cwd: ROOT})
    expect(await client.version()).toBe('1.0.0-beta.2')
    expect((await client.listTemplates()).length).toBe(2)
  })

  it('reports a missing binary as AgentiaNotInstalledError', async () => {
    const runner = new ProcessRunner(path.join(tmp, 'no-such-agentia'))
    await expect(runner.run(['--version'], {cwd: tmp, timeoutMs: 1000})).rejects.toBeInstanceOf(AgentiaNotInstalledError)
  })

  it('kills a hanging command and reports a timeout', async () => {
    const slow = path.join(tmp, 'slow-agentia.mjs')
    fs.writeFileSync(slow, '#!/usr/bin/env node\nsetTimeout(() => {}, 10000)\n', {mode: 0o755})
    const runner = new ProcessRunner(slow)
    await expect(runner.run(['x'], {cwd: tmp, timeoutMs: 300})).rejects.toBeInstanceOf(AgentiaTimeoutError)
  })

  it('pipes input to stdin', async () => {
    const echo = path.join(tmp, 'echo-agentia.mjs')
    fs.writeFileSync(
      echo,
      '#!/usr/bin/env node\nlet s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s.toUpperCase()))\n',
      {mode: 0o755},
    )
    const result = await new ProcessRunner(echo).run([], {cwd: tmp, timeoutMs: 5000, input: 'hello'})
    expect(result).toEqual({stdout: 'HELLO', exitCode: 0})
  })
})

describe('FakeRunner', () => {
  it('consumes sequences in order and repeats the last entry', async () => {
    const runner = new FakeRunner({'a b': [ok(1), ok(2)]})
    const run = async () => JSON.parse((await runner.run(['a', 'b', '--json'], {cwd: '/', timeoutMs: 1})).stdout).result
    expect([await run(), await run(), await run()]).toEqual([1, 2, 2])
  })

  it('fails loudly for unknown commands', async () => {
    await expect(new FakeRunner({}).run(['nope'], {cwd: '/', timeoutMs: 1})).rejects.toThrow(/no response for "agentia nope"/)
  })
})

describe('RecordingRunner', () => {
  it('writes each call to the recording directory', async () => {
    const dir = path.join(tmp, 'recorded')
    const runner = new RecordingRunner(new FakeRunner({'cicd data template list': ok([])}), dir)
    await runner.run(['cicd', 'data', 'template', 'list', '--json'], {cwd: '/', timeoutMs: 1})
    const [file] = fs.readdirSync(dir)
    expect(file).toMatch(/cicd_data_template_list\.json$/)
    expect(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))).toMatchObject({
      args: ['cicd', 'data', 'template', 'list'],
      exitCode: 0,
    })
  })
})
