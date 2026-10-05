import type {AgentiaClient} from '../agentia/client.js'
import type {AdvancedFilter, RecordMatchingFormula, TemplateDetail, TemplateListItem} from '../agentia/schemas.js'
import {keyMap, uniqueSlug, type Config, type TrackedTemplate} from '../store/config.js'
import type {SnapshotMeta, Store} from '../store/store.js'
import {hashDocument, shortHash} from './canonical.js'
import {fetchDetail} from './inspect.js'
import {describeChanges, formatStatementSummary, summariseStatements, type StatementSummary} from './describe.js'
import {diffTemplates} from './differ.js'

/** Resources that are not part of the detail document but shape what a template deploys. */
export interface TemplateExtras {
  advancedFilters: AdvancedFilter[]
  /** Record matching formulas per object in the template. Shared with other templates on the same object. */
  recordMatchingFormulas: Record<string, RecordMatchingFormula[]>
}

export interface LiveTemplate {
  template: TemplateListItem
  detail: TemplateDetail
  extras: TemplateExtras
  hash: string
  extrasHash: string
}

export type SnapshotOutcome = 'created' | 'updated' | 'unchanged'

export interface SnapshotResult {
  id: string
  name: string
  slug: string
  outcome: SnapshotOutcome
  hash: string
  previousHash?: string
  /** Commit sha; absent when unchanged or with --dry-run. */
  commit?: string
  /** Summary of statements, as `diff` would print it. */
  change?: StatementSummary
  dryRun: boolean
}

export interface SnapshotOptions {
  reason?: string
  dryRun?: boolean
  agentiaVersion?: string
}

/** Reads the live detail + extras for a template (read-only). */
export async function fetchLive(client: AgentiaClient, template: TemplateListItem, config: Config): Promise<LiveTemplate> {
  const detail = await fetchDetail(client, template)
  const objects = [...new Set(detail.details.map((d) => d.table))].sort()
  const advancedFilters = await client.listFilters(template.id)
  const recordMatchingFormulas: Record<string, RecordMatchingFormula[]> = {}
  for (const object of objects) recordMatchingFormulas[object] = await client.listFormulas(object)
  const extras: TemplateExtras = {advancedFilters, recordMatchingFormulas}
  const keys = keyMap(config)
  return {template, detail, extras, hash: hashDocument(detail, keys), extrasHash: hashDocument(extras, keys)}
}

/** Adds (or refreshes the name of) a tracked template in the config. Returns its entry. */
export function track(config: Config, template: TemplateListItem): TrackedTemplate {
  const existing = config.templates.find((t) => t.id === template.id)
  if (existing) {
    existing.name = template.name
    return existing
  }
  const entry = {id: template.id, name: template.name, slug: uniqueSlug(config, template.name, template.id)}
  config.templates.push(entry)
  return entry
}

/**
 * Snapshots one template: fetch live, compare with the last snapshot, and write + commit only when the
 * detail or extras changed. Commits touch only this template's folder and config.json.
 */
export async function snapshotTemplate(
  client: AgentiaClient,
  store: Store,
  template: TemplateListItem,
  options: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const config = store.loadConfig()
  const live = await fetchLive(client, template, config)
  return recordSnapshot(store, config, live, options)
}

/** Writes + commits an already fetched live state (used by snapshot, and later by restore/edit). */
export async function recordSnapshot(
  store: Store,
  config: Config,
  live: LiveTemplate,
  options: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const entry = track(config, live.template)
  const previous = store.readSnapshot(entry.slug)
  const base = {id: live.template.id, name: live.template.name, slug: entry.slug, hash: live.hash, dryRun: Boolean(options.dryRun)}

  const keys = keyMap(config)
  // Recompute from the stored document rather than trusting meta.json, so a change in canonicalisation
  // never shows up as a false change.
  const previousHash = previous ? hashDocument(previous.detail, keys) : undefined
  if (previous && previousHash === live.hash && hashDocument(previous.extras, keys) === live.extrasHash) {
    return {...base, outcome: 'unchanged', previousHash}
  }

  const change = previous ? summariseStatements(describeChanges(diffTemplates(previous, live, {keys, ignore: config.ignore}))) : undefined
  const outcome: SnapshotOutcome = previous ? 'updated' : 'created'
  if (options.dryRun) return {...base, outcome, previousHash, change}

  const author = await store.gitUser()
  const meta: SnapshotMeta = {
    templateId: live.template.id,
    name: live.template.name,
    mainObject: live.template.mainObject ?? live.detail.mainObject?.apiName ?? null,
    hash: live.hash,
    extrasHash: live.extrasHash,
    lastModified: live.template.lastModified ?? null,
    fetchedAt: new Date().toISOString(),
    sourceCommand: `agentia cicd data template get-detail ${live.template.id}`,
    agentiaVersion: options.agentiaVersion ?? null,
  }
  const paths = store.writeSnapshot(entry.slug, {detail: live.detail, extras: live.extras, meta})
  store.saveConfig(config)
  const commit = await store.commit([...paths, store.rel('config.json')], commitMessage(meta, author, outcome, change, options.reason))
  return {...base, outcome, previousHash, commit, change}
}

export function commitMessage(
  meta: SnapshotMeta,
  author: string,
  outcome: SnapshotOutcome,
  change: StatementSummary | undefined,
  reason?: string,
): string {
  const subject = `tm: snapshot ${meta.name} (${shortHash(meta.hash)}) by ${author}${reason ? ` [${reason}]` : ''}`
  const trailers = [
    `Template-Id: ${meta.templateId}`,
    `Template-Name: ${meta.name}`,
    `Template-Hash: ${meta.hash}`,
    `Change: ${outcome === 'created' ? 'first snapshot' : formatStatementSummary(change!)}`,
    ...(reason ? [`Reason: ${reason.replace(/\n/g, ' ')}`] : []),
    ...(meta.lastModified ? [`Copado-Last-Modified: ${meta.lastModified}`] : []),
  ]
  return `${subject}\n\n${trailers.join('\n')}\n`
}
