import fs from 'node:fs'
import path from 'node:path'

import {simpleGit} from 'simple-git'
import {describe, expect, it} from 'vitest'

import {ExitCode} from '../../src/agentia/errors.js'
import type {TemplateDetail} from '../../src/agentia/schemas.js'
import TimemachineEdit, {type EditResult} from '../../src/commands/timemachine/edit.js'
import TimemachineInit from '../../src/commands/timemachine/init.js'
import TimemachineSnapshot from '../../src/commands/timemachine/snapshot.js'
import TimemachineStatus from '../../src/commands/timemachine/status.js'
import {runCli} from '../cli.js'
import {FakeOrg} from '../fake-org.js'
import {READY_ID, tempDir, tempRepo} from '../helpers.js'

const READY = 'TM Demo - Accounts New'
const col = (doc: TemplateDetail, name: string) => doc.details[0].columns.find((c) => c.name === name)!

async function setup() {
  const org = FakeOrg.demo()
  const ws = tempRepo()
  await runCli(TimemachineInit, ['--track', READY], org, ws)
  await runCli(TimemachineSnapshot, ['--all'], org, ws)
  return {org, ws}
}

/** Edits a session's working copy in place, like a person in their editor. */
function editWorkingCopy(file: string, change: (doc: TemplateDetail) => void): void {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as TemplateDetail
  change(doc)
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
}

async function start(org: FakeOrg, ws: string, session: string): Promise<string> {
  const res = await runCli(TimemachineEdit, [READY, '--start', '--session', session, '--json'], org, ws)
  expect(res.exitCode).toBe(0)
  return res.json<{result: EditResult}>().result.session!.file
}

/** Writes a full edited document to a temp file (what an agent produces). */
function editedFile(org: FakeOrg, change: (doc: TemplateDetail) => void): string {
  const doc = structuredClone(org.details.get(READY_ID)!)
  change(doc)
  const file = path.join(tempDir(), 'edited.json')
  fs.writeFileSync(file, JSON.stringify(doc))
  return file
}

describe('edit sessions (--start / --apply / --abort)', () => {
  it('starts a session with a working copy, then saves it with a preview', async () => {
    const {org, ws} = await setup()
    const file = await start(org, ws, 'alice')
    expect(fs.realpathSync(file)).toBe(
      path.join(fs.realpathSync(ws), '.timemachine', '.lock', 'tm-demo-accounts-new', 'alice', 'edit.json'),
    )
    editWorkingCopy(file, (d) => (col(d, 'Description').isSelected = true))

    const res = await runCli(TimemachineEdit, [READY, '--apply', '--session', 'alice', '--yes', '--reason', 'need descriptions'], org, ws)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('+ field Description added to Account')
    expect(res.stdout).toMatch(/✔ Saved TM Demo - Accounts New and verified/)
    expect(res.stdout).toMatch(/Undo: agentia timemachine restore "TM Demo - Accounts New" --to [0-9a-f]{7}/)
    expect(col(org.details.get(READY_ID)!, 'Description').isSelected).toBe(true)
    expect(fs.existsSync(path.dirname(file))).toBe(false) // session cleaned up
    expect((await simpleGit(ws).raw(['log', '-1', '--format=%s'])).trim()).toMatch(/\[need descriptions\]$/)
  })

  it('blocks the second person and shows both sides (the two-terminal demo)', async () => {
    const {org, ws} = await setup()
    const alice = await start(org, ws, 'alice')
    const bob = await start(org, ws, 'bob')
    editWorkingCopy(alice, (d) => (col(d, 'Description').isSelected = true))
    editWorkingCopy(bob, (d) => (d.details[0].batchSize = 100))

    expect((await runCli(TimemachineEdit, [READY, '--apply', '--session', 'alice', '--yes'], org, ws)).exitCode).toBe(0)
    const savesBefore = org.saves().length

    const res = await runCli(TimemachineEdit, [READY, '--apply', '--session', 'bob', '--yes'], org, ws)
    expect(res.exitCode).toBe(ExitCode.Conflict)
    expect(res.stdout).toContain('✋ Blocked: TM Demo - Accounts New was changed in Copado after your edit started. Nothing was saved.')
    expect(res.stdout).toMatch(/Their changes \(base → live now\)\n\s+\+ field Description added to Account/)
    expect(res.stdout).toMatch(/Your changes \(base → yours\)\n\s+~ Account: batchSize 200 → 100/)
    expect(res.stdout).toContain('No overlapping changes')
    expect(res.stderr).toContain('Nothing was saved.')
    expect(org.saves()).toHaveLength(savesBefore)
    expect(org.details.get(READY_ID)!.details[0].batchSize).toBe(200)
    expect(fs.existsSync(bob)).toBe(true) // bob keeps his work
  })

  it('does not call different properties of the same field a conflict', async () => {
    const {org, ws} = await setup()
    const alice = await start(org, ws, 'alice')
    const bob = await start(org, ws, 'bob')
    editWorkingCopy(alice, (d) => (col(d, 'Fax').isSelected = false))
    editWorkingCopy(bob, (d) => (col(d, 'Fax').externalId = true))
    await runCli(TimemachineEdit, [READY, '--apply', '--session', 'alice', '--yes'], org, ws)

    const res = await runCli(TimemachineEdit, [READY, '--apply', '--session', 'bob', '--yes', '--json'], org, ws)
    expect(res.exitCode).toBe(ExitCode.Conflict)
    const {error} = res.json<{error: {code: string; theirs: string[]; yours: string[]; conflicts: {theirs: string; yours: string}[]}}>()
    expect(error.code).toBe('CONFLICT')
    expect(error.theirs).toEqual(['- field Fax removed from Account'])
    expect(error.yours).toEqual(['~ field Fax on Account: externalId false → true'])
    expect(error.conflicts).toEqual([])
  })

  it('treats edits to the very same property as a conflict', async () => {
    const {org, ws} = await setup()
    const alice = await start(org, ws, 'alice')
    const bob = await start(org, ws, 'bob')
    editWorkingCopy(alice, (d) => (d.details[0].batchSize = 50))
    editWorkingCopy(bob, (d) => (d.details[0].batchSize = 100))
    await runCli(TimemachineEdit, [READY, '--apply', '--session', 'alice', '--yes'], org, ws)

    const res = await runCli(TimemachineEdit, [READY, '--apply', '--session', 'bob', '--yes'], org, ws)
    expect(res.stdout).toMatch(/Conflicts\n\s+✖ theirs ~ Account: batchSize 200 → 50\n\s+yours\s+~ Account: batchSize 200 → 100/)
  })

  it('aborts, and guards against double starts or missing sessions', async () => {
    const {org, ws} = await setup()
    await start(org, ws, 'alice')
    const again = await runCli(TimemachineEdit, [READY, '--start', '--session', 'alice'], org, ws)
    expect(again.exitCode).toBe(ExitCode.Usage)
    expect(again.stderr).toContain('has been in progress since')
    expect((await runCli(TimemachineEdit, [READY, '--abort', '--session', 'alice'], org, ws)).stdout).toContain('Discarded the edit')
    const none = await runCli(TimemachineEdit, [READY, '--apply', '--session', 'alice'], org, ws)
    expect(none.exitCode).toBe(ExitCode.Usage)
    expect(none.stderr).toContain('--start')
  })

  it('shows edits in progress in status', async () => {
    const {org, ws} = await setup()
    await start(org, ws, 'alice')
    const res = await runCli(TimemachineStatus, [], org, ws)
    expect(res.stdout).toMatch(/✎ TM Demo - Accounts New: edit in progress \(session alice, Test User, since \d{4}-\d\d-\d\d \d\d:\d\d\)/)
  })

  it('names the session after the git user by default', async () => {
    const {org, ws} = await setup()
    const res = await runCli(TimemachineEdit, [READY, '--start', '--json'], org, ws)
    expect(res.json<{result: EditResult}>().result.session!.name).toBe('test-user')
  })

  it('says so and cleans up when nothing changed', async () => {
    const {org, ws} = await setup()
    const file = await start(org, ws, 'alice')
    const res = await runCli(TimemachineEdit, [READY, '--apply', '--session', 'alice', '--yes'], org, ws)
    expect(res.stdout).toContain('No changes. Nothing to save.')
    expect(org.saves()).toHaveLength(0)
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('edit --merge', () => {
  it("re-applies bob's change on top of alice's when nothing overlaps", async () => {
    const {org, ws} = await setup()
    const alice = await start(org, ws, 'alice')
    const bob = await start(org, ws, 'bob')
    editWorkingCopy(alice, (d) => (col(d, 'Description').isSelected = true))
    editWorkingCopy(bob, (d) => (d.details[0].batchSize = 100))
    await runCli(TimemachineEdit, [READY, '--apply', '--session', 'alice', '--yes'], org, ws)

    const res = await runCli(TimemachineEdit, [READY, '--apply', '--session', 'bob', '--merge', '--yes', '--json'], org, ws)
    expect(res.exitCode).toBe(0)
    expect(res.json<{result: EditResult}>().result).toMatchObject({outcome: 'applied', merged: true})
    const live = org.details.get(READY_ID)!
    expect(col(live, 'Description').isSelected).toBe(true) // alice's change kept
    expect(live.details[0].batchSize).toBe(100) // bob's change applied
  })

  it('still refuses when both changed the same thing', async () => {
    const {org, ws} = await setup()
    const alice = await start(org, ws, 'alice')
    const bob = await start(org, ws, 'bob')
    editWorkingCopy(alice, (d) => (d.details[0].batchSize = 50))
    editWorkingCopy(bob, (d) => (d.details[0].batchSize = 100))
    await runCli(TimemachineEdit, [READY, '--apply', '--session', 'alice', '--yes'], org, ws)

    const res = await runCli(TimemachineEdit, [READY, '--apply', '--session', 'bob', '--merge', '--yes'], org, ws)
    expect(res.exitCode).toBe(ExitCode.Conflict)
    expect(res.stderr).toContain('Cannot merge automatically')
    expect(org.details.get(READY_ID)!.details[0].batchSize).toBe(50)
  })

  it('suggests --merge when a blocked edit could be merged', async () => {
    const {org, ws} = await setup()
    const file = editedFile(org, (d) => (col(d, 'Description').isSelected = true))
    org.externalSave(READY_ID, (d) => (d.details[0].batchSize = 100))
    const blocked = await runCli(TimemachineEdit, [READY, '--file', file, '--yes', '--json'], org, ws)
    expect(blocked.json<{error: {mergeable: boolean; hint: string}}>().error).toMatchObject({
      mergeable: true,
      hint: expect.stringContaining('--merge'),
    })
    expect((await runCli(TimemachineEdit, [READY, '--file', file, '--yes', '--merge'], org, ws)).exitCode).toBe(0)
    expect(org.details.get(READY_ID)!.details[0].batchSize).toBe(100)
    expect(col(org.details.get(READY_ID)!, 'Description').isSelected).toBe(true)
  })
})

describe('edit --file (agents)', () => {
  it('saves when live still matches the last snapshot', async () => {
    const {org, ws} = await setup()
    const file = editedFile(org, (d) => (col(d, 'Description').isSelected = true))
    const res = await runCli(TimemachineEdit, [READY, '--file', file, '--yes', '--json'], org, ws)
    const result = res.json<{result: EditResult}>().result
    expect(result).toMatchObject({outcome: 'applied', base: {source: expect.stringMatching(/^snapshot [0-9a-f]{7}$/)}})
    expect(result.statements!.map((s) => s.text)).toEqual(['field Description added to Account'])
    expect(result.undo).toMatch(/--to [0-9a-f]{7}$/)
  })

  it("is blocked when someone changed the template after the agent's snapshot", async () => {
    const {org, ws} = await setup()
    const file = editedFile(org, (d) => (col(d, 'Description').isSelected = true))
    org.externalSave(READY_ID, (d) => (col(d, 'Phone').isSelected = false))
    const res = await runCli(TimemachineEdit, [READY, '--file', file, '--yes'], org, ws)
    expect(res.exitCode).toBe(ExitCode.Conflict)
    expect(res.stdout).toContain('- field Phone removed from Account')
    expect(org.saves()).toHaveLength(0) // the colleague's save bypasses our CLI; we wrote nothing
  })

  it('can be based on live explicitly', async () => {
    const {org, ws} = await setup()
    org.externalSave(READY_ID, (d) => (col(d, 'Phone').isSelected = false))
    const file = editedFile(org, (d) => (col(d, 'Description').isSelected = true))
    expect((await runCli(TimemachineEdit, [READY, '--file', file, '--base', 'live', '--yes'], org, ws)).exitCode).toBe(0)
  })

  it('catches a save that lands between the preview and the write', async () => {
    const {org, ws} = await setup()
    const file = editedFile(org, (d) => (col(d, 'Description').isSelected = true))
    let reads = 0
    org.beforeRead = (o) => {
      // read 1: early check (matches). read 2: re-check inside the write path → someone saved just now.
      if (++reads === 2) o.externalSave(READY_ID, (d) => (d.details[0].batchSize = 75))
    }
    const res = await runCli(TimemachineEdit, [READY, '--file', file, '--yes'], org, ws)
    expect(res.exitCode).toBe(ExitCode.Conflict)
    expect(res.stdout).toContain('~ Account: batchSize 200 → 75')
    expect(org.details.get(READY_ID)!.details[0].batchSize).toBe(75)
  })

  it('rejects invalid documents before touching the org', async () => {
    const {org, ws} = await setup()
    const bad = path.join(tempDir(), 'bad.json')
    fs.writeFileSync(bad, '{ not json')
    const res = await runCli(TimemachineEdit, [READY, '--file', bad, '--yes'], org, ws)
    expect(res.exitCode).toBe(ExitCode.Usage)
    expect(res.stderr).toContain('not valid JSON')

    const other = editedFile(org, (d) => (d.templateId = 'a0U000000000001AAA'))
    expect((await runCli(TimemachineEdit, [READY, '--file', other, '--yes'], org, ws)).stderr).toContain('belongs to template')
    expect(org.saves()).toHaveLength(0)
  })

  it('refuses documents Copado would reject, with the UI fix', async () => {
    const {org, ws} = await setup()
    const file = editedFile(org, (d) => (d.details[0].limit = null))
    const res = await runCli(TimemachineEdit, [READY, '--file', file, '--yes'], org, ws)
    expect(res.exitCode).toBe(ExitCode.Validation)
    expect(res.stderr).toContain('Max. Record Limit')
    expect(org.saves()).toHaveLength(0)
  })

  it('previews only with --dry-run, and needs --yes without a terminal', async () => {
    const {org, ws} = await setup()
    const file = editedFile(org, (d) => (col(d, 'Description').isSelected = true))
    expect((await runCli(TimemachineEdit, [READY, '--file', file, '--dry-run'], org, ws)).stdout).toContain('Dry run')
    const noYes = await runCli(TimemachineEdit, [READY, '--file', file], org, ws)
    expect(noYes.exitCode).toBe(ExitCode.Usage)
    expect(org.saves()).toHaveLength(0)
  })

  it('points non-interactive callers to --file', async () => {
    const {org, ws} = await setup()
    const res = await runCli(TimemachineEdit, [READY], org, ws)
    expect(res.exitCode).toBe(ExitCode.Usage)
    expect(res.stderr).toContain('--file')
  })
})
