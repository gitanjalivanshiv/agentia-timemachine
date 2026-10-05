import fs from 'node:fs'
import path from 'node:path'

import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js'
import {simpleGit} from 'simple-git'
import {describe, expect, it} from 'vitest'

import type {TemplateDetail} from '../src/agentia/schemas.js'
import TimemachineDiff from '../src/commands/timemachine/diff.js'
import TimemachineEdit from '../src/commands/timemachine/edit.js'
import TimemachineHistory from '../src/commands/timemachine/history.js'
import TimemachineInit from '../src/commands/timemachine/init.js'
import TimemachineLint from '../src/commands/timemachine/lint.js'
import TimemachinePlan from '../src/commands/timemachine/plan.js'
import TimemachineRestore from '../src/commands/timemachine/restore.js'
import TimemachineSnapshot from '../src/commands/timemachine/snapshot.js'
import TimemachineStatus from '../src/commands/timemachine/status.js'
import TimemachineVerify from '../src/commands/timemachine/verify.js'
import {INSTRUCTIONS, createServer, type TimemachineRunner} from '../src/mcp/server.js'
import {runCli} from './cli.js'
import {FakeOrg} from './fake-org.js'
import {READY_ID, tempRepo} from './helpers.js'

const READY = 'TM Demo - Accounts New'
const COMMANDS = {
  status: TimemachineStatus,
  snapshot: TimemachineSnapshot,
  history: TimemachineHistory,
  diff: TimemachineDiff,
  edit: TimemachineEdit,
  restore: TimemachineRestore,
  lint: TimemachineLint,
  plan: TimemachinePlan,
  verify: TimemachineVerify,
} as const

/** Runs the CLI commands in-process (instead of spawning agentia) against a FakeOrg. */
function inProcessRunner(org: FakeOrg, ws: string): TimemachineRunner & {calls: string[][]} {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    const command = COMMANDS[args[0] as keyof typeof COMMANDS]
    const res = await runCli(command, [...args.slice(1), '--json'], org, ws)
    return {exitCode: res.exitCode, envelope: JSON.parse(res.stdout)}
  }
  return Object.assign(run, {calls})
}

async function connect() {
  const org = FakeOrg.demo()
  const ws = tempRepo()
  await runCli(TimemachineInit, ['--track', READY], org, ws)
  const run = inProcessRunner(org, ws)
  const server = createServer({root: ws, run, version: '0.0.0-test'})
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({name: 'test', version: '1.0.0'})
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const tool = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({name, arguments: args})) as CallToolResult
  return {org, ws, client, tool, run}
}

const text = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
const json = <T = Record<string, unknown>>(r: CallToolResult): T => JSON.parse((r.content.at(-1) as {text: string}).text) as T

function baseDocument(ws: string): TemplateDetail {
  return JSON.parse(
    fs.readFileSync(path.join(ws, '.timemachine', 'templates', 'tm-demo-accounts-new', 'template.json'), 'utf8'),
  ) as TemplateDetail
}

describe('MCP server', () => {
  it('announces tools with read/write annotations and instructions', async () => {
    const {client} = await connect()
    const {tools} = await client.listTools()
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(Object.keys(byName).sort()).toEqual(
      [
        'tm_diff',
        'tm_edit_apply',
        'tm_edit_preview',
        'tm_history',
        'tm_lint',
        'tm_plan',
        'tm_restore_apply',
        'tm_restore_preview',
        'tm_snapshot',
        'tm_status',
        'tm_verify',
      ].sort(),
    )
    for (const name of ['tm_status', 'tm_diff', 'tm_history', 'tm_lint', 'tm_plan', 'tm_verify', 'tm_edit_preview', 'tm_restore_preview']) {
      expect(byName[name].annotations?.readOnlyHint, name).toBe(true)
    }
    for (const name of ['tm_edit_apply', 'tm_restore_apply']) expect(byName[name].annotations?.destructiveHint, name).toBe(true)
    expect(client.getInstructions()).toBe(INSTRUCTIONS)
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(['safe_template_change'])
  })

  it('reads status and snapshots', async () => {
    const {tool} = await connect()
    expect(json<{snapshot: string}[]>(await tool('tm_status'))[0].snapshot).toBe('never')
    const snap = await tool('tm_snapshot', {templates: [READY], reason: 'before change'})
    expect(json<{snapshots: {outcome: string}[]}>(snap).snapshots[0].outcome).toBe('created')
    expect(json<{snapshot: string}[]>(await tool('tm_status'))[0].snapshot).toBe('in-sync')
  })

  it('edits only through preview → confirmed apply', async () => {
    const {org, ws, tool} = await connect()
    await tool('tm_snapshot', {templates: [READY]})
    const doc = baseDocument(ws)
    doc.details[0].columns.find((c) => c.name === 'Website')!.isSelected = true

    const preview = await tool('tm_edit_preview', {template: READY, document: doc})
    expect(text(preview)).toContain('+ field Website added to Account')
    const {previewId} = json<{previewId: string}>(preview)
    expect(org.saves()).toHaveLength(0)

    const refused = await tool('tm_edit_apply', {previewId: 'made-up', confirmed: true})
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('PREVIEW_REQUIRED')

    const applied = await tool('tm_edit_apply', {previewId, confirmed: true, reason: 'add Website'})
    expect(applied.isError).toBeFalsy()
    expect(text(applied)).toMatch(/Saved and verified \(hash [0-9a-f]{12}\)\. Undo: agentia timemachine restore/)
    expect(org.details.get(READY_ID)!.details[0].columns.find((c) => c.name === 'Website')!.isSelected).toBe(true)

    const again = await tool('tm_edit_apply', {previewId, confirmed: true})
    expect(text(again)).toContain('PREVIEW_REQUIRED') // a preview is good for one apply only
  })

  it('rejects an apply without confirmed=true at the protocol level', async () => {
    const {tool} = await connect()
    const res = await tool('tm_edit_apply', {previewId: 'x', confirmed: false})
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/confirmed|invalid/i)
  })

  it('returns the three-way view when someone changed the template', async () => {
    const {org, ws, tool} = await connect()
    await tool('tm_snapshot', {templates: [READY]})
    const doc = baseDocument(ws)
    doc.details[0].columns.find((c) => c.name === 'Website')!.isSelected = true
    org.externalSave(READY_ID, (d) => (d.details[0].batchSize = 100))

    const preview = await tool('tm_edit_preview', {template: READY, document: doc})
    expect(preview.isError).toBe(true)
    const error = json<{code: string; theirs: string[]; yours: string[]; mergeable: boolean}>(preview)
    expect(error).toMatchObject({
      code: 'CONFLICT',
      theirs: ['~ Account: batchSize 200 → 100'],
      yours: ['+ field Website added to Account'],
      mergeable: true,
    })

    const merged = await tool('tm_edit_preview', {template: READY, document: doc, merge: true})
    expect(merged.isError).toBeFalsy()
    await tool('tm_edit_apply', {previewId: json<{previewId: string}>(merged).previewId, confirmed: true})
    const live = org.details.get(READY_ID)!.details[0]
    expect([live.batchSize, live.columns.find((c) => c.name === 'Website')!.isSelected]).toEqual([100, true])
  })

  it('restores through preview → confirmed apply, and diffs and history work', async () => {
    const {org, ws, tool} = await connect()
    await tool('tm_snapshot', {templates: [READY], reason: 'v1'})
    const v1 = (await simpleGit(ws).revparse(['--short', 'HEAD'])).trim()
    org.externalSave(READY_ID, (d) => (d.details[0].columns.find((c) => c.name === 'Fax')!.isSelected = false))

    expect(text(await tool('tm_diff', {template: READY}))).toContain('- field Fax removed from Account')
    expect(json<{reason: string}[]>(await tool('tm_history', {template: READY}))[0].reason).toBe('v1')

    const preview = await tool('tm_restore_preview', {template: READY, to: v1})
    expect(text(preview)).toContain('+ field Fax added to Account')
    const res = await tool('tm_restore_apply', {previewId: json<{previewId: string}>(preview).previewId, confirmed: true})
    expect(text(res)).toContain('Saved and verified')
    expect(org.details.get(READY_ID)!.details[0].columns.find((c) => c.name === 'Fax')!.isSelected).toBe(true)
  })

  it('lints and plans', async () => {
    const {tool} = await connect()
    await tool('tm_snapshot', {all: true})
    expect(json<{counts: {error: number}}>(await tool('tm_lint')).counts.error).toBe(0)
    expect(json<{changes: number}>(await tool('tm_plan')).changes).toBe(0)
  })

  it('offers the safe_template_change prompt', async () => {
    const {client} = await connect()
    const prompt = await client.getPrompt({name: 'safe_template_change', arguments: {template: READY, request: 'add Website'}})
    const msg = prompt.messages[0].content as {text: string}
    expect(msg.text).toContain(`Change the Copado data template "${READY}": add Website`)
    expect(msg.text).toContain('tm_edit_preview')
  })
})
