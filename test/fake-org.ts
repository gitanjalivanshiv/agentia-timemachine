/**
 * A stateful fake Copado org behind the Runner interface. It reproduces what Phase 0 measured on a real org:
 * - `save-detail` replaces the whole document; null-valued keys inside filter rows are dropped on save,
 * - a document with empty filters/rawFilters or a null limit is rejected with 422 MDW-003,
 * - every save bumps `lastModified`.
 * Hooks let tests simulate a colleague saving between two of our calls.
 */
import type {FakeCall, RunOptions, RunResult, Runner} from '../src/agentia/runner.js'
import type {TemplateDetail, TemplateListItem} from '../src/agentia/schemas.js'
import {fixtureResult} from './helpers.js'

type Hook = (org: FakeOrg, call: FakeCall) => void

export class FakeOrg implements Runner {
  readonly calls: FakeCall[] = []
  readonly templates = new Map<string, TemplateListItem>()
  readonly details = new Map<string, TemplateDetail>()
  extras: {filters: Record<string, unknown[]>; formulas: Record<string, unknown[]>} = {filters: {}, formulas: {}}
  /** Called before each save-detail is applied. */
  beforeSave?: Hook
  /** Called before each get-detail is answered. */
  beforeRead?: Hook
  /** What the data engine reports for a template (default: the stored v2 document). Simulates a divergent copy. */
  engineView?: (doc: TemplateDetail) => TemplateDetail
  /** Records the engine finds in the source org. */
  matchingRecords = 3
  /** Transforms a document on save (simulates server-side normalisation). */
  normalise?: (doc: TemplateDetail) => TemplateDetail
  private clock = Date.parse('2026-10-05T10:00:00Z')

  /** The demo org: "TM Demo - Accounts New" (ready) and "TM Demo – Accounts" (no filter). */
  static demo(): FakeOrg {
    const org = new FakeOrg()
    for (const item of fixtureResult<TemplateListItem[]>('template-list')) org.templates.set(item.id, item)
    org.details.set('a0U000000000004AAA', fixtureResult('detail-v2-ready'))
    org.details.set('a0U000000000001AAA', fixtureResult('detail-v2-no-filter'))
    return org
  }

  /** Simulates someone else saving the template (e.g. in another terminal). */
  externalSave(id: string, mutate: (doc: TemplateDetail) => void): void {
    const doc = structuredClone(this.details.get(id)!)
    mutate(doc)
    this.store(id, doc)
  }

  saves(): FakeCall[] {
    return this.calls.filter((c) => c.args[3] === 'save-detail')
  }

  async run(args: string[], {cwd, input}: RunOptions): Promise<RunResult> {
    const call = {args, cwd, input}
    this.calls.push(call)
    const a = args.filter((x) => x !== '--json')
    const key = a.join(' ')

    if (key === '--version') return {stdout: '@copado/agentia-cli/1.0.0-beta.2 darwin-arm64 node-v24\n', exitCode: 0}
    if (key === 'cicd data template list') return ok([...this.templates.values()])
    if (a[3] === 'get-detail') {
      this.beforeRead?.(this, call)
      const doc = this.details.get(a[4])
      return doc ? ok(structuredClone(doc)) : error(404, ['DAT-004'], `Failed to download template attachment: ${a[4]}`)
    }
    if (key.startsWith('cicd data records search ')) {
      const id = a[a.indexOf('--data-template-id') + 1]
      const stored = this.details.get(id)
      if (!stored) return error(404, ['DAT-004'], `Failed to download template attachment: ${id}`)
      const doc = this.engineView ? this.engineView(structuredClone(stored)) : stored
      const d = doc.details[0]
      return ok({
        totalRecords: this.matchingRecords,
        data: [],
        detail: {[id]: {...d, columns: d.columns.filter((c) => c.isSelected)}},
      })
    }
    if (key.startsWith('cicd data filter list ')) return ok(this.extras.filters[a[4]] ?? [])
    if (key.startsWith('cicd data formula list ')) return ok(this.extras.formulas[a[4]] ?? [])
    if (a[3] === 'save-detail') {
      this.beforeSave?.(this, call)
      const doc = JSON.parse(input ?? '{}') as TemplateDetail
      const problems: string[] = []
      doc.details.forEach((d, i) => {
        if (!d.filters?.length) problems.push(`[details.${i}.filters] (missing): Field required`)
        if (!d.rawFilters?.length) problems.push(`[details.${i}.rawFilters] (missing): Field required`)
        if (d.limit === null || d.limit === undefined) problems.push(`[details.${i}.limit] (missing): Field required`)
      })
      if (problems.length > 0) return error(422, ['MDW-003'], problems.join('\n'))
      this.store(a[4], doc)
      return ok(true)
    }
    throw new Error(`FakeOrg: unsupported command "agentia ${key}"`)
  }

  private store(id: string, doc: TemplateDetail): void {
    for (const d of doc.details) {
      d.rawFilters = d.rawFilters?.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null))) as typeof d.rawFilters
    }
    this.details.set(id, this.normalise ? this.normalise(doc) : doc)
    this.clock += 60_000
    const item = this.templates.get(id)
    if (item) item.lastModified = new Date(this.clock).toISOString().replace('Z', '+0000')
  }
}

function ok(result: unknown): RunResult {
  return {stdout: JSON.stringify({result, status: 0, transactionId: 'tx-fake'}), exitCode: 0}
}

function error(statusCode: number, categories: string[], message: string): RunResult {
  return {
    stdout: JSON.stringify({
      error: {
        name: 'CicdGatewayError',
        statusCode,
        categories,
        code: 'HANDLED_EXCEPTION',
        message: `${message}. Request: X via https://fake?api_key=%3Cmasked%3E`,
      },
      transactionId: 'tx-fake-error',
    }),
    exitCode: 1,
  }
}
