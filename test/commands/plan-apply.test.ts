import fs from 'node:fs'
import path from 'node:path'

import {simpleGit} from 'simple-git'
import {describe, expect, it} from 'vitest'

import {ExitCode} from '../../src/agentia/errors.js'
import type {TemplateDetail} from '../../src/agentia/schemas.js'
import TimemachineApply, {type ApplyCommandResult} from '../../src/commands/timemachine/apply.js'
import TimemachineInit from '../../src/commands/timemachine/init.js'
import TimemachinePlan, {type PlanResult} from '../../src/commands/timemachine/plan.js'
import TimemachineSnapshot from '../../src/commands/timemachine/snapshot.js'
import {PLAN_MARKER} from '../../src/render/plan.js'
import {runCli} from '../cli.js'
import {FakeOrg} from '../fake-org.js'
import {READY_ID, tempDir, tempRepo} from '../helpers.js'

const READY = 'TM Demo - Accounts New'
const col = (doc: TemplateDetail, name: string) => doc.details[0].columns.find((c) => c.name === name)!

/** Workspace tracking both demo templates, snapshotted. */
async function setup() {
  const org = FakeOrg.demo()
  const ws = tempRepo()
  await runCli(TimemachineInit, ['--track', READY, '--track', 'TM Demo – Accounts'], org, ws)
  await runCli(TimemachineSnapshot, ['--all'], org, ws)
  return {org, ws}
}

/** A pull-request style change: edit template.json in git and commit it (no snapshot, no org call). */
async function commitChange(ws: string, change: (doc: TemplateDetail) => void, message = 'PR: select Website'): Promise<string> {
  const file = path.join(ws, '.timemachine', 'templates', 'tm-demo-accounts-new', 'template.json')
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as TemplateDetail
  change(doc)
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
  await simpleGit(ws).add(file).commit(message)
  return (await simpleGit(ws).revparse(['--short', 'HEAD'])).trim()
}

describe('timemachine plan', () => {
  it('shows what applying the committed version would change', async () => {
    const {org, ws} = await setup()
    const ref = await commitChange(ws, (d) => (col(d, 'Website').isSelected = true))
    const res = await runCli(TimemachinePlan, [], org, ws)
    expect(res.stdout).toContain(`Time Machine plan: ${ref} → Copado`)
    expect(res.stdout).toMatch(
      /TM Demo - Accounts New\s+ready to apply\s+\(1 added · 0 removed · 0 changed\)\n\s+\+ field Website added to Account/,
    )
    expect(res.stdout).toMatch(/TM Demo – Accounts\s+in sync/)
    expect(res.stdout).toContain('1 template would change. Apply with: agentia timemachine apply')
    expect(org.saves()).toHaveLength(0)
  })

  it('renders a pull-request comment', async () => {
    const {org, ws} = await setup()
    const ref = await commitChange(ws, (d) => (col(d, 'Website').isSelected = true))
    const out = path.join(tempDir(), 'plan.md')
    const res = await runCli(TimemachinePlan, ['--format', 'md', '--output', out], org, ws)
    const md = fs.readFileSync(out, 'utf8')
    expect(res.stdout).toContain(PLAN_MARKER)
    expect(md.startsWith(PLAN_MARKER)).toBe(true)
    expect(md).toContain(`### ⏱️ Time Machine plan · \`${ref}\``)
    expect(md).toContain('| ✅ | TM Demo - Accounts New | 1 added · 0 removed · 0 changed | ready to apply |')
    expect(md).toContain('| ✔️ | TM Demo – Accounts | — | in sync |')
    expect(md).toContain('```diff\n+ field Website added to Account\n```')
  })

  it('warns in the plan when Copado changed since the last snapshot', async () => {
    const {org, ws} = await setup()
    await commitChange(ws, (d) => (col(d, 'Website').isSelected = true))
    org.externalSave(READY_ID, (d) => (d.details[0].batchSize = 100))
    const res = await runCli(TimemachinePlan, ['--json'], org, ws)
    const entry = res.json<{result: PlanResult}>().result.templates.find((t) => t.template.name === READY)!
    expect(entry.status).toBe('base-drifted')
    expect(entry.driftSinceBase.map((s) => s.text)).toEqual(['Account: batchSize 200 → 100'])
    const md = (await runCli(TimemachinePlan, ['--format', 'md'], org, ws)).stdout
    expect(md).toContain('was changed in Copado after its last snapshot.** Apply will refuse to overwrite it')
  })

  it('exits 1 with --exit-code when there is something to apply', async () => {
    const {org, ws} = await setup()
    expect((await runCli(TimemachinePlan, ['--exit-code'], org, ws)).exitCode).toBe(0)
    await commitChange(ws, (d) => (col(d, 'Website').isSelected = true))
    expect((await runCli(TimemachinePlan, ['--exit-code'], org, ws)).exitCode).toBe(1)
  })
})

describe('timemachine apply', () => {
  it('applies the committed version, verifies it and records it', async () => {
    const {org, ws} = await setup()
    const ref = await commitChange(ws, (d) => (col(d, 'Website').isSelected = true))
    const res = await runCli(TimemachineApply, ['--yes', '--json'], org, ws)
    expect(res.exitCode).toBe(0)
    const result = res.json<{result: ApplyCommandResult}>().result
    expect(result.results.map((r) => [r.template.name, r.outcome])).toEqual([
      ['TM Demo – Accounts', 'in-sync'],
      [READY, 'applied'],
    ])
    expect(col(org.details.get(READY_ID)!, 'Website').isSelected).toBe(true)
    expect((await simpleGit(ws).raw(['log', '-1', '--format=%s'])).trim()).toMatch(new RegExp(`\\[apply ${ref}\\]$`))
    expect((await runCli(TimemachinePlan, [], org, ws)).stdout).toContain('Nothing to apply.')
  })

  it('refuses to overwrite a change made in Copado after the last snapshot', async () => {
    const {org, ws} = await setup()
    await commitChange(ws, (d) => (col(d, 'Website').isSelected = true))
    org.externalSave(READY_ID, (d) => (d.details[0].batchSize = 100))
    const res = await runCli(TimemachineApply, ['--yes'], org, ws)
    expect(res.exitCode).toBe(ExitCode.Conflict)
    expect(res.stdout).toContain('TM Demo - Accounts New: blocked: Copado changed since the last snapshot')
    expect(org.saves()).toHaveLength(0)
    expect(org.details.get(READY_ID)!.details[0].batchSize).toBe(100)
  })

  it('refuses documents Copado would reject', async () => {
    const {org, ws} = await setup()
    await commitChange(ws, (d) => (d.details[0].limit = null))
    const res = await runCli(TimemachineApply, ['--yes'], org, ws)
    expect(res.exitCode).toBe(ExitCode.Validation)
    expect(res.stdout).toContain('Max. Record Limit')
    expect(org.saves()).toHaveLength(0)
  })

  it('writes nothing with --dry-run, and needs --yes without a terminal', async () => {
    const {org, ws} = await setup()
    await commitChange(ws, (d) => (col(d, 'Website').isSelected = true))
    expect((await runCli(TimemachineApply, ['--dry-run'], org, ws)).stdout).toContain('Dry run: nothing was written.')
    expect((await runCli(TimemachineApply, [], org, ws)).exitCode).toBe(ExitCode.Usage)
    expect(org.saves()).toHaveLength(0)
  })

  it('applies only the named templates', async () => {
    const {org, ws} = await setup()
    await commitChange(ws, (d) => (col(d, 'Website').isSelected = true))
    const res = await runCli(TimemachineApply, ['TM Demo – Accounts', '--yes', '--json'], org, ws)
    expect(res.json<{result: ApplyCommandResult}>().result.results.map((r) => r.outcome)).toEqual(['in-sync'])
    expect(org.saves()).toHaveLength(0)
    const bad = await runCli(TimemachineApply, ['Not tracked', '--yes'], org, ws)
    expect(bad.exitCode).toBe(ExitCode.NotFound)
  })
})
