import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {describe, expect, it} from 'vitest'

import {OrgBusyError} from '../../src/agentia/errors.js'
import {checkOrgBusy, resolveLockPath, withOrgLock} from '../../src/core/org-lock.js'
import {tempDir} from '../helpers.js'

describe('org lock', () => {
  it('expands ~ and is optional', async () => {
    expect(resolveLockPath('~/hackathon/.org-busy')).toBe(path.join(os.homedir(), 'hackathon', '.org-busy'))
    expect(resolveLockPath(undefined)).toBeUndefined()
    expect(await withOrgLock(undefined, 'x', async () => 42)).toBe(42)
  })

  it('creates parent folders, writes the action and removes the file', async () => {
    const file = path.join(tempDir(), 'nested', '.org-busy')
    const inside = await withOrgLock(file, 'restore T', async () => fs.readFileSync(file, 'utf8'))
    expect(inside).toMatch(/^timemachine: restore T started /)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('reports an existing lock with its contents', () => {
    const file = path.join(tempDir(), '.org-busy')
    fs.writeFileSync(file, 'mutant: promote started\n')
    expect(() => checkOrgBusy(file)).toThrow(OrgBusyError)
    expect(checkOrgBusy(file, true)).toBe('mutant: promote started\n')
  })
})
