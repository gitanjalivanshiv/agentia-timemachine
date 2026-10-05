import fs from 'node:fs'
import path from 'node:path'

import {describe, expect, it} from 'vitest'

import TimemachineInit from '../../src/commands/timemachine/init.js'
import TimemachineReport, {type ReportResult} from '../../src/commands/timemachine/report.js'
import TimemachineSnapshot from '../../src/commands/timemachine/snapshot.js'
import type {ReportData} from '../../src/core/report.js'
import {runCli} from '../cli.js'
import {FakeOrg} from '../fake-org.js'
import {READY_ID, tempRepo} from '../helpers.js'

const READY = 'TM Demo - Accounts New'

/** Extracts the embedded report data from the HTML. */
function embedded(html: string): ReportData {
  const json = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)![1]
  return JSON.parse(json) as ReportData
}

async function setup() {
  const org = FakeOrg.demo()
  const ws = tempRepo()
  await runCli(TimemachineInit, ['--track', READY, '--track', 'TM Demo – Accounts'], org, ws)
  await runCli(TimemachineSnapshot, ['--all', '--reason', 'baseline'], org, ws)
  org.externalSave(READY_ID, (d) => (d.details[0].columns.find((c) => c.name === 'Fax')!.isSelected = false))
  await runCli(TimemachineSnapshot, [READY, '--reason', 'Fax <out>'], org, ws)
  return {org, ws}
}

describe('timemachine report', () => {
  it('writes a self-contained, git-ignored HTML timeline', async () => {
    const {org, ws} = await setup()
    const res = await runCli(TimemachineReport, ['--json'], org, ws)
    const {file, versions, live} = res.json<{result: ReportResult}>().result
    expect(fs.realpathSync(file)).toBe(path.join(fs.realpathSync(ws), '.timemachine', 'report.html'))
    expect([versions, live]).toEqual([3, true])
    const html = fs.readFileSync(file, 'utf8')
    expect(html).not.toMatch(/<(link|script)[^>]+(src|href)=["']https?:/) // no external assets
    expect(fs.readFileSync(path.join(ws, '.timemachine', '.gitignore'), 'utf8')).toContain('report.html')

    const data = embedded(html)
    const ready = data.templates.find((t) => t.name === READY)!
    expect(ready.versions.map((v) => v.reason)).toEqual(['Fax <out>', 'baseline'])
    expect(ready.versions[0].statements).toEqual([{sign: '-', text: 'field Fax removed from Account'}])
    expect(ready.versions[0].restore).toMatch(/^agentia timemachine restore "TM Demo - Accounts New" --to [0-9a-f]{7}$/)
    expect(ready.versions[1].first).toBe(true)
    expect(ready.live).toMatchObject({state: 'in-sync', saveable: true, verify: {aligned: true, fields: 7, matchingRecords: 3}})
    expect(data.templates.find((t) => t.name !== READY)!.live?.fixes[0]).toContain('Add a main object filter')
  })

  it('shows changes made in Copado since the last snapshot', async () => {
    const {org, ws} = await setup()
    org.externalSave(READY_ID, (d) => (d.details[0].batchSize = 100))
    await runCli(TimemachineReport, [], org, ws)
    const data = embedded(fs.readFileSync(path.join(ws, '.timemachine', 'report.html'), 'utf8'))
    expect(data.templates.find((t) => t.name === READY)!.live).toMatchObject({
      state: 'drifted',
      drift: [{sign: '~', text: 'Account: batchSize 200 → 100'}],
    })
  })

  it('builds from git only with --offline, and never lets template text break out of the page', async () => {
    const {org, ws} = await setup()
    const calls = org.calls.length
    const out = path.join(ws, 'out', 'r.html')
    await runCli(TimemachineReport, ['--offline', '--output', out], org, ws)
    expect(org.calls.length).toBe(calls)
    const html = fs.readFileSync(out, 'utf8')
    expect(html).not.toContain('Fax <out>') // reason text is escaped inside the JSON
    expect(embedded(html).templates.every((t) => t.live === null)).toBe(true)
  })
})
