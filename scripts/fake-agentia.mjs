#!/usr/bin/env node
/**
 * Stand-in for the `agentia` binary, so Time Machine runs without a Copado org (offline demo, judges, CI).
 *
 * Stateful mode (recommended): TM_FAKE_STATE=<dir>
 *   A small offline org kept in <dir>/org.json, seeded from the scrubbed real captures in fixtures/agentia.
 *   It behaves like the real org as measured in Phase 0: save-detail replaces the whole document, null keys in
 *   filter rows are dropped, documents with empty filters or no record limit are rejected (422 MDW-003), and
 *   every save bumps lastModified. `node scripts/fake-org.mjs` simulates a colleague editing in Copado.
 *
 * Scenario mode: TM_FAKE_SCENARIO=<file>  { "responses": { "<args without --json>": <fixture | {exitCode, stdout}> | [...] } }
 *   Replays canned responses (arrays are consumed in order across invocations).
 */
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'agentia', name), 'utf8'))
const key = process.argv
  .slice(2)
  .filter((a) => a !== '--json')
  .join(' ')
const args = process.argv.slice(2).filter((a) => a !== '--json')

function out(stdout, exitCode = 0) {
  process.stdout.write(typeof stdout === 'string' ? stdout : JSON.stringify(stdout, null, 2))
  process.exitCode = exitCode
}
const ok = (result) => out({result, status: 0, transactionId: 'offline'})
const fail = (statusCode, categories, message, exitCode = 1) =>
  out(
    {
      error: {name: 'CicdGatewayError', statusCode, categories, code: 'HANDLED_EXCEPTION', message: `${message}. Request: offline`},
      transactionId: 'offline',
    },
    exitCode,
  )

async function readStdin() {
  let body = ''
  for await (const chunk of process.stdin) body += chunk
  return body
}

if (process.env.TM_FAKE_STATE) {
  const dir = process.env.TM_FAKE_STATE
  const file = path.join(dir, 'org.json')
  fs.mkdirSync(dir, {recursive: true})
  if (!fs.existsSync(file)) {
    const templates = fixture('template-list.json').stdout.result
    const details = {
      [templates[1].id]: fixture('detail-v2-ready.json').stdout.result,
      [templates[0].id]: fixture('detail-v2-no-filter.json').stdout.result,
    }
    fs.writeFileSync(
      file,
      JSON.stringify({templates, details, filters: {}, formulas: {}, clock: Date.parse('2026-10-05T10:00:00Z')}, null, 2),
    )
  }
  const org = JSON.parse(fs.readFileSync(file, 'utf8'))
  const save = () => fs.writeFileSync(file, JSON.stringify(org, null, 2))

  if (key === '--version') out('@copado/agentia-cli/1.0.0-beta.2 offline-fake node\n')
  else if (key === 'cicd data template list') ok(org.templates)
  else if (args[3] === 'get-detail') {
    if (org.details[args[4]]) ok(org.details[args[4]])
    else fail(404, ['DAT-004'], `Failed to download template attachment: ${args[4]}`)
  } else if (args[3] === 'get') {
    const d = org.details[args[4]]
    if (d) ok({[args[4]]: {...d.details[0], columns: d.details[0].columns.filter((c) => c.isSelected)}})
    else fail(404, ['DAT-004'], 'Failed to download template attachment')
  } else if (key.startsWith('cicd data records search ')) {
    const id = args[args.indexOf('--data-template-id') + 1]
    const d = org.details[id]?.details[0]
    if (d) ok({totalRecords: 3, data: [], detail: {[id]: {...d, columns: d.columns.filter((c) => c.isSelected)}}})
    else fail(404, ['DAT-004'], 'Failed to download template attachment')
  } else if (key.startsWith('cicd data filter list ')) ok(org.filters[args[4]] ?? [])
  else if (key.startsWith('cicd data formula list ')) ok(org.formulas[args[4]] ?? [])
  else if (args[3] === 'save-detail') {
    const doc = JSON.parse(await readStdin())
    const problems = []
    doc.details.forEach((d, i) => {
      if (!d.filters?.length) problems.push(`[details.${i}.filters] (missing): Field required`)
      if (!d.rawFilters?.length) problems.push(`[details.${i}.rawFilters] (missing): Field required`)
      if (d.limit === null || d.limit === undefined) problems.push(`[details.${i}.limit] (missing): Field required`)
    })
    if (problems.length > 0) fail(422, ['MDW-003'], problems.join('\n'))
    else {
      for (const d of doc.details)
        d.rawFilters = d.rawFilters.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)))
      org.details[args[4]] = doc
      org.clock += 60_000
      const t = org.templates.find((x) => x.id === args[4])
      if (t) t.lastModified = new Date(org.clock).toISOString().replace('Z', '+0000')
      save()
      ok(true)
    }
  } else {
    console.error(`fake-agentia (offline org): "agentia ${key}" is not simulated`)
    process.exitCode = 70
  }
} else if (process.env.TM_FAKE_SCENARIO) {
  const scenarioPath = process.env.TM_FAKE_SCENARIO
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'))
  let entry = scenario.responses[key]
  if (entry === undefined) {
    console.error(`fake-agentia: no response for "agentia ${key}"`)
    process.exit(70)
  }
  if (Array.isArray(entry)) {
    const statePath = `${scenarioPath}.state.json`
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {}
    const index = Math.min(state[key] ?? 0, entry.length - 1)
    state[key] = index + 1
    fs.writeFileSync(statePath, JSON.stringify(state))
    entry = entry[index]
  }
  if (key.includes('--stdin')) await readStdin()
  const response = typeof entry === 'string' ? fixture(entry) : entry
  out(response.stdout, response.exitCode ?? 0)
} else {
  console.error('fake-agentia: set TM_FAKE_STATE=<dir> (offline org) or TM_FAKE_SCENARIO=<file>')
  process.exit(70)
}
