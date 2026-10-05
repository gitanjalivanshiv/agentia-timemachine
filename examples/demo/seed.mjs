#!/usr/bin/env node
/**
 * Creates a ready-to-version demo template in YOUR sandbox with the public Agentia CLI (writes to the org!).
 *
 *   node examples/demo/seed.mjs --credential-id <sandbox credential Id> [--name "TM Demo – Accounts"]
 *
 * Copado rejects saves of templates without a main object filter or record limit, so the seed sets both:
 * filter Type = 'Customer', Max. Record Limit 50000, and a small field selection. Safe to re-run: an existing
 * template with the same name is reused (template create is not atomic, so we always look it up first).
 */
import {execFileSync} from 'node:child_process'

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i > 0 ? process.argv[i + 1] : fallback
}
const credentialId = arg('--credential-id')
const name = arg('--name', 'TM Demo – Accounts')
if (!credentialId) {
  console.error('Usage: node examples/demo/seed.mjs --credential-id <credential Id> [--name "<template name>"]')
  process.exit(2)
}

function agentia(args, input) {
  let out
  try {
    out = execFileSync('agentia', [...args, '--json'], {encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore']})
  } catch (e) {
    out = e.stdout?.toString() ?? ''
  }
  const json = JSON.parse(out)
  if (json.error) throw new Error(`agentia ${args.slice(0, 4).join(' ')}: ${json.error.message.split('. Request')[0]}`)
  return json.result
}

const find = () => agentia(['cicd', 'data', 'template', 'list', '--name', name]).find((t) => t.name === name)
let template = find()
if (!template) {
  const apiName = name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
  try {
    agentia([
      'cicd',
      'data',
      'template',
      'create',
      '--credential-id',
      credentialId,
      '--template-name',
      name,
      '--api-name',
      apiName,
      '--main-object-api-name',
      'Account',
      '--main-object-label',
      'Account',
    ])
  } catch (e) {
    console.warn(`create reported an error (${e.message}); checking whether the template exists anyway…`)
  }
  template = find()
  if (!template) throw new Error('The template was not created. Check the credential and the Data Deployer licence.')
}

const doc = agentia(['cicd', 'data', 'template', 'get-detail', template.id])
const d = doc.details[0]
const keep = new Set(['Id', 'Name', 'Type', 'Industry', 'BillingCountry', 'Phone', 'Fax', 'AnnualRevenue'])
for (const c of d.columns) c.isSelected = keep.has(c.name)
d.rawFilters = [
  {
    order: 1,
    fieldName: 'Account Type-Type',
    fieldLabel: 'Account Type',
    fieldType: 'PICKLIST',
    operator: 'e',
    input: 'Customer',
    finalValue: "Type = 'Customer'",
    isValid: true,
  },
]
d.filters = ["Type = 'Customer'"]
d.limit = 50000
agentia(['cicd', 'data', 'template', 'save-detail', template.id, '--stdin'], JSON.stringify(doc))
console.log(`Seeded "${name}" (${template.id}). Next: agentia timemachine init --track "${name}" && agentia timemachine snapshot --all`)
