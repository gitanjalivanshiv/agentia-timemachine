import {describe, expect, it} from 'vitest'

import {DEFAULT_KEYS} from '../../src/core/canonical.js'
import {ConfigSchema, defaultConfig, keyMap, slugify, uniqueSlug} from '../../src/store/config.js'

describe('slugify', () => {
  it.each([
    ['TM Demo - Accounts New', 'tm-demo-accounts-new'],
    ['TM Demo – Accounts', 'tm-demo-accounts'],
    ['  Ünïcode & Things!! ', 'unicode-things'],
    ['---', 'template'],
  ])('%s → %s', (name, slug) => {
    expect(slugify(name)).toBe(slug)
  })

  it('avoids collisions with other tracked templates', () => {
    const config = {...defaultConfig(), templates: [{id: 'a0U000000000001AAA', name: 'TM Demo – Accounts', slug: 'tm-demo-accounts'}]}
    expect(uniqueSlug(config, 'TM Demo - Accounts', 'a0U000000000009AAA')).toBe('tm-demo-accounts-009aaa')
    expect(uniqueSlug(config, 'TM Demo – Accounts', 'a0U000000000001AAA')).toBe('tm-demo-accounts')
  })
})

describe('config', () => {
  it('fills defaults and merges custom keys', () => {
    const config = ConfigSchema.parse({version: 1, keys: {'details[].columns': 'label'}})
    expect(config.templates).toEqual([])
    expect(keyMap(config)).toEqual({...DEFAULT_KEYS, 'details[].columns': 'label'})
  })

  it('rejects unknown versions', () => {
    expect(() => ConfigSchema.parse({version: 2})).toThrow()
  })
})
