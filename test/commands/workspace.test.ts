import fs from 'node:fs'
import path from 'node:path'

import {simpleGit} from 'simple-git'
import {describe, expect, it} from 'vitest'

import {ExitCode} from '../../src/agentia/errors.js'
import {FakeRunner, type FakeResponse} from '../../src/agentia/runner.js'
import TimemachineHistory, {type HistoryRow} from '../../src/commands/timemachine/history.js'
import TimemachineInit from '../../src/commands/timemachine/init.js'
import TimemachineSnapshot, {type SnapshotCommandResult} from '../../src/commands/timemachine/snapshot.js'
import TimemachineStatus, {type StatusRow} from '../../src/commands/timemachine/status.js'
import {runCli} from '../cli.js'
import {NO_FILTER_ID, READY_ID, VERSION_OK, fixture, ok, tempDir, tempRepo} from '../helpers.js'

const READY = 'TM Demo - Accounts New'

/** An org with the two demo templates; `detail` controls what get-detail of READY returns (in order). */
function org(detail: FakeResponse[] = [fixture('detail-v2-ready')], extra: Record<string, FakeResponse | FakeResponse[]> = {}): FakeRunner {
  return new FakeRunner({
    '--version': VERSION_OK,
    'cicd data template list': fixture('template-list'),
    [`cicd data template get-detail ${READY_ID}`]: detail,
    [`cicd data template get-detail ${NO_FILTER_ID}`]: fixture('detail-v2-no-filter'),
    [`cicd data filter list ${READY_ID}`]: fixture('filter-list-empty'),
    [`cicd data filter list ${NO_FILTER_ID}`]: fixture('filter-list-empty'),
    'cicd data formula list Account': ok([]),
    ...extra,
  })
}

async function initialised(runner: FakeRunner, track = [READY]): Promise<string> {
  const ws = tempRepo()
  const res = await runCli(
    TimemachineInit,
    track.flatMap((t) => ['--track', t]),
    runner,
    ws,
  )
  expect(res.exitCode).toBe(0)
  return ws
}

const log = async (ws: string) => (await simpleGit(ws).raw(['log', '--format=%s'])).trim().split('\n')

describe('timemachine init', () => {
  it('creates the workspace, tracks templates and commits the config', async () => {
    const ws = tempRepo()
    const res = await runCli(TimemachineInit, ['--track', READY], org(), ws)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('tracking TM Demo - Accounts New → .timemachine/templates/tm-demo-accounts-new/')
    const config = JSON.parse(fs.readFileSync(path.join(ws, '.timemachine', 'config.json'), 'utf8'))
    expect(config.templates).toEqual([{id: READY_ID, name: READY, slug: 'tm-demo-accounts-new'}])
    expect(fs.readFileSync(path.join(ws, '.timemachine', '.gitignore'), 'utf8')).toContain('.lock/')
    expect(await log(ws)).toEqual(['tm: init (track TM Demo - Accounts New)'])
  })

  it('initialises git in a plain folder and needs no org without --track', async () => {
    const ws = tempDir()
    const home = process.env.HOME
    process.env.HOME = tempDir() // identity from a throwaway ~/.gitconfig (HOME is not a GIT_* var)
    fs.writeFileSync(path.join(process.env.HOME, '.gitconfig'), '[user]\n\tname = Home User\n\temail = home@example.com\n')
    try {
      const res = await runCli(TimemachineInit, ['--json'], undefined, ws)
      expect(res.exitCode).toBe(0)
      expect(res.json<{result: {created: boolean; gitInitialised: boolean; tracked: unknown[]}}>().result).toMatchObject({
        created: true,
        gitInitialised: true,
        tracked: [],
      })
      expect(await log(ws)).toEqual(['tm: init (initialise workspace)'])
    } finally {
      process.env.HOME = home
    }
  })

  it('is idempotent', async () => {
    const runner = org()
    const ws = await initialised(runner)
    const again = await runCli(TimemachineInit, ['--track', READY, '--json'], runner, ws)
    expect(again.json<{result: {created: boolean; commit?: string}}>().result).toMatchObject({created: false})
    expect(again.json<{result: {commit?: string}}>().result.commit).toBeUndefined()
    expect(await log(ws)).toHaveLength(1)
  })
})

describe('timemachine snapshot', () => {
  it('commits the first snapshot, then reports unchanged without committing', async () => {
    const runner = org()
    const ws = await initialised(runner)

    const first = await runCli(TimemachineSnapshot, ['--all', '--reason', 'baseline'], runner, ws)
    expect(first.exitCode).toBe(0)
    expect(first.stdout).toMatch(/✔ TM Demo - Accounts New \([0-9a-f]{12}\) first snapshot commit [0-9a-f]{7}/)

    const dir = path.join(ws, '.timemachine', 'templates', 'tm-demo-accounts-new')
    expect(fs.readdirSync(dir).sort()).toEqual(['extras.json', 'meta.json', 'template.json'])
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
    expect(meta).toMatchObject({templateId: READY_ID, name: READY, mainObject: 'Account', agentiaVersion: '1.0.0-beta.2'})
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'extras.json'), 'utf8'))).toEqual({
      advancedFilters: [],
      recordMatchingFormulas: {Account: []},
    })

    const second = await runCli(TimemachineSnapshot, ['--all'], runner, ws)
    expect(second.stdout).toMatch(/= TM Demo - Accounts New \([0-9a-f]{12}\) unchanged/)
    const subjects = await log(ws)
    expect(subjects).toHaveLength(2)
    expect(subjects[0]).toMatch(/^tm: snapshot TM Demo - Accounts New \([0-9a-f]{12}\) by Test User \[baseline\]$/)
  })

  it('records a change with a summary, and history shows the timeline', async () => {
    const runner = org([fixture('detail-v2-ready'), fixture('detail-v2-fax-deselected')])
    const ws = await initialised(runner)
    await runCli(TimemachineSnapshot, ['--all'], runner, ws)
    const changed = await runCli(TimemachineSnapshot, [READY, '--reason', 'Fax no longer deployed'], runner, ws)
    expect(changed.stdout).toMatch(/✔ TM Demo - Accounts New \([0-9a-f]{12}\) 0 added · 1 removed · 0 changed commit/)

    const history = await runCli(TimemachineHistory, [READY, '--json'], runner, ws)
    const rows = history.json<{result: HistoryRow[]}>().result
    expect(rows.map((r) => [r.change, r.reason, r.author])).toEqual([
      ['0 added · 1 removed · 0 changed', 'Fax no longer deployed', 'Test User'],
      ['first snapshot', null, 'Test User'],
    ])
    const human = await runCli(TimemachineHistory, ['tm-demo-accounts-new'], runner, ws)
    expect(human.stdout).toMatch(
      /[0-9a-f]{7}\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+Test User\s+[0-9a-f]{12}\s+0 added · 1 removed · 0 changed\s+Fax no longer deployed/,
    )
  })

  it('writes nothing with --dry-run', async () => {
    const runner = org()
    const ws = await initialised(runner)
    const res = await runCli(TimemachineSnapshot, ['--all', '--dry-run', '--json'], runner, ws)
    expect(res.json<{result: SnapshotCommandResult}>().result.snapshots[0]).toMatchObject({outcome: 'created', dryRun: true})
    expect(fs.existsSync(path.join(ws, '.timemachine', 'templates'))).toBe(false)
    expect(await log(ws)).toHaveLength(1)
  })

  it('starts tracking a template named on the command line', async () => {
    const runner = org()
    const ws = await initialised(runner, [])
    await runCli(TimemachineSnapshot, ['TM Demo – Accounts'], runner, ws)
    const config = JSON.parse(fs.readFileSync(path.join(ws, '.timemachine', 'config.json'), 'utf8'))
    expect(config.templates.map((t: {slug: string}) => t.slug)).toEqual(['tm-demo-accounts'])
  })

  it('refuses a legacy template with the convert-old hint and exit 5', async () => {
    const runner = org([fixture('error-dat-004')], {[`cicd data template get ${READY_ID}`]: fixture('graph-legacy')})
    const ws = await initialised(runner)
    const res = await runCli(TimemachineSnapshot, ['--all'], runner, ws)
    expect(res.exitCode).toBe(ExitCode.Legacy)
    expect(res.stdout).toContain(`agentia cicd data template convert-old ${READY_ID}`)
  })

  it('needs a template or --all, and a workspace', async () => {
    const runner = org()
    const ws = await initialised(runner)
    expect((await runCli(TimemachineSnapshot, [], runner, ws)).exitCode).toBe(ExitCode.Usage)
    const outside = await runCli(TimemachineSnapshot, ['--all'], runner, tempDir())
    expect(outside.exitCode).toBe(ExitCode.Usage)
    expect(outside.stderr).toContain('agentia timemachine init')
  })
})

describe('timemachine status in a workspace', () => {
  it('goes from never snapshotted → in sync → drifted', async () => {
    const runner = org([
      fixture('detail-v2-ready'),
      fixture('detail-v2-ready'),
      fixture('detail-v2-ready'),
      fixture('detail-v2-fax-deselected'),
    ])
    const ws = await initialised(runner)
    const state = async () => (await runCli(TimemachineStatus, ['--json'], runner, ws)).json<{result: StatusRow[]}>().result[0].snapshot

    expect(await state()).toBe('never')
    await runCli(TimemachineSnapshot, ['--all'], runner, ws)
    expect(await state()).toBe('in-sync')
    const drifted = await runCli(TimemachineStatus, [], runner, ws)
    expect(drifted.stdout).toMatch(/TM Demo - Accounts New\s+drifted since [0-9a-f]{12}\s+v2\s+ready/)
    expect(drifted.stdout).toContain('changed in Copado since the last snapshot')
  })

  it('reports only tracked templates, and tracked ones deleted in Copado', async () => {
    const runner = org()
    const ws = await initialised(runner)
    const gone = JSON.parse(fs.readFileSync(path.join(ws, '.timemachine', 'config.json'), 'utf8'))
    gone.templates.push({id: 'a0U000000000099AAA', name: 'Deleted one', slug: 'deleted-one'})
    fs.writeFileSync(path.join(ws, '.timemachine', 'config.json'), JSON.stringify(gone))
    const rows = (await runCli(TimemachineStatus, ['--json'], runner, ws)).json<{result: StatusRow[]}>().result
    expect(rows.map((r) => [r.name, r.format])).toEqual([
      [READY, 'v2'],
      ['Deleted one', 'missing'],
    ])
  })
})
