import {describe, expect, it} from 'vitest'

import type {TemplateDetail} from '../../src/agentia/schemas.js'
import {hashDocument} from '../../src/core/canonical.js'
import {diffTemplates} from '../../src/core/differ.js'
import {MergeError, applyChanges, parsePath} from '../../src/core/merge.js'
import {fixtureResult} from '../helpers.js'

const ready = () => fixtureResult<TemplateDetail>('detail-v2-ready')
const col = (d: TemplateDetail, n: string) => d.details[0].columns.find((c) => c.name === n)!
const yoursFrom = (base: TemplateDetail, yours: TemplateDetail) => diffTemplates({detail: base}, {detail: yours})

describe('parsePath', () => {
  it('reads keyed, indexed and plain segments', () => {
    expect(parsePath('detail.details[templateId=a0U].columns[name=Fax].isSelected')).toEqual([
      {kind: 'prop', name: 'details'},
      {kind: 'key', key: 'templateId', value: 'a0U'},
      {kind: 'prop', name: 'columns'},
      {kind: 'key', key: 'name', value: 'Fax'},
      {kind: 'prop', name: 'isSelected'},
    ])
    expect(parsePath('detail.details[templateId=x].filters[2]').at(-1)).toEqual({kind: 'index', index: 2})
  })
})

describe('applyChanges (three-way merge)', () => {
  it('re-applies your change on top of theirs', () => {
    const base = ready()
    const theirs = ready()
    col(theirs, 'Description').isSelected = true
    const yours = ready()
    yours.details[0].batchSize = 100

    const merged = applyChanges(theirs, yoursFrom(base, yours))
    expect(col(merged, 'Description').isSelected).toBe(true)
    expect(merged.details[0].batchSize).toBe(100)
    expect(theirs.details[0].batchSize).toBe(200) // input untouched
  })

  it('adds and removes keyed elements and filter text', () => {
    const base = ready()
    const yours = ready()
    yours.details[0].rawFilters!.push({
      order: 2,
      fieldName: 'Billing Country-BillingCountry',
      operator: 'e',
      input: 'DE',
      finalValue: "BillingCountry = 'DE'",
    })
    yours.details[0].filters!.push("BillingCountry = 'DE'")
    yours.details[0].columns = yours.details[0].columns.filter((c) => c.name !== 'Fax')
    const theirs = ready()
    theirs.status = 'Active'

    const merged = applyChanges(theirs, yoursFrom(base, yours))
    expect(merged.status).toBe('Active')
    expect(merged.details[0].filters).toEqual(["Type = 'Customer'", "BillingCountry = 'DE'"])
    expect(merged.details[0].rawFilters!.map((r) => r.order)).toEqual([1, 2])
    expect(merged.details[0].columns.some((c) => c.name === 'Fax')).toBe(false)
  })

  it('reproduces "yours" exactly when theirs equals the base', () => {
    const base = ready()
    const yours = ready()
    col(yours, 'Website').isSelected = true
    yours.details[0].limit = 1000
    expect(hashDocument(applyChanges(base, yoursFrom(base, yours)))).toBe(hashDocument(yours))
  })

  it('refuses instead of guessing when the target moved', () => {
    const base = ready()
    const yours = ready()
    col(yours, 'Website').isSelected = true
    const theirs = ready()
    theirs.details[0].columns = theirs.details[0].columns.filter((c) => c.name !== 'Website')
    expect(() => applyChanges(theirs, yoursFrom(base, yours))).toThrow(MergeError)

    const added = ready()
    added.details[0].columns.push({name: 'Region__c', isSelected: true})
    expect(() => applyChanges(added, yoursFrom(base, added))).toThrow(/also added by someone else/)
  })
})
