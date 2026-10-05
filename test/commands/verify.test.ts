import {describe, expect, it} from 'vitest'

import type {TemplateDetail} from '../../src/agentia/schemas.js'
import TimemachineInit from '../../src/commands/timemachine/init.js'
import TimemachineVerify, {type VerifyEntry} from '../../src/commands/timemachine/verify.js'
import {compareWithEngine} from '../../src/core/verify.js'
import {runCli} from '../cli.js'
import {FakeOrg} from '../fake-org.js'
import {READY_ID, fixtureResult, tempRepo} from '../helpers.js'

const READY = 'TM Demo - Accounts New'

async function setup() {
  const org = FakeOrg.demo()
  const ws = tempRepo()
  await runCli(TimemachineInit, ['--track', READY], org, ws)
  return {org, ws}
}

describe('compareWithEngine', () => {
  it('is aligned when the engine uses the document', () => {
    const doc = fixtureResult<TemplateDetail>('detail-v2-ready')
    const engine = {...doc.details[0], columns: doc.details[0].columns.filter((c) => c.isSelected)}
    const result = compareWithEngine(doc, engine)
    expect(result.differences).toEqual([])
    expect(result.document.fields).toEqual(['AnnualRevenue', 'BillingCountry', 'Fax', 'Id', 'Industry', 'Name', 'Phone', 'Type'])
  })

  it('names fields, filters and limits that differ', () => {
    const doc = fixtureResult<TemplateDetail>('detail-v2-ready')
    const engine = structuredClone(doc.details[0])
    engine.columns.find((c) => c.name === 'Phone')!.isSelected = false
    engine.columns.find((c) => c.name === 'Website')!.isSelected = true
    engine.filters = ["Type = 'Partner'"]
    engine.limit = 10
    const {differences} = compareWithEngine(doc, engine)
    expect(differences.map((d) => d.aspect)).toEqual(['fields', 'filters', 'limit'])
    expect(differences[0].message).toBe(
      'The engine queries Website (not selected in the document) and skips Phone (selected in the document).',
    )
  })

  it('reports a missing engine configuration', () => {
    expect(compareWithEngine(fixtureResult('detail-v2-ready'), undefined).differences[0].aspect).toBe('missing')
  })
})

describe('timemachine verify', () => {
  it('confirms the engine uses the document, without printing record values', async () => {
    const {org, ws} = await setup()
    const res = await runCli(TimemachineVerify, [], org, ws)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain("✔ Copado's record selection uses the current v2 document")
    expect(res.stdout).toContain('8 fields: AnnualRevenue, BillingCountry, Fax, Id, Industry, Name, Phone, Type')
    expect(res.stdout).toContain("filter: Type = 'Customer' · limit 50,000 · batch 200")
    expect(res.stdout).toContain('3 records match in the source org today')
    const search = org.calls.find((c) => c.args[3] === 'search')!
    expect(search.args).toEqual([
      'cicd',
      'data',
      'records',
      'search',
      '--credential-id',
      expect.any(String),
      '--data-template-id',
      READY_ID,
      '--json',
    ])
  })

  it('fails and explains when the engine uses a different copy', async () => {
    const {org, ws} = await setup()
    org.engineView = (doc) => {
      doc.details[0].columns.find((c) => c.name === 'Phone')!.isSelected = false
      return doc
    }
    const res = await runCli(TimemachineVerify, ['--json'], org, ws)
    expect(res.exitCode).toBe(1)
    const [entry] = res.json<{result: VerifyEntry[]}>().result
    expect(entry).toMatchObject({aligned: false, matchingRecords: 3})
    expect(entry.differences[0].message).toContain('skips Phone')
  })
})
