import {describe, expect, it} from 'vitest'

import type {TemplateDetail, TemplateObjectDetail} from '../../src/agentia/schemas.js'
import {describeChanges, fmt, formatStatementSummary, summariseStatements} from '../../src/core/describe.js'
import {diffTemplates, formatSummary, lcs, summarise, type Change} from '../../src/core/differ.js'
import {fixtureResult} from '../helpers.js'

const ready = () => fixtureResult<TemplateDetail>('detail-v2-ready')
const account = (doc: TemplateDetail): TemplateObjectDetail => doc.details[0]
const col = (doc: TemplateDetail, name: string) => account(doc).columns.find((c) => c.name === name)!

/** Diff two detail documents and return the human statements. */
function say(before: unknown, after: unknown, extrasBefore: unknown = {}, extrasAfter: unknown = {}): string[] {
  return describeChanges(diffTemplates({detail: before, extras: extrasBefore}, {detail: after, extras: extrasAfter})).map(
    (s) => `${s.sign} ${s.text}`,
  )
}
function raw(before: unknown, after: unknown): Change[] {
  return diffTemplates({detail: before}, {detail: after})
}

const contact = (doc: TemplateDetail): TemplateObjectDetail => ({
  ...structuredClone(account(doc)),
  templateId: 'a0U000000000077AAA',
  templateName: 'TM Demo – Contacts',
  table: 'Contact',
  columns: [
    {name: 'Id', type: 'id', isSelected: true},
    {name: 'Email', type: 'email', isSelected: true},
    {name: 'Phone', type: 'phone', isSelected: false},
  ],
})

describe('differ: identity and noise', () => {
  it('finds nothing between identical documents', () => {
    expect(raw(ready(), ready())).toEqual([])
  })

  it('treats null and an absent key as the same (Copado strips nulls on save)', () => {
    const after = ready()
    Object.assign(account(after).rawFilters![0], {dateInput: null, numberInput: null})
    expect(raw(ready(), after)).toEqual([])
  })

  it('ignores key order entirely', () => {
    const after = JSON.parse(JSON.stringify(ready(), Object.keys(ready()).reverse())) as TemplateDetail
    expect(raw(ready(), {...after, ...ready()})).toEqual([])
  })
})

describe('differ: fields', () => {
  it('reports a deselected field as removed (real Fax capture)', () => {
    expect(say(ready(), fixtureResult('detail-v2-fax-deselected'))).toEqual(['- field Fax removed from Account'])
    expect(raw(ready(), fixtureResult('detail-v2-fax-deselected'))).toEqual([
      expect.objectContaining({
        type: 'removed',
        path: 'detail.details[templateId=a0U000000000004AAA].columns[name=Fax].isSelected',
        schemaPath: 'details[].columns[].isSelected',
        entity: {kind: 'field', object: 'Account', name: 'Fax'},
        before: true,
        after: false,
      }),
    ])
  })

  it('reports a newly selected field as added', () => {
    const after = ready()
    col(after, 'Description').isSelected = true
    expect(say(ready(), after)).toEqual(['+ field Description added to Account'])
  })

  it('reports a new selected column as added, a new unselected one as available', () => {
    const after = ready()
    account(after).columns.push(
      {name: 'Region__c', type: 'picklist', isSelected: true},
      {name: 'Tier__c', type: 'picklist', isSelected: false},
    )
    expect(say(ready(), after)).toEqual(['+ field Region__c added to Account', '+ field Tier__c now available on Account (not selected)'])
  })

  it('reports a dropped column', () => {
    const after = ready()
    account(after).columns = account(after).columns.filter((c) => c.name !== 'Phone')
    expect(say(ready(), after)).toEqual(['- field Phone removed from Account'])
  })

  it('groups property changes of one field into one statement', () => {
    const after = ready()
    Object.assign(col(after, 'Name'), {externalId: true, anonymizerType: {type: 'Name'}})
    expect(say(ready(), after)).toEqual(['~ field Name on Account: type None → Name, externalId false → true'])
  })

  it('reports a field that is selected and changed as two statements', () => {
    const after = ready()
    Object.assign(col(after, 'Description'), {isSelected: true, externalId: true})
    expect(say(ready(), after)).toEqual(['+ field Description added to Account', '~ field Description on Account: externalId false → true'])
  })

  it('reports a reordered column as moved, not removed + added', () => {
    const after = ready()
    const cols = account(after).columns
    cols.push(
      cols.splice(
        cols.findIndex((c) => c.name === 'Id'),
        1,
      )[0],
    )
    const changes = raw(ready(), after)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({type: 'moved', entity: {kind: 'field', name: 'Id'}})
    expect(say(ready(), after)[0]).toMatch(/^↕ field Id moved in Account \(1 → \d+\)$/)
  })

  it('collapses many moves into one line', () => {
    const after = ready()
    account(after).columns.reverse()
    expect(say(ready(), after)).toEqual([expect.stringMatching(/^↕ \d+ fields reordered in Account$/)])
  })
})

describe('differ: filters', () => {
  const editFilter = (doc: TemplateDetail, finalValue: string, input: string, operator = 'e') => {
    Object.assign(account(doc).rawFilters![0], {finalValue, input, operator})
    account(doc).filters = [finalValue]
  }

  it('shows an edited filter as one line using its condition text', () => {
    const after = ready()
    editFilter(after, "Type IN ('Customer','Partner')", 'Customer,Partner', 'in')
    expect(say(ready(), after)).toEqual(["~ filter on Account: Type = 'Customer' → Type IN ('Customer','Partner')"])
  })

  it('still records every underlying change for agents', () => {
    const after = ready()
    editFilter(after, "Type IN ('Customer','Partner')", 'Customer,Partner', 'in')
    const [statement] = describeChanges(diffTemplates({detail: ready()}, {detail: after}))
    expect(statement.changes.map((c) => c.property ?? c.schemaPath).sort()).toEqual([
      'details[].filters[]',
      'details[].filters[]',
      'finalValue',
      'input',
      'operator',
    ])
  })

  it('reports an added and a removed filter row', () => {
    const after = ready()
    account(after).rawFilters!.push({
      order: 2,
      fieldName: 'Billing Country-BillingCountry',
      operator: 'e',
      input: 'Germany',
      finalValue: "BillingCountry = 'Germany'",
    })
    account(after).filters!.push("BillingCountry = 'Germany'")
    expect(say(ready(), after)).toEqual(["+ filter on Account: BillingCountry = 'Germany' added"])
    expect(say(after, ready())).toEqual(["- filter on Account: BillingCountry = 'Germany' removed"])
  })

  it('describes a filter row change without finalValue by its properties', () => {
    const after = ready()
    account(after).rawFilters![0].isValid = false
    expect(say(ready(), after)).toEqual(["~ filter on Account (Type = 'Customer'): isValid true → false"])
  })

  it('shows filter text changes on their own when no row changed', () => {
    const after = ready()
    account(after).filters = ["Type = 'Customer'", 'Name != null']
    expect(say(ready(), after)).toEqual(['+ filter on Account: Name != null added'])
  })
})

describe('differ: objects, settings and relations', () => {
  it('describes object settings in plain words', () => {
    const after = ready()
    account(after).limit = null
    account(after).batchSize = 100
    expect(say(ready(), after)).toEqual(['~ Account: batchSize 200 → 100', '~ Account: limit 50000 → (not set)'])
  })

  it('names nested settings by their path inside the object', () => {
    const after = ready()
    account(after).externalIdGeneration!.generateExternalId = true
    expect(say(ready(), after)).toEqual(['~ Account: externalIdGeneration.generateExternalId false → true'])
  })

  it('reports an added object with its selected field count', () => {
    const after = ready()
    after.details.push(contact(after))
    expect(say(ready(), after)).toEqual(['+ object Contact added (2 fields selected)'])
    expect(say(after, ready())).toEqual(['- object Contact removed (2 fields selected)'])
  })

  it('attributes changes inside a second object to that object', () => {
    const before = ready()
    before.details.push(contact(before))
    const after = structuredClone(before)
    after.details[1].columns.find((c) => c.name === 'Phone')!.isSelected = true
    expect(say(before, after)).toEqual(['+ field Phone added to Contact'])
  })

  it('reports parent and child relations with arrows', () => {
    const after = ready()
    account(after).parentTemplates = [{templateId: 'a0U000000000088AAA', templateName: 'TM Demo – Users'}]
    account(after).childTemplates = [{templateId: 'a0U000000000077AAA', templateName: 'Contact'}]
    expect(say(ready(), after)).toEqual(['+ relation Account → TM Demo – Users added', '+ relation Contact → Account added'])
    expect(say(after, ready())).toEqual(['- relation Account → TM Demo – Users removed', '- relation Contact → Account removed'])
  })

  it('reports template-level changes', () => {
    const after = ready()
    after.status = 'Active'
    after.templateName = 'Renamed'
    expect(say(ready(), after)).toEqual([
      '~ template: status Inactive → Active',
      '~ template: templateName TM Demo - Accounts New → Renamed',
    ])
  })

  it('falls back to a path line for unknown structures, never hiding a change', () => {
    const before = {...ready(), futureSection: {deep: {value: 1}}}
    const after = {...ready(), futureSection: {deep: {value: 2}}, brandNew: [1, 2]}
    expect(say(before, after)).toEqual(['+ template: brandNew added ([1,2])', '~ template: futureSection.deep.value 1 → 2'])
  })
})

describe('differ: extras', () => {
  it('reports advanced filters by name, keyed by uuid', () => {
    const before = {advancedFilters: [{uuid: 'u1', filterName: 'EMEA only', objects: []}]}
    const after = {
      advancedFilters: [
        {uuid: 'u1', filterName: 'EMEA + APAC', objects: []},
        {uuid: 'u2', filterName: 'Active', objects: []},
      ],
    }
    expect(say(ready(), ready(), before, after)).toEqual([
      '+ advanced filter Active added',
      '~ advanced filter EMEA + APAC: filterName EMEA only → EMEA + APAC',
    ])
  })

  it('reports matching formulas per object, keyed by id', () => {
    const before = {recordMatchingFormulas: {Account: []}}
    const after = {recordMatchingFormulas: {Account: [{id: 'f1', name: 'Name + Website', objectApiName: 'Account', hashFormula: false}]}}
    expect(say(ready(), ready(), before, after)).toEqual(['+ matching formula Name + Website on Account added'])
    const edited = {recordMatchingFormulas: {Account: [{id: 'f1', name: 'Name + Website', objectApiName: 'Account', hashFormula: true}]}}
    expect(say(ready(), ready(), after, edited)).toEqual(['~ matching formula Name + Website on Account: hashFormula false → true'])
  })
})

describe('differ: options and summaries', () => {
  it('hides ignored schema paths', () => {
    const after = ready()
    col(after, 'Name').anonymizerType = {type: 'Name'}
    col(after, 'Fax').isSelected = false
    const changes = diffTemplates({detail: ready()}, {detail: after}, {ignore: ['details[].columns[].anonymizerType']})
    expect(describeChanges(changes).map((s) => s.text)).toEqual(['field Fax removed from Account'])
  })

  it('uses a configurable key map', () => {
    const before = {items: [{code: 'A', v: 1}]}
    const after = {items: [{code: 'A', v: 2}]}
    expect(diffTemplates({detail: before}, {detail: after}, {keys: {items: 'code'}})[0].path).toBe('detail.items[code=A].v')
  })

  it('summarises statements, not raw paths', () => {
    const after = ready()
    Object.assign(account(after).rawFilters![0], {finalValue: "Type = 'Partner'", input: 'Partner'})
    account(after).filters = ["Type = 'Partner'"]
    col(after, 'Fax').isSelected = false
    col(after, 'Description').isSelected = true
    const statements = describeChanges(diffTemplates({detail: ready()}, {detail: after}))
    expect(formatStatementSummary(summariseStatements(statements))).toBe('1 added · 1 removed · 1 changed')
    expect(formatSummary(summarise(statements.flatMap((s) => s.changes)))).toBe('2 added · 2 removed · 2 changed')
  })

  it('lists statements in a stable order: object, kind, type', () => {
    const after = ready()
    after.details.push(contact(after))
    col(after, 'Fax').isSelected = false
    after.status = 'Active'
    expect(say(ready(), after)).toEqual([
      '~ template: status Inactive → Active',
      '- field Fax removed from Account',
      '+ object Contact added (2 fields selected)',
    ])
  })

  it('formats values compactly', () => {
    expect([fmt(undefined), fmt(null), fmt(''), fmt('x'), fmt(3), fmt(false), fmt({a: 1})]).toEqual([
      '∅',
      '(not set)',
      '""',
      'x',
      '3',
      'false',
      '{"a":1}',
    ])
    expect(fmt('y'.repeat(200))).toHaveLength(200)
    expect(fmt({long: 'z'.repeat(200)})).toHaveLength(78)
  })

  it('computes a longest common subsequence', () => {
    expect(lcs(['a', 'b', 'c', 'd'], ['b', 'a', 'c', 'd'])).toHaveLength(3)
    expect(lcs([], ['a'])).toEqual([])
  })
})
