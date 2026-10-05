#!/usr/bin/env node
/**
 * Simulates a colleague changing a template directly in Copado, in the offline org (TM_FAKE_STATE).
 *
 *   node scripts/fake-org.mjs select <Field>       select a field on "TM Demo - Accounts New"
 *   node scripts/fake-org.mjs deselect <Field>
 *   node scripts/fake-org.mjs batch-size <n>
 *   node scripts/fake-org.mjs reset                 back to the seeded state
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = process.env.TM_FAKE_STATE
if (!dir) {
  console.error('Set TM_FAKE_STATE to the offline org folder.')
  process.exit(2)
}
const file = path.join(dir, 'org.json')
const [action, value] = process.argv.slice(2)
if (action === 'reset') {
  fs.rmSync(file, {force: true})
  console.log('Offline org reset (re-seeded on next use).')
  process.exit(0)
}
if (!fs.existsSync(file)) {
  console.error('The offline org is not initialised yet: run any timemachine command first.')
  process.exit(2)
}
const org = JSON.parse(fs.readFileSync(file, 'utf8'))
const template = org.templates.find((t) => t.name === (process.env.TM_FAKE_TEMPLATE ?? 'TM Demo - Accounts New'))
const doc = org.details[template.id]
const d = doc.details[0]
if (action === 'select' || action === 'deselect') d.columns.find((c) => c.name === value).isSelected = action === 'select'
else if (action === 'batch-size') d.batchSize = Number(value)
else {
  console.error(`Unknown action "${action}". Use select|deselect <Field>, batch-size <n> or reset.`)
  process.exit(2)
}
org.clock += 60_000
template.lastModified = new Date(org.clock).toISOString().replace('Z', '+0000')
fs.writeFileSync(file, JSON.stringify(org, null, 2))
console.log(`Someone changed "${template.name}" in Copado: ${action} ${value ?? ''}`.trim())
