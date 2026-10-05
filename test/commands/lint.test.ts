import fs from 'node:fs'
import path from 'node:path'

import {simpleGit} from 'simple-git'
import {describe, expect, it} from 'vitest'

import type {TemplateDetail} from '../../src/agentia/schemas.js'
import TimemachineInit from '../../src/commands/timemachine/init.js'
import TimemachineLint, {type LintResult} from '../../src/commands/timemachine/lint.js'
import TimemachineSnapshot from '../../src/commands/timemachine/snapshot.js'
import {runCli} from '../cli.js'
import {FakeOrg} from '../fake-org.js'
import {READY_ID, tempRepo} from '../helpers.js'

async function setup() {
  const org = FakeOrg.demo()
  const ws = tempRepo()
  await runCli(TimemachineInit, ['--track', 'TM Demo - Accounts New', '--track', 'TM Demo – Accounts'], org, ws)
  await runCli(TimemachineSnapshot, ['--all'], org, ws)
  return {org, ws}
}

describe('timemachine lint', () => {
  it('reports per template and fails on errors', async () => {
    const {org, ws} = await setup()
    const res = await runCli(TimemachineLint, [], org, ws)
    expect(res.exitCode).toBe(1)
    expect(res.stdout).toMatch(/TM Demo – Accounts \(HEAD\)\n\s+✖ TM001 Account has no main object filter\.\n\s+→ Add a filter for Account/)
    expect(res.stdout).toMatch(/1 error · \d+ warnings · \d+ info/)
  })

  it('passes without --strict when only warnings remain, fails with it', async () => {
    const {org, ws} = await setup()
    expect((await runCli(TimemachineLint, ['TM Demo - Accounts New'], org, ws)).exitCode).toBe(0)
    expect((await runCli(TimemachineLint, ['TM Demo - Accounts New', '--strict'], org, ws)).exitCode).toBe(1)
  })

  it('lints the committed version, or live with --ref live', async () => {
    const {org, ws} = await setup()
    const file = path.join(ws, '.timemachine', 'templates', 'tm-demo-accounts-new', 'template.json')
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as TemplateDetail
    doc.details[0].batchSize = 999
    fs.writeFileSync(file, JSON.stringify(doc))
    await simpleGit(ws).add(file).commit('PR: big batches')
    const committed = (await runCli(TimemachineLint, ['TM Demo - Accounts New', '--json'], org, ws)).json<{result: LintResult}>().result
    expect(committed.templates[0].findings.map((f) => f.rule)).toContain('TM010')
    const live = (await runCli(TimemachineLint, ['TM Demo - Accounts New', '--ref', 'live', '--json'], org, ws)).json<{
      result: LintResult
    }>().result
    expect(live.templates[0].source).toBe('live')
    expect(live.templates[0].findings.map((f) => f.rule)).not.toContain('TM010')
    expect(org.details.get(READY_ID)!.details[0].batchSize).toBe(200)
  })

  it('honours lint settings in config.json', async () => {
    const {org, ws} = await setup()
    const configPath = path.join(ws, '.timemachine', 'config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    fs.writeFileSync(configPath, JSON.stringify({...config, lint: {disable: ['TM001', 'TM003', 'TM004', 'TM011']}}))
    const res = await runCli(TimemachineLint, ['--json'], org, ws)
    expect(res.exitCode).toBe(0)
    expect(res.json<{result: LintResult}>().result.counts).toEqual({error: 0, warning: 0, info: 0})
  })
})
