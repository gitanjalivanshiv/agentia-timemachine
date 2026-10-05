/**
 * Lint rules for v2 template documents. Each rule has a stable id, a severity and a fix hint. Rules come from
 * what Phase 0–5 showed about real templates (e.g. Copado rejects saves without a filter or limit; an
 * unquoted picklist value produced an invalid condition during development).
 */
import type {TemplateDetail, TemplateObjectDetail} from '../agentia/schemas.js'

export type Severity = 'error' | 'warning' | 'info'

export interface Finding {
  rule: string
  name: string
  severity: Severity
  object: string
  message: string
  fix: string
}

export interface LintOptions {
  disable?: string[]
  /** Objects where a large record limit deserves a warning. */
  highVolumeObjects?: string[]
  highVolumeLimit?: number
}

export const DEFAULT_HIGH_VOLUME = [
  'Account',
  'Contact',
  'Lead',
  'Opportunity',
  'Case',
  'Task',
  'Event',
  'User',
  'OpportunityLineItem',
  'Asset',
]

interface Rule {
  id: string
  name: string
  severity: Severity
  description: string
  check(d: TemplateObjectDetail, options: Required<LintOptions>): {message: string; fix: string}[]
}

const TEXT_TYPES = new Set(['PICKLIST', 'MULTIPICKLIST', 'STRING', 'TEXTAREA', 'EMAIL', 'PHONE', 'URL', 'ID', 'REFERENCE', 'COMBOBOX'])
const PII_NAMES = new Set([
  'Email',
  'Phone',
  'MobilePhone',
  'HomePhone',
  'OtherPhone',
  'Fax',
  'FirstName',
  'LastName',
  'Birthdate',
  'MailingStreet',
  'PersonEmail',
])

/** API name from a filter row's `fieldName` ("Account Type-Type" → "Type"). */
export function filterField(fieldName: string | null | undefined): string | undefined {
  if (!fieldName) return undefined
  return fieldName.slice(fieldName.lastIndexOf('-') + 1) || undefined
}

export const RULES: Rule[] = [
  {
    id: 'TM001',
    name: 'filter-required',
    severity: 'error',
    description: 'Every object needs a main object filter. Copado rejects saves without one, and it would deploy every record.',
    check: (d) =>
      !d.filters?.length || !d.rawFilters?.length
        ? [{message: `${d.table} has no main object filter.`, fix: `Add a filter for ${d.table} (Main Object Filter tab).`}]
        : [],
  },
  {
    id: 'TM002',
    name: 'limit-required',
    severity: 'error',
    description: 'Max. Record Limit must be set; Copado rejects saves without it.',
    check: (d) =>
      d.limit === null || d.limit === undefined
        ? [{message: `${d.table} has no Max. Record Limit.`, fix: `Set "Max. Record Limit" for ${d.table} (Main Object Filter tab).`}]
        : [],
  },
  {
    id: 'TM003',
    name: 'high-volume-limit',
    severity: 'warning',
    description: 'High-volume objects with a very large record limit can move far more data than intended.',
    check: (d, o) =>
      o.highVolumeObjects.includes(d.table) && typeof d.limit === 'number' && d.limit > o.highVolumeLimit
        ? [
            {
              message: `${d.table} is a high-volume object and may deploy up to ${d.limit.toLocaleString('en')} records.`,
              fix: `Narrow the filter or lower "Max. Record Limit" to ${o.highVolumeLimit.toLocaleString('en')} or less.`,
            },
          ]
        : [],
  },
  {
    id: 'TM004',
    name: 'record-matching',
    severity: 'warning',
    description: 'Without an external Id or record matching formula, records are matched by Salesforce Id, which differs between orgs.',
    check: (d) => {
      const hasExternal = d.columns.some((c) => c.isSelected && c.externalId)
      const generated = d.externalIdGeneration?.generateExternalId || d.externalIdGeneration?.recordMatchingFormulaId
      const field = d.externalIdField && d.externalIdField !== 'Id'
      return hasExternal || generated || field
        ? []
        : [
            {
              message: `${d.table} records are matched by Salesforce Id only; re-deploying to another org can create duplicates.`,
              fix: `Mark an external Id field for ${d.table}, or add a record matching formula (agentia cicd data formula create).`,
            },
          ]
    },
  },
  {
    id: 'TM005',
    name: 'duplicate-field',
    severity: 'error',
    description: 'A field appears more than once in the template.',
    check: (d) => {
      const seen = new Set<string>()
      const dupes = new Set<string>()
      for (const c of d.columns) (seen.has(c.name) ? dupes : seen).add(c.name)
      return [...dupes].map((n) => ({
        message: `${d.table}.${n} appears more than once.`,
        fix: `Keep a single entry for ${n} in details[].columns.`,
      }))
    },
  },
  {
    id: 'TM006',
    name: 'filter-unquoted-value',
    severity: 'error',
    description: 'Text and picklist values in filter conditions must be quoted.',
    check: (d) =>
      (d.rawFilters ?? [])
        .filter(
          (r) =>
            TEXT_TYPES.has(String(r.fieldType ?? '').toUpperCase()) &&
            r.finalValue &&
            r.input !== undefined &&
            r.input !== '' &&
            !/'/.test(r.finalValue),
        )
        .map((r) => ({
          message: `${d.table} filter #${r.order} "${r.finalValue}" compares text without quotes.`,
          fix: `Quote the value, e.g. ${filterField(r.fieldName) ?? 'Field'} = '${String(r.input)}', in both rawFilters[].finalValue and filters[].`,
        })),
  },
  {
    id: 'TM007',
    name: 'filter-text-mismatch',
    severity: 'warning',
    description: 'The filter text (filters[]) should match the filter rows (rawFilters[].finalValue).',
    check: (d) => {
      const rows = [...(d.rawFilters ?? [])].sort((a, b) => a.order - b.order).map((r) => r.finalValue ?? '')
      const text = d.filters ?? []
      return rows.length > 0 && JSON.stringify(rows) !== JSON.stringify(text)
        ? [
            {
              message: `${d.table} filter text does not match its filter rows.`,
              fix: 'Update filters[] to the finalValue of each rawFilters row, in order.',
            },
          ]
        : []
    },
  },
  {
    id: 'TM008',
    name: 'filter-invalid',
    severity: 'error',
    description: 'Copado marked a filter row as invalid.',
    check: (d) =>
      (d.rawFilters ?? [])
        .filter((r) => r.isValid === false)
        .map((r) => ({message: `${d.table} filter #${r.order} is marked invalid.`, fix: 'Fix or remove the filter row.'})),
  },
  {
    id: 'TM009',
    name: 'filter-field-missing',
    severity: 'error',
    description: 'A filter refers to a field that is not in the template schema (deleted or renamed).',
    check: (d) => {
      const names = new Set(d.columns.map((c) => c.name))
      return (d.rawFilters ?? [])
        .map((r) => filterField(r.fieldName))
        .filter((f): f is string => Boolean(f) && !names.has(f!))
        .map((f) => ({
          message: `${d.table} filter uses ${f}, which is not in the template's fields.`,
          fix: `Refresh the template schema or change the filter on ${f}.`,
        }))
    },
  },
  {
    id: 'TM010',
    name: 'batch-size',
    severity: 'warning',
    description: 'Batch size should be between 1 and 200.',
    check: (d) =>
      typeof d.batchSize === 'number' && (d.batchSize < 1 || d.batchSize > 200)
        ? [{message: `${d.table} batch size is ${d.batchSize}.`, fix: 'Use a batch size between 1 and 200.'}]
        : [],
  },
  {
    id: 'TM011',
    name: 'pii-not-anonymised',
    severity: 'info',
    description: 'Personal data fields deployed without anonymisation.',
    check: (d) => {
      const fields = d.columns.filter(
        (c) =>
          c.isSelected &&
          (PII_NAMES.has(c.name) || ['email', 'phone'].includes(String(c.type))) &&
          (c.anonymizerType?.type ?? 'None') === 'None',
      )
      return fields.length > 0
        ? [
            {
              message: `${d.table} deploys personal data without anonymisation: ${fields.map((c) => c.name).join(', ')}.`,
              fix: 'Choose an anonymizer for these fields if the target is a non-production org.',
            },
          ]
        : []
    },
  },
]

export function lintDocument(detail: TemplateDetail, options: LintOptions = {}): Finding[] {
  const opts: Required<LintOptions> = {
    disable: options.disable ?? [],
    highVolumeObjects: options.highVolumeObjects ?? DEFAULT_HIGH_VOLUME,
    highVolumeLimit: options.highVolumeLimit ?? 10_000,
  }
  const findings: Finding[] = []
  for (const d of detail.details) {
    for (const rule of RULES) {
      if (opts.disable.includes(rule.id) || opts.disable.includes(rule.name)) continue
      for (const f of rule.check(d, opts)) findings.push({rule: rule.id, name: rule.name, severity: rule.severity, object: d.table, ...f})
    }
  }
  const rank: Record<Severity, number> = {error: 0, warning: 1, info: 2}
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.rule.localeCompare(b.rule))
}
