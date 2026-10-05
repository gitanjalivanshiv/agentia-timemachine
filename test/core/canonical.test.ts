import {describe, expect, it} from 'vitest'

import type {TemplateDetail} from '../../src/agentia/schemas.js'
import {canonicalize, hashDocument, shortHash, sortKeysDeep, toStorageJson} from '../../src/core/canonical.js'
import {fixtureResult} from '../helpers.js'

const ready = () => fixtureResult<TemplateDetail>('detail-v2-ready')

describe('canonicalize', () => {
  it('sorts object keys at every level', () => {
    expect(JSON.stringify(canonicalize({b: 1, a: {d: 1, c: 2}}))).toBe('{"a":{"c":2,"d":1},"b":1}')
  })

  it('sorts keyed collections by their natural key', () => {
    const doc = {
      details: [
        {templateId: 'b', columns: [{name: 'Phone'}, {name: 'Fax'}]},
        {templateId: 'a', columns: []},
      ],
    }
    const out = canonicalize(doc) as typeof doc
    expect(out.details.map((d) => d.templateId)).toEqual(['a', 'b'])
    expect(out.details[1].columns.map((c) => c.name)).toEqual(['Fax', 'Phone'])
  })

  it('sorts filter rows numerically by order', () => {
    const doc = {details: [{templateId: 'x', rawFilters: [{order: 10}, {order: 2}, {order: 1}]}]}
    expect((canonicalize(doc) as typeof doc).details[0].rawFilters.map((r) => r.order)).toEqual([1, 2, 10])
  })

  it('keeps order where it may be meaningful (plain arrays, unkeyed objects)', () => {
    const doc = {details: [{templateId: 'x', filters: ["B = '2'", "A = '1'"], other: [{z: 1}, {a: 1}]}]}
    const out = canonicalize(doc) as typeof doc
    expect(out.details[0].filters).toEqual(["B = '2'", "A = '1'"])
    expect(out.details[0].other).toEqual([{z: 1}, {a: 1}])
  })

  it('does not sort a collection when an element lacks the key', () => {
    const doc = {details: [{templateId: 'x', columns: [{name: 'b'}, {label: 'no name'}, {name: 'a'}]}]}
    expect((canonicalize(doc) as typeof doc).details[0].columns).toEqual([{name: 'b'}, {label: 'no name'}, {name: 'a'}])
  })

  it('honours a custom key map', () => {
    const doc = {items: [{id: 2}, {id: 1}]}
    expect(canonicalize(doc, {items: 'id'})).toEqual({items: [{id: 1}, {id: 2}]})
  })
})

describe('hashDocument', () => {
  it('is stable across key order and column order', () => {
    const a = ready()
    const b = ready()
    b.details[0].columns.reverse()
    const reordered = JSON.parse(JSON.stringify(sortKeysDeep(b))) as TemplateDetail
    expect(hashDocument(reordered)).toBe(hashDocument(a))
  })

  it('changes when a value changes', () => {
    const a = ready()
    const b = ready()
    b.details[0].columns.find((c) => c.name === 'Fax')!.isSelected = false
    expect(hashDocument(b)).not.toBe(hashDocument(a))
  })

  it('matches the hash of the same document from another read', () => {
    expect(hashDocument(fixtureResult('detail-v2-ready'))).toBe(hashDocument(fixtureResult('detail-v2-ready')))
  })

  it('treats null as absent (Copado strips nulls on save)', () => {
    expect(hashDocument({a: null, b: {c: null, d: 1}})).toBe(hashDocument({b: {d: 1}}))
    expect(hashDocument({a: 0})).not.toBe(hashDocument({}))
    expect(hashDocument({a: []})).not.toBe(hashDocument({}))
  })

  it('returns hex sha-256 with a 12-char short form', () => {
    const h = hashDocument({})
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(shortHash(h)).toHaveLength(12)
  })
})

describe('toStorageJson', () => {
  it('sorts keys but keeps array order, with a trailing newline', () => {
    const json = toStorageJson({b: [3, 1, 2], a: {y: 1, x: 2}})
    expect(json).toBe('{\n  "a": {\n    "x": 2,\n    "y": 1\n  },\n  "b": [\n    3,\n    1,\n    2\n  ]\n}\n')
  })

  it('round-trips the document losslessly', () => {
    const doc = ready()
    expect(JSON.parse(toStorageJson(doc))).toEqual(doc)
  })
})
