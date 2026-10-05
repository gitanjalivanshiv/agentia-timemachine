/**
 * Data for `timemachine report`: every tracked template's timeline (from git) with the readable changes of each
 * version, plus an optional live check (drift since the last snapshot, saveability, verify, lint).
 */
import type {AgentiaClient} from '../agentia/client.js'
import {TimemachineError} from '../agentia/errors.js'
import type {TemplateListItem} from '../agentia/schemas.js'
import {TemplateDetailSchema} from '../agentia/schemas.js'
import {keyMap, type Config, type TrackedTemplate} from '../store/config.js'
import type {Store} from '../store/store.js'
import {hashDocument, shortHash} from './canonical.js'
import {describeChanges, summariseStatements, type StatementSummary} from './describe.js'
import {diffTemplates, type TemplateState} from './differ.js'
import {inspectTemplate} from './inspect.js'
import {lintDocument, type Finding} from './lint.js'
import {compareWithEngine} from './verify.js'

export interface ReportStatement {
  sign: '+' | '-' | '~' | '↕'
  text: string
}

export interface ReportVersion {
  commit: string
  ref: string
  date: string
  author: string
  reason: string | null
  hash: string | null
  first: boolean
  summary: StatementSummary
  statements: ReportStatement[]
  restore: string
}

export interface ReportLive {
  state: 'in-sync' | 'drifted' | 'never' | 'unknown'
  format: string
  saveable: boolean
  fixes: string[]
  /** Changes in Copado since the last snapshot. */
  drift: ReportStatement[]
  verify: {
    aligned: boolean
    fields: number
    filters: string[]
    limit: number | null
    matchingRecords: number | null
    problems: string[]
  } | null
  error?: string
}

export interface ReportTemplate {
  id: string
  name: string
  slug: string
  mainObject: string | null
  versions: ReportVersion[]
  lint: Finding[]
  live: ReportLive | null
}

export interface ReportData {
  title: string
  generatedAt: string
  workspace: string
  templates: ReportTemplate[]
}

export interface ReportOptions {
  /** Read Copado (drift, verify). Without it the report uses git only. */
  client?: AgentiaClient
  listed?: TemplateListItem[]
  limit?: number
}

export async function buildReport(
  store: Store,
  config: Config,
  tracked: TrackedTemplate[],
  options: ReportOptions = {},
): Promise<ReportData> {
  const keys = keyMap(config)
  const templates: ReportTemplate[] = []
  for (const t of tracked) {
    const history = await store.history(t.slug, options.limit)
    const states = await Promise.all(history.map((h) => loadState(store, t.slug, h.commit)))
    const versions: ReportVersion[] = history.map((h, i) => {
      const current = states[i]
      const previous = states[i + 1]
      const statements = current && previous ? describeChanges(diffTemplates(previous, current, {keys, ignore: config.ignore})) : []
      return {
        commit: h.commit,
        ref: h.shortCommit,
        date: h.date,
        author: h.author,
        reason: h.trailers['Reason'] ?? null,
        hash: current ? shortHash(hashDocument(current.detail, keys)) : null,
        first: !previous,
        summary: summariseStatements(statements),
        statements: statements.map((s) => ({sign: s.sign, text: s.text})),
        restore: `agentia timemachine restore "${t.name}" --to ${h.shortCommit}`,
      }
    })

    const latest = states[0]
    const lint = latest ? lintDocument(TemplateDetailSchema.parse(latest.detail), config.lint) : []
    const listed = options.listed?.find((l) => l.id === t.id)
    const live = options.client && listed ? await liveCheck(options.client, listed, latest, keys, config) : null
    templates.push({id: t.id, name: t.name, slug: t.slug, mainObject: listed?.mainObject ?? null, versions, lint, live})
  }
  // Most recently changed template first: that is the one people open the report for.
  templates.sort((a, b) => (b.versions[0]?.date ?? '').localeCompare(a.versions[0]?.date ?? ''))
  return {title: 'Time Machine', generatedAt: new Date().toISOString(), workspace: store.root, templates}
}

async function liveCheck(
  client: AgentiaClient,
  listed: TemplateListItem,
  latest: TemplateState | undefined,
  keys: ReturnType<typeof keyMap>,
  config: Config,
): Promise<ReportLive> {
  try {
    const inspection = await inspectTemplate(client, listed)
    const live: ReportLive = {
      state: 'unknown',
      format: inspection.format,
      saveable: inspection.format === 'v2' && inspection.saveBlockers.length === 0,
      fixes: [...new Set(inspection.saveBlockers.map((b) => b.fix))],
      drift: [],
      verify: null,
    }
    if (inspection.detail) {
      if (!latest) live.state = 'never'
      else if (hashDocument(latest.detail, keys) === hashDocument(inspection.detail, keys)) live.state = 'in-sync'
      else {
        live.state = 'drifted'
        live.drift = describeChanges(
          diffTemplates({detail: latest.detail}, {detail: inspection.detail}, {keys, ignore: config.ignore}),
        ).map((s) => ({sign: s.sign, text: s.text}))
      }
      const credential = listed.sourceOrgId ?? inspection.detail.schemaCredential
      if (credential) {
        const search = await client.searchRecords(credential, listed.id)
        const comparison = compareWithEngine(inspection.detail, search.detail?.[listed.id] ?? Object.values(search.detail ?? {})[0])
        const view = comparison.engine ?? comparison.document
        live.verify = {
          aligned: comparison.differences.length === 0,
          fields: view.fields.length,
          filters: view.filters,
          limit: view.limit,
          matchingRecords: search.totalRecords ?? null,
          problems: comparison.differences.map((d) => d.message),
        }
      }
    }
    return live
  } catch (error) {
    if (!(error instanceof TimemachineError)) throw error
    return {state: 'unknown', format: 'error', saveable: false, fixes: [], drift: [], verify: null, error: error.message}
  }
}

async function loadState(store: Store, slug: string, commit: string): Promise<TemplateState | undefined> {
  const detail = await store.showAt(commit, store.templateRel(slug, 'template.json'))
  if (detail === undefined) return undefined
  const extras = await store.showAt(commit, store.templateRel(slug, 'extras.json'))
  return {detail: JSON.parse(detail), extras: extras ? JSON.parse(extras) : {}}
}
