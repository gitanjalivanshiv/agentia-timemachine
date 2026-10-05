/**
 * zod schemas for the Agentia CLI `--json` output, built from real Phase 0 captures
 * (see docs/agentia-commands.md). Objects are loose: unknown fields are preserved, because the
 * detail document is saved back verbatim and must never lose data we do not model.
 */
import {z} from 'zod'

// ---------- envelope ----------

export const AgentiaErrorBodySchema = z.looseObject({
  name: z.string().optional(),
  message: z.string().default(''),
  code: z.string().optional(),
  statusCode: z.number().optional(),
  categories: z.array(z.string()).optional(),
  requestMethod: z.string().optional(),
  requestUrl: z.string().optional(),
})
export type AgentiaErrorBody = z.infer<typeof AgentiaErrorBodySchema>

export const AgentiaErrorEnvelopeSchema = z.looseObject({
  error: AgentiaErrorBodySchema,
  transactionId: z.string().optional(),
})

export const AgentiaSuccessEnvelopeSchema = z.looseObject({
  result: z.unknown(),
  status: z.literal(0),
  transactionId: z.string().optional(),
})

// ---------- template list ----------

export const TemplateListItemSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  mainObject: z.string().nullish(),
  status: z.string().nullish(),
  active: z.boolean().nullish(),
  lastModified: z.string().nullish(),
  createdDate: z.string().nullish(),
  createdBy: z.string().nullish(),
  actionType: z.string().nullish(),
  /** NB: a credential Id despite the name. */
  sourceOrgId: z.string().nullish(),
  sourceOrgName: z.string().nullish(),
  sourceEnvironmentId: z.string().nullish(),
})
export type TemplateListItem = z.infer<typeof TemplateListItemSchema>
export const TemplateListSchema = z.array(TemplateListItemSchema)

// ---------- v2 detail ----------

export const TemplateColumnSchema = z.looseObject({
  name: z.string(),
  type: z.string().nullish(),
  isSelected: z.boolean().nullish(),
  externalId: z.boolean().nullish(),
  lookUpType: z.string().nullish(),
  anonymizerType: z.looseObject({type: z.string().nullish()}).nullish(),
})
export type TemplateColumn = z.infer<typeof TemplateColumnSchema>

export const RawFilterSchema = z.looseObject({
  order: z.number(),
  fieldName: z.string().nullish(), // "<Label>-<ApiName>", e.g. "Account Type-Type"
  fieldLabel: z.string().nullish(),
  fieldType: z.string().nullish(),
  operator: z.string().nullish(),
  input: z.unknown().optional(),
  finalValue: z.string().nullish(),
  isValid: z.boolean().nullish(),
})
export type RawFilter = z.infer<typeof RawFilterSchema>

export const IdGenerationSchema = z.looseObject({
  generateExternalId: z.boolean().nullish(),
  needsHashing: z.boolean().nullish(),
  fields: z.array(z.unknown()).nullish(),
  recordMatchingFormulaId: z.string().nullish(),
  recordMatchingFormulaName: z.string().nullish(),
})

export const TemplateObjectDetailSchema = z.looseObject({
  templateId: z.string(),
  templateName: z.string().nullish(),
  apiName: z.string().nullish(),
  table: z.string(),
  autoUpdate: z.string().nullish(),
  batchSize: z.number().nullish(),
  limit: z.number().nullish(),
  matchOwner: z.boolean().nullish(),
  matchRecordType: z.boolean().nullish(),
  attachmentOption: z.string().nullish(),
  fileOption: z.string().nullish(),
  queryTemplate: z.string().nullish(),
  continueOnError: z.string().nullish(),
  filters: z.array(z.string()).nullish(),
  rawFilters: z.array(RawFilterSchema).nullish(),
  columns: z.array(TemplateColumnSchema),
  externalIdField: z.string().nullish(),
  externalIdGeneration: IdGenerationSchema.nullish(),
  virtualIdGeneration: IdGenerationSchema.nullish(),
  virtualExternalIdEnabled: z.boolean().nullish(),
  parentTemplates: z.array(z.unknown()).nullish(),
  childTemplates: z.array(z.unknown()).nullish(),
})
export type TemplateObjectDetail = z.infer<typeof TemplateObjectDetailSchema>

export const TemplateDetailSchema = z.looseObject({
  /** Schema marker: 2 for v2 documents. Not a revision counter. */
  version: z.number(),
  templateName: z.string(),
  templateApiName: z.string().nullish(),
  templateId: z.string(),
  mainObject: z.looseObject({apiName: z.string(), label: z.string().nullish()}).nullish(),
  application: z.string().nullish(),
  applicationModule: z.string().nullish(),
  status: z.string().nullish(),
  schemaCredential: z.string().nullish(),
  details: z.array(TemplateObjectDetailSchema),
})
export type TemplateDetail = z.infer<typeof TemplateDetailSchema>

/** `data template get` returns `{ [templateId]: TemplateObjectDetail }` (selected columns only). */
export const TemplateGraphSchema = z.record(z.string(), TemplateObjectDetailSchema)
export type TemplateGraph = z.infer<typeof TemplateGraphSchema>

// ---------- filters & formulas (separate resources) ----------

export const AdvancedFilterSchema = z.looseObject({
  uuid: z.string(),
  filterName: z.string().nullish(),
  objects: z.array(z.unknown()).nullish(),
})
export type AdvancedFilter = z.infer<typeof AdvancedFilterSchema>
export const AdvancedFilterListSchema = z.array(AdvancedFilterSchema)

export const RecordMatchingFormulaSchema = z.looseObject({
  id: z.string(),
  name: z.string().nullish(),
  objectApiName: z.string().nullish(),
  hashFormula: z.boolean().nullish(),
})
export type RecordMatchingFormula = z.infer<typeof RecordMatchingFormulaSchema>
export const RecordMatchingFormulaListSchema = z.array(RecordMatchingFormulaSchema)

export const SaveDetailResultSchema = z.unknown()

/** `data records search`: Copado's record selection for a template (used to build data commits). */
export const RecordSearchSchema = z.looseObject({
  totalRecords: z.number().nullish(),
  /** The template configuration the engine used, keyed by template Id (selected columns only). */
  detail: z.record(z.string(), TemplateObjectDetailSchema).nullish(),
  data: z.array(z.looseObject({id: z.string().nullish()})).nullish(),
})
export type RecordSearch = z.infer<typeof RecordSearchSchema>
