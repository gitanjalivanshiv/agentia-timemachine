import fs from 'node:fs'
import path from 'node:path'

import {describe, expect, it} from 'vitest'

import {GitError, NotInitialisedError} from '../../src/agentia/errors.js'
import {Store, parseTrailers} from '../../src/store/store.js'
import {tempDir, tempRepo} from '../helpers.js'

async function newStore(): Promise<Store> {
  const store = new Store(tempRepo())
  store.saveConfig({version: 1, templates: [], keys: {}, ignore: []})
  return store
}

const meta = {templateId: 'a0U000000000004AAA', name: 'T', hash: 'h1', extrasHash: 'e1', fetchedAt: 'now', sourceCommand: 'x'}

describe('Store', () => {
  it('is found from any subfolder and required with a clear error otherwise', async () => {
    const store = await newStore()
    const sub = path.join(store.root, 'a', 'b')
    fs.mkdirSync(sub, {recursive: true})
    expect(fs.realpathSync(Store.find(sub)!.root)).toBe(fs.realpathSync(store.root))
    expect(() => Store.require(tempDir())).toThrow(NotInitialisedError)
  })

  it('writes and reads a snapshot', async () => {
    const store = await newStore()
    const paths = store.writeSnapshot('t', {detail: {b: 1, a: [2, 1]}, extras: {}, meta})
    expect(paths).toEqual([
      '.timemachine/templates/t/template.json',
      '.timemachine/templates/t/extras.json',
      '.timemachine/templates/t/meta.json',
    ])
    expect(fs.readFileSync(path.join(store.root, paths[0]), 'utf8')).toBe('{\n  "a": [\n    2,\n    1\n  ],\n  "b": 1\n}\n')
    expect(store.readSnapshot('t')).toMatchObject({detail: {a: [2, 1], b: 1}, meta: {hash: 'h1'}})
    expect(store.readSnapshot('missing')).toBeUndefined()
  })

  it('commits only the given paths, leaving other staged work alone', async () => {
    const store = await newStore()
    fs.writeFileSync(path.join(store.root, 'unrelated.txt'), 'wip')
    await store.git.add('unrelated.txt')
    const paths = store.writeSnapshot('t', {detail: {}, extras: {}, meta})
    const sha = await store.commit(
      [...paths, store.rel('config.json')],
      'tm: snapshot T (h1) by Test User\n\nTemplate-Hash: h1\nChange: first snapshot\n',
    )
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    const committed = await store.git.raw(['show', '--name-only', '--format=', 'HEAD'])
    expect(committed).not.toContain('unrelated.txt')
    expect((await store.git.status()).staged).toContain('unrelated.txt')
  })

  it('reads history with trailers, newest first', async () => {
    const store = await newStore()
    for (const [hash, change] of [
      ['h1', 'first snapshot'],
      ['h2', '0 added · 0 removed · 1 changed'],
    ]) {
      const paths = store.writeSnapshot('t', {detail: {hash}, extras: {}, meta: {...meta, hash}})
      await store.commit(
        paths,
        `tm: snapshot T (${hash}) by Test User [r-${hash}]\n\nTemplate-Hash: ${hash}\nChange: ${change}\nReason: r-${hash}\n`,
      )
    }
    const history = await store.history('t')
    expect(history.map((h) => h.trailers['Template-Hash'])).toEqual(['h2', 'h1'])
    expect(history[0]).toMatchObject({author: 'Test User', trailers: {Change: '0 added · 0 removed · 1 changed', Reason: 'r-h2'}})
    expect(await store.history('t', 1)).toHaveLength(1)
    expect(JSON.parse((await store.showAt(history[1].commit, '.timemachine/templates/t/template.json'))!)).toEqual({hash: 'h1'})
    expect(await store.showAt(history[1].commit, 'nope.json')).toBeUndefined()
  })

  it('returns empty history in a repo without commits', async () => {
    expect(await (await newStore()).history('t')).toEqual([])
  })

  it('explains a missing git identity', async () => {
    const store = new Store(tempDir())
    await store.ensureRepo() // fresh repo, no local identity
    const home = process.env.HOME
    process.env.HOME = tempDir() // no ~/.gitconfig
    process.env.XDG_CONFIG_HOME = process.env.HOME
    try {
      await expect(store.gitUser()).rejects.toBeInstanceOf(GitError)
    } finally {
      process.env.HOME = home
      delete process.env.XDG_CONFIG_HOME
    }
  })
})

describe('parseTrailers', () => {
  it('reads Key: value lines and ignores prose', () => {
    expect(parseTrailers('Some text\n\nTemplate-Id: a0U\nChange: 1 added · 0 removed · 0 changed\nnot a trailer')).toEqual({
      'Template-Id': 'a0U',
      Change: '1 added · 0 removed · 0 changed',
    })
  })
})
