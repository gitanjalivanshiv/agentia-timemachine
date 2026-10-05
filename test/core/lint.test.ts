import {describe, expect, it} from 'vitest'

import type {TemplateDetail} from '../../src/agentia/schemas.js'
import {filterField, lintDocument, RULES} from '../../src/core/lint.js'
import {fixtureResult} from '../helpers.js'

const ready = () => fixtureResult<TemplateDetail>('detail-v2-ready')
const ids = (doc: TemplateDetail, opts = {}) => lintDocument(doc, opts).map((f) => f.rule)
const d0 = (doc: TemplateDetail) => doc.details[0]

describe('lint rules', () => {
  it('have unique ids and names', () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length)
    expect(new Set(RULES.map((r) => r.name)).size).toBe(RULES.length)
  })

  it('accept the real ready template apart from advisory findings', () => {
    expect(lintDocument(ready()).filter((f) => f.severity === 'error')).toEqual([])
  })

  it('TM001: no main object filter (real capture)', () => {
    expect(ids(fixtureResult('detail-v2-no-filter'))).toContain('TM001')
  })

  it('TM002: no record limit (real capture)', () => {
    expect(ids(fixtureResult('detail-v2-limit-null'))).toContain('TM002')
  })

  it('TM003: high-volume object with a large limit, configurable', () => {
    expect(ids(ready())).toContain('TM003')
    expect(ids(ready(), {highVolumeLimit: 50_000})).not.toContain('TM003')
    expect(ids(ready(), {highVolumeObjects: ['Lead']})).not.toContain('TM003')
  })

  it('TM004: matched by Salesforce Id only, until an external Id is set', () => {
    const doc = ready()
    expect(ids(doc)).toContain('TM004')
    d0(doc).columns.find((c) => c.name === 'Name')!.externalId = true
    expect(ids(doc)).not.toContain('TM004')
  })

  it('TM005: duplicate fields', () => {
    const doc = ready()
    d0(doc).columns.push({...d0(doc).columns[1]})
    expect(lintDocument(doc).find((f) => f.rule === 'TM005')?.message).toBe('Account.Name appears more than once.')
  })

  it('TM006: unquoted text value (the "Type = Partner" incident)', () => {
    const doc = ready()
    Object.assign(d0(doc).rawFilters![0], {input: 'Partner', finalValue: 'Type = Partner'})
    d0(doc).filters = ['Type = Partner']
    const finding = lintDocument(doc).find((f) => f.rule === 'TM006')!
    expect(finding.severity).toBe('error')
    expect(finding.fix).toContain("Type = 'Partner'")
  })

  it('TM007: filter text out of sync with filter rows', () => {
    const doc = ready()
    d0(doc).filters = ["Type = 'Other'"]
    expect(ids(doc)).toContain('TM007')
  })

  it('TM008: invalid filter row', () => {
    const doc = ready()
    d0(doc).rawFilters![0].isValid = false
    expect(ids(doc)).toContain('TM008')
  })

  it('TM009: filter on a field that is not in the schema', () => {
    const doc = ready()
    d0(doc).columns = d0(doc).columns.filter((c) => c.name !== 'Type')
    expect(lintDocument(doc).find((f) => f.rule === 'TM009')?.message).toContain('uses Type')
  })

  it('TM010: batch size out of range', () => {
    const doc = ready()
    d0(doc).batchSize = 500
    expect(ids(doc)).toContain('TM010')
  })

  it('TM011: personal data without anonymisation is info only', () => {
    const f = lintDocument(ready()).find((x) => x.rule === 'TM011')!
    expect(f.severity).toBe('info')
    expect(f.message).toContain('Phone, Fax')
  })

  it('can disable rules by id or name, and sorts errors first', () => {
    const doc = fixtureResult<TemplateDetail>('detail-v2-no-filter')
    expect(ids(doc, {disable: ['TM001', 'pii-not-anonymised']})).not.toEqual(expect.arrayContaining(['TM001', 'TM011']))
    expect(lintDocument(doc)[0].severity).toBe('error')
  })

  it('reads the API name from a filter fieldName', () => {
    expect(filterField('Account Type-Type')).toBe('Type')
    expect(filterField('Billing Country-BillingCountry')).toBe('BillingCountry')
    expect(filterField(undefined)).toBeUndefined()
  })
})
