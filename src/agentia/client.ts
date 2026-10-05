/**
 * AgentiaClient: the single adapter between timemachine and Copado.
 *
 * Plugins cannot call Agentia internals, so every operation spawns the public `agentia` binary with
 * `--json` (always from the project root, where project-scoped auth lives), validates the envelope
 * with zod and turns failures into typed errors. Command names and flags here are the ones recorded
 * in docs/agentia-commands.md; do not add commands that are not in `agentia --help`.
 */
import path from 'node:path'
import type {z} from 'zod'

import {
  AgentiaCommandError,
  AgentiaUsageError,
  AgentiaVersionError,
  AuthMissingError,
  GatewayError,
  SourceOrgLoginError,
  TemplateAmbiguousError,
  TemplateNotFoundError,
  TemplateValidationError,
  TimemachineError,
  UnexpectedOutputError,
  type ErrorDetails,
  type ValidationProblem,
} from './errors.js'
import {ProcessRunner, RecordingRunner, type Runner} from './runner.js'
import {
  AdvancedFilterListSchema,
  AgentiaErrorEnvelopeSchema,
  AgentiaSuccessEnvelopeSchema,
  RecordMatchingFormulaListSchema,
  RecordSearchSchema,
  SaveDetailResultSchema,
  TemplateDetailSchema,
  TemplateGraphSchema,
  TemplateListSchema,
  type AdvancedFilter,
  type AgentiaErrorBody,
  type RecordMatchingFormula,
  type RecordSearch,
  type TemplateDetail,
  type TemplateGraph,
  type TemplateListItem,
} from './schemas.js'

export const MIN_AGENTIA_VERSION = '1.0.0-beta.2'
const DEFAULT_TIMEOUT_MS = 120_000

export interface ClientOptions {
  runner?: Runner
  /** Project root; `agentia` is always spawned here. */
  cwd?: string
  timeoutMs?: number
}

export interface ListTemplatesFilter {
  name?: string
  mainObject?: string
  active?: boolean
}

/** Context used to word errors, e.g. which template a 404 refers to. */
interface CallContext {
  ref?: string
  /** Keep `{data: [...]}` results as they are (search responses carry more than the list). */
  keepEnvelope?: boolean
}

export class AgentiaClient {
  readonly runner: Runner
  readonly cwd: string
  readonly timeoutMs: number

  constructor(options: ClientOptions = {}) {
    this.cwd = options.cwd ?? process.cwd()
    this.timeoutMs = options.timeoutMs ?? (Number(process.env.TM_AGENTIA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
    let runner = options.runner ?? new ProcessRunner()
    if (process.env.TM_RECORD === '1') {
      runner = new RecordingRunner(runner, path.join(this.cwd, 'fixtures', 'raw', 'recorded'))
    }
    this.runner = runner
  }

  // ---------- version ----------

  /** Returns the CLI version, e.g. `1.0.0-beta.2`, from `agentia --version`. */
  async version(): Promise<string> {
    const {stdout} = await this.runner.run(['--version'], {cwd: this.cwd, timeoutMs: this.timeoutMs})
    const match = /@copado\/agentia-cli\/(\S+)/.exec(stdout)
    if (!match) throw new UnexpectedOutputError('--version', `could not find a version in "${stdout.trim().slice(0, 80)}"`)
    return match[1]
  }

  async assertSupportedVersion(): Promise<string> {
    const found = await this.version()
    if (compareVersions(found, MIN_AGENTIA_VERSION) < 0) throw new AgentiaVersionError(found, MIN_AGENTIA_VERSION)
    return found
  }

  // ---------- templates ----------

  async listTemplates(filter: ListTemplatesFilter = {}): Promise<TemplateListItem[]> {
    const args = ['cicd', 'data', 'template', 'list']
    if (filter.name !== undefined) args.push('--name', filter.name)
    if (filter.mainObject !== undefined) args.push('--main-object', filter.mainObject)
    if (filter.active !== undefined) args.push(filter.active ? '--active' : '--no-active')
    return this.exec(args, TemplateListSchema)
  }

  /**
   * Finds a template by Id or exact name (case-insensitive). Names are what people type; Ids are
   * what agents should pass once they have one.
   */
  async resolveTemplate(ref: string): Promise<TemplateListItem> {
    return matchTemplate(await this.listTemplates(), ref)
  }

  /** Raw v2 detail document. DAT-004 (no v2 attachment, or no such Id) → TemplateNotFoundError. */
  async getDetail(id: string): Promise<TemplateDetail> {
    return this.exec(['cicd', 'data', 'template', 'get-detail', id], TemplateDetailSchema, {ref: id})
  }

  /** Export graph (selected columns only). Works for legacy templates too. */
  async getGraph(id: string): Promise<TemplateGraph> {
    return this.exec(['cicd', 'data', 'template', 'get', id], TemplateGraphSchema, {ref: id})
  }

  /**
   * Replaces the whole v2 detail document (HTTP PUT). The body goes over stdin so no temp file
   * with org data is left behind. Copado answers `true` on success.
   */
  async saveDetail(id: string, detail: TemplateDetail): Promise<unknown> {
    return this.exec(['cicd', 'data', 'template', 'save-detail', id, '--stdin'], SaveDetailResultSchema, {ref: id}, JSON.stringify(detail))
  }

  /**
   * Copado's record selection for a template (`data records search`): a read-only query of the source org that
   * returns the template configuration the data engine used and the matching records. Used by `verify`.
   */
  async searchRecords(credentialId: string, templateId: string): Promise<RecordSearch> {
    return this.exec(
      ['cicd', 'data', 'records', 'search', '--credential-id', credentialId, '--data-template-id', templateId],
      RecordSearchSchema,
      {ref: templateId, keepEnvelope: true},
    )
  }

  async listFilters(templateId: string): Promise<AdvancedFilter[]> {
    return this.exec(['cicd', 'data', 'filter', 'list', templateId], AdvancedFilterListSchema, {ref: templateId})
  }

  async listFormulas(objectApiName: string): Promise<RecordMatchingFormula[]> {
    return this.exec(['cicd', 'data', 'formula', 'list', objectApiName], RecordMatchingFormulaListSchema)
  }

  // ---------- plumbing ----------

  private async exec<S extends z.ZodType>(args: string[], schema: S, context: CallContext = {}, input?: string): Promise<z.infer<S>> {
    const command = args.join(' ')
    const {stdout, exitCode} = await this.runner.run([...args, '--json'], {cwd: this.cwd, timeoutMs: this.timeoutMs, input})

    if (exitCode === 2) throw new AgentiaUsageError(command) // oclif parse error; its JSON can be MBs, never echo it
    const json = parseJson(stdout)
    if (json === undefined) {
      throw new UnexpectedOutputError(command, exitCode === 0 ? 'output was not JSON' : `exit code ${exitCode} without a JSON error`)
    }

    const failure = AgentiaErrorEnvelopeSchema.safeParse(json)
    if (failure.success) throw mapAgentiaError(command, failure.data.error, failure.data.transactionId, context)
    if (exitCode !== 0) throw new UnexpectedOutputError(command, `exit code ${exitCode} without a JSON error`)

    const envelope = AgentiaSuccessEnvelopeSchema.safeParse(json)
    if (!envelope.success) throw new UnexpectedOutputError(command, 'missing { result, status: 0 } envelope')
    const parsed = schema.safeParse(context.keepEnvelope ? envelope.data.result : normaliseResult(envelope.data.result))
    if (!parsed.success) throw new UnexpectedOutputError(command, summariseZodError(parsed.error))
    return parsed.data
  }
}

/** Finds a template in a list by Id (15 or 18 chars) or exact name, ignoring case. */
export function matchTemplate(all: TemplateListItem[], ref: string): TemplateListItem {
  const byId = all.find((t) => t.id === ref || (isSalesforceId(ref) && sameSalesforceId(t.id, ref)))
  if (byId) return byId
  const byName = all.filter((t) => t.name.toLowerCase() === ref.trim().toLowerCase())
  if (byName.length === 1) return byName[0]
  if (byName.length > 1)
    throw new TemplateAmbiguousError(
      ref,
      byName.map((t) => t.id),
    )
  throw new TemplateNotFoundError(ref)
}

// ---------- error mapping ----------

const FIELD_HINTS: Record<string, string> = {
  filters:
    'Copado cannot save a template without a main object filter (empty lists are dropped in transit). Add a filter on the Main Object Filter tab.',
  rawFilters:
    'Copado cannot save a template without a main object filter (empty lists are dropped in transit). Add a filter on the Main Object Filter tab.',
  limit: 'Set "Max. Record Limit" on the template\'s Main Object Filter tab, then retry.',
}

/** Turns an Agentia `--json` error body into a typed TimemachineError. Exported for tests. */
export function mapAgentiaError(
  command: string,
  error: AgentiaErrorBody,
  transactionId: string | undefined,
  context: CallContext = {},
): TimemachineError {
  const message = cleanMessage(error.message)
  const categories = error.categories ? [...new Set(error.categories)] : undefined
  const details: ErrorDetails = {transactionId, categories, statusCode: error.statusCode}
  const has = (prefix: string) => categories?.some((c) => c.startsWith(prefix)) ?? false

  if (/api key is not configured|not authenticated|agentia setup|agentia auth set/i.test(error.message)) {
    return new AuthMissingError(message, transactionId)
  }
  if (error.name === 'CicdGatewayError' || error.statusCode !== undefined) {
    if (error.statusCode === 401 || error.statusCode === 403) return new AuthMissingError(message, transactionId)
    if (has('LGN-')) return new SourceOrgLoginError(message, details)
    if (has('DAT-004') || error.statusCode === 404)
      return new TemplateNotFoundError(context.ref ?? '(unknown)', {...details, cause: message})
    if (has('MDW-') || error.statusCode === 422) {
      const problems = parseValidationProblems(error.message)
      const summary =
        problems.length > 0 ? `Copado rejected the template: ${problems.map((p) => `${p.path} ${p.kind}`).join(', ')}.` : message
      return new TemplateValidationError(summary, problems, details)
    }
    return new GatewayError(message, details)
  }
  return new AgentiaCommandError(`\`agentia ${command}\` failed: ${message}`, details)
}

/** Parses `[details.0.limit] (missing): Field required` lines from a 422 message. */
export function parseValidationProblems(message: string): ValidationProblem[] {
  const problems: ValidationProblem[] = []
  for (const match of message.matchAll(/\[([^\]]+)\]\s*\(([^)]+)\):\s*([^\n]*?)(?=\. Request:|\n|$)/g)) {
    const [, fieldPath, kind, text] = match
    const leaf = fieldPath.split('.').pop() ?? fieldPath
    problems.push({path: fieldPath, kind, message: text.trim(), hint: kind === 'missing' ? FIELD_HINTS[leaf] : undefined})
  }
  return problems
}

/** Drops the trailing `Request: PUT … via https://…?api_key=<masked>` part from gateway messages. */
function cleanMessage(message: string): string {
  return message.split(/\.?\s*Request: /)[0].trim()
}

// ---------- helpers ----------

function parseJson(stdout: string): unknown {
  const text = stdout.trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    if (start > 0) {
      try {
        return JSON.parse(text.slice(start))
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

/** Some list endpoints answer `{data: [...]}`; the CLI usually unwraps it, but be lenient. */
function normaliseResult(result: unknown): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result) && Array.isArray((result as {data?: unknown}).data)) {
    return (result as {data: unknown[]}).data
  }
  return result
}

function summariseZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
}

export function isSalesforceId(value: string): boolean {
  return /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value)
}

function sameSalesforceId(a: string, b: string): boolean {
  return a.slice(0, 15) === b.slice(0, 15)
}

/** Semver-ish comparison that understands prerelease tags such as `1.0.0-beta.2`. */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a)
  const [coreB, preB] = splitVersion(b)
  for (let i = 0; i < 3; i++) {
    const d = (coreA[i] ?? 0) - (coreB[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  if (!preA && !preB) return 0
  if (!preA) return 1
  if (!preB) return -1
  const partsA = preA.split('.')
  const partsB = preB.split('.')
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const pa = partsA[i]
    const pb = partsB[i]
    if (pa === undefined) return -1
    if (pb === undefined) return 1
    const na = Number(pa)
    const nb = Number(pb)
    const d = !Number.isNaN(na) && !Number.isNaN(nb) ? na - nb : pa.localeCompare(pb)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

function splitVersion(v: string): [number[], string | undefined] {
  const [core, ...pre] = v.replace(/^v/, '').split('-')
  return [core.split('.').map(Number), pre.length > 0 ? pre.join('-') : undefined]
}
