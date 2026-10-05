/**
 * Verify: does Copado's data engine use the document Time Machine versions?
 *
 * `agentia cicd data records search` returns the template configuration the engine used to select records. We
 * compare what matters for a deployment (selected fields, filters, record limit, batch size, external Id field)
 * with the live v2 detail document. Phase 0 showed the Copado UI can hold a different copy for converted templates;
 * this check shows which configuration really drives data selection. Record values are never returned.
 */
import type {TemplateDetail, TemplateObjectDetail} from '../agentia/schemas.js'

export interface EngineView {
  fields: string[]
  filters: string[]
  limit: number | null
  batchSize: number | null
  externalIdField: string | null
}

export interface VerifyDifference {
  aspect: 'fields' | 'filters' | 'limit' | 'batchSize' | 'externalIdField' | 'missing'
  document: unknown
  engine: unknown
  message: string
}

export function viewOf(d: TemplateObjectDetail, selectedOnly: boolean): EngineView {
  return {
    fields: d.columns
      .filter((c) => !selectedOnly || c.isSelected !== false)
      .map((c) => c.name)
      .sort(),
    filters: [...(d.filters ?? [])],
    limit: d.limit ?? null,
    batchSize: d.batchSize ?? null,
    externalIdField: d.externalIdField ?? null,
  }
}

/** Compares the engine's configuration with the document's main object. */
export function compareWithEngine(
  document: TemplateDetail,
  engine: TemplateObjectDetail | undefined,
): {document: EngineView; engine?: EngineView; differences: VerifyDifference[]} {
  const main = document.details.find((d) => d.templateId === document.templateId) ?? document.details[0]
  const doc = viewOf(main, true)
  if (!engine)
    return {
      document: doc,
      differences: [
        {aspect: 'missing', document: doc, engine: null, message: 'Copado returned no template configuration for this template.'},
      ],
    }
  const eng = viewOf(engine, true)
  const differences: VerifyDifference[] = []
  const onlyDoc = doc.fields.filter((f) => !eng.fields.includes(f))
  const onlyEng = eng.fields.filter((f) => !doc.fields.includes(f))
  if (onlyDoc.length > 0 || onlyEng.length > 0) {
    const parts = [
      onlyEng.length > 0 ? `queries ${onlyEng.join(', ')} (not selected in the document)` : '',
      onlyDoc.length > 0 ? `skips ${onlyDoc.join(', ')} (selected in the document)` : '',
    ]
    differences.push({
      aspect: 'fields',
      document: doc.fields,
      engine: eng.fields,
      message: `The engine ${parts.filter(Boolean).join(' and ')}.`,
    })
  }
  if (JSON.stringify(doc.filters) !== JSON.stringify(eng.filters)) {
    differences.push({
      aspect: 'filters',
      document: doc.filters,
      engine: eng.filters,
      message: `The engine filters by ${eng.filters.join(' AND ') || '(nothing)'}, the document by ${doc.filters.join(' AND ') || '(nothing)'}.`,
    })
  }
  for (const aspect of ['limit', 'batchSize', 'externalIdField'] as const) {
    if (doc[aspect] !== eng[aspect])
      differences.push({
        aspect,
        document: doc[aspect],
        engine: eng[aspect],
        message: `${aspect}: engine ${eng[aspect]}, document ${doc[aspect]}.`,
      })
  }
  return {document: doc, engine: eng, differences}
}
