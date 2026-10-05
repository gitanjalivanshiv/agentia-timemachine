import {describe, expect, it} from 'vitest'

import {AgentiaClient} from '../../src/agentia/client.js'
import {SourceOrgLoginError, TemplateNotFoundError} from '../../src/agentia/errors.js'
import type {TemplateDetail} from '../../src/agentia/schemas.js'
import {findSaveBlockers, inspectTemplate, mapLimit} from '../../src/core/inspect.js'
import {NO_FILTER_ID, READY_ID, fixture, fixtureResult, scenario} from '../helpers.js'

const listed = (id: string) =>
  fixtureResult<{id: string}[]>('template-list').find((t) => t.id === id)! as Parameters<typeof inspectTemplate>[1]

describe('inspectTemplate', () => {
  it('reports a v2 template with filter and limit as saveable', async () => {
    const c = new AgentiaClient({runner: scenario('demo'), cwd: '/p'})
    const result = await inspectTemplate(c, listed(READY_ID))
    expect(result.format).toBe('v2')
    expect(result.saveBlockers).toEqual([])
    expect(result.detail?.templateName).toBe('TM Demo - Accounts New')
  })

  it('reports blockers for a template without a filter', async () => {
    const c = new AgentiaClient({runner: scenario('demo'), cwd: '/p'})
    const result = await inspectTemplate(c, listed(NO_FILTER_ID))
    expect(result.saveBlockers.map((b) => b.field)).toEqual(['filters', 'rawFilters'])
  })

  it('detects a legacy template: get-detail DAT-004 but get works', async () => {
    const c = new AgentiaClient({runner: scenario('legacy'), cwd: '/p'})
    const result = await inspectTemplate(c, listed(READY_ID))
    expect(result).toMatchObject({format: 'legacy', saveBlockers: []})
    expect(result.detail).toBeUndefined()
  })

  it('rethrows not-found when neither representation exists', async () => {
    const runner = scenario('legacy', {[`cicd data template get ${READY_ID}`]: fixture('error-dat-004')})
    const c = new AgentiaClient({runner, cwd: '/p'})
    await expect(inspectTemplate(c, listed(READY_ID))).rejects.toBeInstanceOf(TemplateNotFoundError)
  })

  it('does not mistake other errors for legacy', async () => {
    const runner = scenario('demo', {[`cicd data template get-detail ${READY_ID}`]: fixture('error-lgn-001')})
    const c = new AgentiaClient({runner, cwd: '/p'})
    await expect(inspectTemplate(c, listed(READY_ID))).rejects.toBeInstanceOf(SourceOrgLoginError)
    expect(runner.calls.map((x) => x.args[3])).not.toContain('get')
  })
})

describe('findSaveBlockers', () => {
  it('flags a null limit with the UI field to fix', () => {
    const blockers = findSaveBlockers(fixtureResult<TemplateDetail>('detail-v2-limit-null'))
    expect(blockers).toEqual([
      {path: 'details[0].limit', object: 'Account', field: 'limit', fix: expect.stringMatching(/Max\. Record Limit/)},
    ])
  })

  it('checks every object in the template', () => {
    const doc = fixtureResult<TemplateDetail>('detail-v2-ready')
    doc.details.push({...structuredClone(doc.details[0]), table: 'Contact', filters: [], rawFilters: [], limit: null})
    expect(findSaveBlockers(doc).map((b) => `${b.object}.${b.field}`)).toEqual(['Contact.filters', 'Contact.rawFilters', 'Contact.limit'])
  })
})

describe('mapLimit', () => {
  it('keeps order and never exceeds the limit', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, n * 3))
      inFlight--
      return n * 10
    })
    expect(out).toEqual([50, 10, 40, 20, 30])
    expect(peak).toBe(2)
  })

  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })
})
