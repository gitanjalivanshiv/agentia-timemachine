import fs from 'node:fs'
import path from 'node:path'

import {simpleGit} from 'simple-git'
import {describe, expect, it} from 'vitest'

import {ExitCode} from '../../src/agentia/errors.js'
import type {TemplateDetail} from '../../src/agentia/schemas.js'
import TimemachineHistory, {type HistoryRow} from '../../src/commands/timemachine/history.js'
import TimemachineInit from '../../src/commands/timemachine/init.js'
import TimemachineRestore, {type RestoreResult} from '../../src/commands/timemachine/restore.js'
import TimemachineSnapshot from '../../src/commands/timemachine/snapshot.js'
import TimemachineStatus, {type StatusRow} from '../../src/commands/timemachine/status.js'
import {hashDocument} from '../../src/core/canonical.js'
import {runCli} from '../cli.js'
import {FakeOrg} from '../fake-org.js'
import {READY_ID, fixtureResult, tempDir, tempRepo} from '../helpers.js'

const READY = 'TM Demo - Accounts New'
const deselectFax = (doc: TemplateDetail) => {
  doc.details[0].columns.find((c) => c.name === 'Fax')!.isSelected = false
}

/** Workspace with snapshot v1 (original) and v2 (Fax deselected); live = v2. Returns the v1 ref. */
async function setup(org = FakeOrg.demo()) {
  const ws = tempRepo()
  await runCli(TimemachineInit, ['--track', READY], org, ws)
  await runCli(TimemachineSnapshot, ['--all', '--reason', 'v1'], org, ws)
  const v1 = (await simpleGit(ws).revparse(['HEAD'])).trim().slice(0, 7)
  org.externalSave(READY_ID, deselectFax)
  await runCli(TimemachineSnapshot, ['--all', '--reason', 'v2'], org, ws)
  return {org, ws, v1}
}

const commits = async (ws: string) => (await simpleGit(ws).raw(['log', '--format=%s'])).trim().split('\n')
const liveHash = (org: FakeOrg) => hashDocument(org.details.get(READY_ID))

describe('timemachine restore', () => {
  it('restores, verifies and records the restore', async () => {
    const {org, ws, v1} = await setup()
    const res = await runCli(TimemachineRestore, [READY, '--to', v1, '--yes'], org, ws)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('+ field Fax added to Account')
    expect(res.stdout).toMatch(new RegExp(`✔ Restored TM Demo - Accounts New to ${v1} and verified`))
    expect(liveHash(org)).toBe(hashDocument(fixtureResult('detail-v2-ready')))
    expect(org.saves()).toHaveLength(1)
    // live was already snapshotted, so only the post-restore snapshot is new
    expect((await commits(ws))[0]).toMatch(new RegExp(`\\[restore to ${v1}\\]$`))
  })

  it('prints an undo command that really undoes', async () => {
    const {org, ws, v1} = await setup()
    const res = await runCli(TimemachineRestore, [READY, '--to', v1, '--yes', '--json'], org, ws)
    const result = res.json<{result: RestoreResult}>().result
    expect(result.outcome).toBe('restored')
    const undoRef = /--to (\w+)/.exec(result.undo!)![1]
    await runCli(TimemachineRestore, [READY, '--to', undoRef, '--yes'], org, ws)
    expect(org.details.get(READY_ID)!.details[0].columns.find((c) => c.name === 'Fax')!.isSelected).toBe(false)
  })

  it('snapshots unsaved live changes first ("undo the undo")', async () => {
    const {org, ws, v1} = await setup()
    org.externalSave(READY_ID, (d) => {
      d.details[0].batchSize = 100
    })
    const result = (await runCli(TimemachineRestore, [READY, '--to', v1, '--yes', '--json'], org, ws)).json<{result: RestoreResult}>()
      .result
    const log = await commits(ws)
    expect(log[0]).toContain(`[restore to ${v1}]`)
    expect(log[1]).toContain(`[before restore to ${v1}]`)
    expect(result.apply!.before.commit).toBe((await simpleGit(ws).revparse(['HEAD~1'])).trim())
    const history = (await runCli(TimemachineHistory, [READY, '--json'], org, ws)).json<{result: HistoryRow[]}>().result
    expect(history[1].change).toBe('0 added · 0 removed · 1 changed')
  })

  it('does nothing when live already matches', async () => {
    const {org, ws} = await setup()
    const res = await runCli(TimemachineRestore, [READY, '--to', 'HEAD', '--yes'], org, ws)
    expect(res.stdout).toContain('already matches')
    expect(org.saves()).toHaveLength(0)
  })

  it('writes nothing with --dry-run', async () => {
    const {org, ws, v1} = await setup()
    const before = await commits(ws)
    const res = await runCli(TimemachineRestore, [READY, '--to', v1, '--dry-run'], org, ws)
    expect(res.stdout).toContain('Dry run: nothing was written.')
    expect(org.saves()).toHaveLength(0)
    expect(await commits(ws)).toEqual(before)
  })

  it('requires --yes when it cannot ask', async () => {
    const {org, ws, v1} = await setup()
    const res = await runCli(TimemachineRestore, [READY, '--to', v1], org, ws)
    expect(res.exitCode).toBe(ExitCode.Usage)
    expect(res.stderr).toContain('--yes')
    expect(org.saves()).toHaveLength(0)
  })

  it('refuses when someone saves between the preview and the write', async () => {
    const {org, ws, v1} = await setup()
    let reads = 0
    org.beforeRead = (o) => {
      // 1st read: the preview the user reviews. 2nd read: the re-check inside the write path.
      if (++reads === 2) o.externalSave(READY_ID, (d) => (d.details[0].batchSize = 50))
    }
    const res = await runCli(TimemachineRestore, [READY, '--to', v1, '--yes'], org, ws)
    expect(res.exitCode).toBe(ExitCode.Conflict)
    expect(res.stderr).toContain('was changed in Copado while you were working on it. Nothing was saved.')
    expect(org.saves()).toHaveLength(0)
    expect(org.details.get(READY_ID)!.details[0].batchSize).toBe(50)
  })

  it('refuses a target Copado would reject, before writing', async () => {
    const {org, ws} = await setup()
    // Commit a snapshot whose document has no filter (as if taken from a broken state)
    const file = path.join(ws, '.timemachine', 'templates', 'tm-demo-accounts-new', 'template.json')
    const broken = fixtureResult<TemplateDetail>('detail-v2-ready')
    broken.details[0].limit = null
    fs.writeFileSync(file, JSON.stringify(broken))
    await simpleGit(ws).add(file).commit('broken snapshot')
    const res = await runCli(TimemachineRestore, [READY, '--to', 'HEAD', '--yes'], org, ws)
    expect(res.exitCode).toBe(ExitCode.Validation)
    expect(res.stderr).toContain('Max. Record Limit')
    expect(org.saves()).toHaveLength(0)
  })

  it('reports when Copado stores something other than what was sent', async () => {
    const {org, ws, v1} = await setup()
    org.normalise = (doc) => ({...doc, status: 'Active'})
    const res = await runCli(TimemachineRestore, [READY, '--to', v1, '--yes'], org, ws)
    expect(res.exitCode).toBe(ExitCode.Generic)
    expect(res.stderr).toContain('reading it back does not match')
    // what is actually live was still recorded
    expect((await commits(ws))[0]).toContain(`[restore to ${v1}]`)
  })

  it('lists filter/formula differences it does not write', async () => {
    const {org, ws, v1} = await setup()
    org.extras.filters[READY_ID] = [{uuid: 'u1', filterName: 'EMEA only', objects: []}]
    const res = await runCli(TimemachineRestore, [READY, '--to', v1, '--yes'], org, ws)
    expect(res.stdout).toContain('Not restored (separate Copado resources')
    expect(res.stdout).toContain('- advanced filter EMEA only removed')
    expect(org.extras.filters[READY_ID]).toHaveLength(1)
  })

  it('shows status in sync after a restore', async () => {
    const {org, ws, v1} = await setup()
    await runCli(TimemachineRestore, [READY, '--to', v1, '--yes'], org, ws)
    const rows = (await runCli(TimemachineStatus, ['--json'], org, ws)).json<{result: StatusRow[]}>().result
    expect(rows[0].snapshot).toBe('in-sync')
  })
})

describe('restore and the shared org lock', () => {
  async function withLock(lockFile: string) {
    const ctx = await setup()
    const configPath = path.join(ctx.ws, '.timemachine', 'config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    fs.writeFileSync(configPath, JSON.stringify({...config, orgBusyFile: lockFile}))
    return ctx
  }

  it('refuses while another tool holds the lock', async () => {
    const lock = path.join(tempDir(), '.org-busy')
    fs.writeFileSync(lock, 'mutant: deploy started 10:00\n')
    const {org, ws, v1} = await withLock(lock)
    const res = await runCli(TimemachineRestore, [READY, '--to', v1, '--yes'], org, ws)
    expect(res.exitCode).toBe(ExitCode.OrgBusy)
    expect(res.stderr).toContain('mutant: deploy started 10:00')
    expect(org.saves()).toHaveLength(0)
    expect(fs.readFileSync(lock, 'utf8')).toContain('mutant')
  })

  it('holds the lock during the write and always releases it', async () => {
    const lock = path.join(tempDir(), '.org-busy')
    const {org, ws, v1} = await withLock(lock)
    let seen = ''
    org.beforeSave = () => {
      seen = fs.readFileSync(lock, 'utf8')
    }
    await runCli(TimemachineRestore, [READY, '--to', v1, '--yes'], org, ws)
    expect(seen).toMatch(/^timemachine: restore TM Demo - Accounts New started \d{4}-/)
    expect(fs.existsSync(lock)).toBe(false)

    org.normalise = () => {
      throw new Error('boom')
    }
    await runCli(TimemachineRestore, [READY, '--to', 'HEAD~2', '--yes'], org, ws)
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('proceeds with --ignore-busy', async () => {
    const lock = path.join(tempDir(), '.org-busy')
    fs.writeFileSync(lock, 'stale\n')
    const {org, ws, v1} = await withLock(lock)
    const res = await runCli(TimemachineRestore, [READY, '--to', v1, '--yes', '--ignore-busy'], org, ws)
    expect(res.exitCode).toBe(0)
    expect(fs.existsSync(lock)).toBe(false)
  })
})
