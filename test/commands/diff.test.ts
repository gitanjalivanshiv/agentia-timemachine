import {simpleGit} from 'simple-git'
import {describe, expect, it} from 'vitest'

import {ExitCode} from '../../src/agentia/errors.js'
import {FakeRunner, type FakeResponse} from '../../src/agentia/runner.js'
import TimemachineDiff, {type DiffResult} from '../../src/commands/timemachine/diff.js'
import TimemachineInit from '../../src/commands/timemachine/init.js'
import TimemachineSnapshot from '../../src/commands/timemachine/snapshot.js'
import {runCli} from '../cli.js'
import {READY_ID, VERSION_OK, fixture, ok, tempRepo} from '../helpers.js'

const READY = 'TM Demo - Accounts New'

function org(detail: FakeResponse[]): FakeRunner {
  return new FakeRunner({
    '--version': VERSION_OK,
    'cicd data template list': fixture('template-list'),
    [`cicd data template get-detail ${READY_ID}`]: detail,
    [`cicd data filter list ${READY_ID}`]: fixture('filter-list-empty'),
    'cicd data formula list Account': ok([]),
  })
}

/** Workspace with one snapshot of the ready template; live then returns `liveAfter`. */
async function workspace(liveAfter: FakeResponse[] = [fixture('detail-v2-ready')]) {
  const runner = org([fixture('detail-v2-ready'), ...liveAfter])
  const ws = tempRepo()
  await runCli(TimemachineInit, ['--track', READY], runner, ws)
  await runCli(TimemachineSnapshot, ['--all'], runner, ws)
  return {runner, ws}
}

describe('timemachine diff', () => {
  it('shows last snapshot → live in template language', async () => {
    const {runner, ws} = await workspace([fixture('detail-v2-fax-deselected')])
    const res = await runCli(TimemachineDiff, [READY], runner, ws)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toMatch(/TM Demo - Accounts New [0-9a-f]{7} → live/)
    expect(res.stdout).toContain('- field Fax removed from Account')
    expect(res.stdout).toContain('0 added · 1 removed · 0 changed')
  })

  it('says so when nothing changed', async () => {
    const {runner, ws} = await workspace()
    const res = await runCli(TimemachineDiff, [READY, '--exit-code'], runner, ws)
    expect(res.stdout).toContain('No differences.')
    expect(res.exitCode).toBe(0)
  })

  it('exits 1 with --exit-code when there are differences', async () => {
    const {runner, ws} = await workspace([fixture('detail-v2-fax-deselected')])
    expect((await runCli(TimemachineDiff, [READY, '--exit-code'], runner, ws)).exitCode).toBe(1)
  })

  it('returns structured statements and raw changes with --json', async () => {
    const {runner, ws} = await workspace([fixture('detail-v2-fax-deselected')])
    const result = (await runCli(TimemachineDiff, [READY, '--json'], runner, ws)).json<{status: number; result: DiffResult}>()
    expect(result.status).toBe(0)
    expect(result.result).toMatchObject({
      template: {id: READY_ID, slug: 'tm-demo-accounts-new'},
      to: {ref: 'live', label: 'live'},
      identical: false,
      summary: {added: 0, removed: 1, changed: 0, moved: 0},
    })
    expect(result.result.statements[0]).toMatchObject({
      type: 'removed',
      sign: '-',
      text: 'field Fax removed from Account',
      entity: {kind: 'field', name: 'Fax'},
    })
    expect(result.result.statements[0].changes[0]).toMatchObject({
      path: expect.stringContaining('columns[name=Fax].isSelected'),
      before: true,
      after: false,
    })
  })

  it('compares two snapshots without calling Copado', async () => {
    const {runner, ws} = await workspace([fixture('detail-v2-fax-deselected')])
    await runCli(TimemachineSnapshot, ['--all', '--reason', 'Fax out'], runner, ws)
    const calls = runner.calls.length
    const res = await runCli(TimemachineDiff, [READY, '--from', 'HEAD~1', '--to', 'HEAD'], runner, ws)
    expect(res.stdout).toContain('- field Fax removed from Account')
    expect(runner.calls.length).toBe(calls)
    const reverse = await runCli(TimemachineDiff, [READY, '--from', 'HEAD', '--to', 'HEAD~1'], runner, ws)
    expect(reverse.stdout).toContain('+ field Fax added to Account')
  })

  it('accepts the short refs that history prints', async () => {
    const {runner, ws} = await workspace([fixture('detail-v2-fax-deselected')])
    const short = (await simpleGit(ws).raw(['log', '-1', '--format=%h'])).trim()
    const res = await runCli(TimemachineDiff, [READY, '--from', short, '--json'], runner, ws)
    expect(res.json<{result: DiffResult}>().result.from.label).toBe(short.slice(0, 7))
  })

  it('renders Markdown for pull-request comments', async () => {
    const {runner, ws} = await workspace([fixture('detail-v2-fax-deselected')])
    const res = await runCli(TimemachineDiff, [READY, '--format', 'md'], runner, ws)
    expect(res.stdout).toMatch(
      /^#### TM Demo - Accounts New\n\n`[0-9a-f]{7}` → `live` · \*\*0 added · 1 removed · 0 changed\*\*\n\n```diff\n- field Fax removed from Account\n```/,
    )
  })

  it('explains unknown refs and templates without snapshots', async () => {
    const {runner, ws} = await workspace()
    const bad = await runCli(TimemachineDiff, [READY, '--from', 'nope123'], runner, ws)
    expect(bad.exitCode).toBe(ExitCode.NotFound)
    expect(bad.stderr).toContain('timemachine history')

    const fresh = tempRepo()
    await runCli(TimemachineInit, ['--track', READY], runner, fresh)
    const none = await runCli(TimemachineDiff, [READY], runner, fresh)
    expect(none.exitCode).toBe(ExitCode.NotFound)
    expect(none.stderr).toContain('has no snapshots yet')
  })
})
