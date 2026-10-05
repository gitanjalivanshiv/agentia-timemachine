import {describe, expect, it} from 'vitest'

import {AgentiaClient, compareVersions, isSalesforceId, mapAgentiaError, parseValidationProblems} from '../../src/agentia/client.js'
import {
  AgentiaCommandError,
  AgentiaUsageError,
  AgentiaVersionError,
  AuthMissingError,
  ExitCode,
  GatewayError,
  SourceOrgLoginError,
  TemplateAmbiguousError,
  TemplateNotFoundError,
  TemplateValidationError,
  UnexpectedOutputError,
} from '../../src/agentia/errors.js'
import {FakeRunner} from '../../src/agentia/runner.js'
import {NO_FILTER_ID, READY_ID, VERSION_OK, fixture, fixtureResult, ok} from '../helpers.js'

const client = (responses: ConstructorParameters<typeof FakeRunner>[0]) => {
  const runner = new FakeRunner(responses)
  return {runner, client: new AgentiaClient({runner, cwd: '/project/root', timeoutMs: 1000})}
}

describe('AgentiaClient: reads', () => {
  it('lists templates, always with --json, from the project root', async () => {
    const {runner, client: c} = client({'cicd data template list': fixture('template-list')})
    const templates = await c.listTemplates()
    expect(templates.map((t) => t.name)).toEqual(['TM Demo – Accounts', 'TM Demo - Accounts New'])
    expect(runner.calls[0]).toMatchObject({args: ['cicd', 'data', 'template', 'list', '--json'], cwd: '/project/root'})
  })

  it('passes list filters as the documented flags', async () => {
    const {runner, client: c} = client({'cicd data template list --name Accounts --main-object Account --no-active': ok([])})
    await c.listTemplates({name: 'Accounts', mainObject: 'Account', active: false})
    expect(runner.calls[0].args).toEqual([
      'cicd',
      'data',
      'template',
      'list',
      '--name',
      'Accounts',
      '--main-object',
      'Account',
      '--no-active',
      '--json',
    ])
  })

  it('unwraps {data: [...]} list results', async () => {
    const {client: c} = client({'cicd data template list': ok({data: fixtureResult('template-list')})})
    expect(await c.listTemplates()).toHaveLength(2)
  })

  it('parses a real v2 detail document', async () => {
    const {client: c} = client({[`cicd data template get-detail ${READY_ID}`]: fixture('detail-v2-ready')})
    const detail = await c.getDetail(READY_ID)
    expect(detail.version).toBe(2)
    expect(detail.details[0].table).toBe('Account')
    expect(detail.details[0].filters).toEqual(["Type = 'Customer'"])
    expect(detail.details[0].rawFilters?.[0]).toMatchObject({order: 1, operator: 'e', finalValue: "Type = 'Customer'"})
    expect(detail.details[0].limit).toBe(50000)
  })

  it('keeps fields it does not model, so a save never drops data', async () => {
    const doc = fixtureResult<Record<string, unknown> & {details: Record<string, unknown>[]}>('detail-v2-ready')
    doc.futureTopLevel = {x: 1}
    doc.details[0].futureObjectField = 'kept'
    const {client: c} = client({[`cicd data template get-detail ${READY_ID}`]: ok(doc)})
    const detail = (await c.getDetail(READY_ID)) as unknown as typeof doc
    expect(detail.futureTopLevel).toEqual({x: 1})
    expect(detail.details[0].futureObjectField).toBe('kept')
  })

  it('parses the legacy export graph keyed by template Id', async () => {
    const {client: c} = client({[`cicd data template get ${READY_ID}`]: fixture('graph-legacy')})
    const graph = await c.getGraph(READY_ID)
    expect(Object.keys(graph)).toEqual([READY_ID])
    expect(graph[READY_ID].columns).toHaveLength(8)
  })

  it('lists advanced filters', async () => {
    const {client: c} = client({[`cicd data filter list ${READY_ID}`]: fixture('filter-list-empty')})
    expect(await c.listFilters(READY_ID)).toEqual([])
  })
})

describe('AgentiaClient: saveDetail', () => {
  it("sends the document over stdin with --stdin and returns Copado's result", async () => {
    const doc = fixtureResult<Parameters<AgentiaClient['saveDetail']>[1]>('detail-v2-ready')
    const {runner, client: c} = client({[`cicd data template save-detail ${READY_ID} --stdin`]: fixture('save-ok')})
    await expect(c.saveDetail(READY_ID, doc)).resolves.toBe(true)
    expect(runner.calls[0].args).toEqual(['cicd', 'data', 'template', 'save-detail', READY_ID, '--stdin', '--json'])
    expect(JSON.parse(runner.calls[0].input!)).toEqual(doc)
  })

  it('turns a 422 for empty filters into a TemplateValidationError with a UI fix', async () => {
    const doc = fixtureResult<Parameters<AgentiaClient['saveDetail']>[1]>('detail-v2-no-filter')
    const {client: c} = client({[`cicd data template save-detail ${NO_FILTER_ID} --stdin`]: fixture('error-mdw-003-filters')})
    const error = await c.saveDetail(NO_FILTER_ID, doc).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TemplateValidationError)
    const v = error as TemplateValidationError
    expect(v.exitCode).toBe(ExitCode.Validation)
    expect(v.details.problems).toHaveLength(2)
    expect(v.hint).toMatch(/Main Object Filter tab/)
    expect(v.message).not.toMatch(/api_key|https?:/)
  })

  it('explains a missing limit with the Max. Record Limit field', async () => {
    const doc = fixtureResult<Parameters<AgentiaClient['saveDetail']>[1]>('detail-v2-limit-null')
    const {client: c} = client({[`cicd data template save-detail ${READY_ID} --stdin`]: fixture('error-mdw-003-limit')})
    const error = (await c.saveDetail(READY_ID, doc).catch((e: unknown) => e)) as TemplateValidationError
    expect(error.details.problems).toEqual([expect.objectContaining({path: 'details.0.limit', kind: 'missing'})])
    expect(error.hint).toMatch(/Max\. Record Limit/)
  })
})

describe('AgentiaClient: error mapping', () => {
  it.each([
    ['error-auth-missing', AuthMissingError, ExitCode.AuthMissing],
    ['error-lgn-001', SourceOrgLoginError, ExitCode.Gateway],
    ['error-dat-004', TemplateNotFoundError, ExitCode.NotFound],
  ] as const)('%s → %s', async (name, type, exitCode) => {
    const {client: c} = client({[`cicd data template get-detail ${READY_ID}`]: fixture(name)})
    const error = await c.getDetail(READY_ID).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(type)
    expect((error as {exitCode: number}).exitCode).toBe(exitCode)
    expect(JSON.stringify((error as {toJSON(): unknown}).toJSON())).not.toMatch(/api_key/)
  })

  it('names the template a 404 refers to and keeps the transaction Id', async () => {
    const {client: c} = client({[`cicd data template get-detail ${READY_ID}`]: fixture('error-dat-004')})
    const error = (await c.getDetail(READY_ID).catch((e: unknown) => e)) as TemplateNotFoundError
    expect(error.message).toContain(READY_ID)
    expect(error.details.transactionId).toMatch(/^00000000-/)
    expect(error.details.categories).toEqual(['DAT-004'])
  })

  it('maps exit code 2 (oclif parse error) without echoing its huge JSON', async () => {
    const {client: c} = client({
      'cicd data template list': {exitCode: 2, stdout: {error: {oclif: {exit: 2}, parse: {input: 'x'.repeat(10_000)}}}},
    })
    const error = await c.listTemplates().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AgentiaUsageError)
    expect((error as Error).message.length).toBeLessThan(200)
  })

  it('rejects non-JSON output', async () => {
    const {client: c} = client({'cicd data template list': {exitCode: 0, stdout: 'Fetching data templates... done'}})
    await expect(c.listTemplates()).rejects.toBeInstanceOf(UnexpectedOutputError)
  })

  it('rejects output that does not match the schema', async () => {
    const {client: c} = client({'cicd data template list': ok([{name: 'no id'}])})
    await expect(c.listTemplates()).rejects.toThrow(/0\.id/)
  })

  it('treats a non-zero exit without a JSON error as unexpected', async () => {
    const {client: c} = client({'cicd data template list': {exitCode: 1, stdout: ''}})
    await expect(c.listTemplates()).rejects.toBeInstanceOf(UnexpectedOutputError)
  })

  it('maps other gateway errors, 401s and plain errors', () => {
    expect(
      mapAgentiaError(
        'x',
        {name: 'CicdGatewayError', statusCode: 500, message: 'Boom. Request: GET /x via https://h?api_key=%3Cmasked%3E'},
        't',
      ),
    ).toBeInstanceOf(GatewayError)
    expect(mapAgentiaError('x', {name: 'CicdGatewayError', statusCode: 401, message: 'Unauthorized'}, 't')).toBeInstanceOf(AuthMissingError)
    const plain = mapAgentiaError('cicd foo', {name: 'Error', message: 'Something else'}, 't')
    expect(plain).toBeInstanceOf(AgentiaCommandError)
    expect(plain.message).toBe('`agentia cicd foo` failed: Something else')
  })

  it('parses Copado validation lines', () => {
    const problems = parseValidationProblems(
      '[details.0.filters] (missing): Field required\n[details.0.rawFilters] (list_type): Input should be a valid list. Request: PUT /x via https://h',
    )
    expect(problems).toEqual([
      {path: 'details.0.filters', kind: 'missing', message: 'Field required', hint: expect.stringMatching(/filter/)},
      {path: 'details.0.rawFilters', kind: 'list_type', message: 'Input should be a valid list', hint: undefined},
    ])
  })
})

describe('AgentiaClient: resolveTemplate', () => {
  const resolver = () => client({'cicd data template list': fixture('template-list')}).client

  it('finds by exact name, ignoring case', async () => {
    expect((await resolver().resolveTemplate('tm demo - accounts new')).id).toBe(READY_ID)
  })

  it('finds by 18- or 15-character Id', async () => {
    expect((await resolver().resolveTemplate(READY_ID)).name).toBe('TM Demo - Accounts New')
    expect((await resolver().resolveTemplate(READY_ID.slice(0, 15))).name).toBe('TM Demo - Accounts New')
  })

  it('tells "–" and "-" apart (both demo names exist)', async () => {
    expect((await resolver().resolveTemplate('TM Demo – Accounts')).id).toBe(NO_FILTER_ID)
  })

  it('fails clearly when missing or ambiguous', async () => {
    await expect(resolver().resolveTemplate('Nope')).rejects.toBeInstanceOf(TemplateNotFoundError)
    const twins = fixtureResult<{name: string}[]>('template-list')
    twins[1].name = twins[0].name
    const {client: c} = client({'cicd data template list': ok(twins)})
    await expect(c.resolveTemplate(twins[0].name)).rejects.toBeInstanceOf(TemplateAmbiguousError)
  })
})

describe('versions', () => {
  it('reads the version from agentia --version', async () => {
    const {client: c} = client({'--version': VERSION_OK})
    expect(await c.version()).toBe('1.0.0-beta.2')
    expect(await c.assertSupportedVersion()).toBe('1.0.0-beta.2')
  })

  it('rejects older CLIs', async () => {
    const {client: c} = client({'--version': {stdout: '@copado/agentia-cli/1.0.0-beta.0 darwin-arm64 node-v24'}})
    await expect(c.assertSupportedVersion()).rejects.toBeInstanceOf(AgentiaVersionError)
  })

  it.each([
    ['1.0.0-beta.2', '1.0.0-beta.2', 0],
    ['1.0.0-beta.10', '1.0.0-beta.2', 1],
    ['1.0.0', '1.0.0-beta.9', 1],
    ['1.0.0-alpha', '1.0.0-beta', -1],
    ['0.9.9', '1.0.0-beta.2', -1],
    ['1.1.0-beta.1', '1.0.0', 1],
  ])('compare %s vs %s = %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })

  it('recognises Salesforce Ids', () => {
    expect(isSalesforceId('a0U000000000004AAA')).toBe(true)
    expect(isSalesforceId('a0U000000000004')).toBe(true)
    expect(isSalesforceId('TM Demo')).toBe(false)
  })
})
