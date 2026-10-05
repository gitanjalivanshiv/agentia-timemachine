import {matchTemplate, type AgentiaClient} from '../agentia/client.js'
import {TemplateNotFoundError} from '../agentia/errors.js'
import type {TemplateListItem} from '../agentia/schemas.js'
import type {Config, TrackedTemplate} from '../store/config.js'

export interface Targets {
  templates: TemplateListItem[]
  /** Tracked templates that no longer exist in Copado. */
  missing: TrackedTemplate[]
}

/**
 * Turns command arguments into listed templates with a single `list` call.
 * - refs: template names, Ids, or tracked slugs (`tm-demo-accounts-new`)
 * - none: the tracked templates from config.json (the shared-playground rule: only named templates)
 */
export async function resolveTargets(client: AgentiaClient, config: Config, refs: string[]): Promise<Targets> {
  const all = await client.listTemplates()
  if (refs.length > 0) {
    const templates = refs.map((ref) => {
      const tracked = config.templates.find((t) => t.slug === ref)
      return matchTemplate(all, tracked ? tracked.id : ref)
    })
    return {templates: dedupe(templates), missing: []}
  }
  const templates: TemplateListItem[] = []
  const missing: TrackedTemplate[] = []
  for (const tracked of config.templates) {
    try {
      templates.push(matchTemplate(all, tracked.id))
    } catch (error) {
      if (!(error instanceof TemplateNotFoundError)) throw error
      missing.push(tracked)
    }
  }
  return {templates, missing}
}

function dedupe(templates: TemplateListItem[]): TemplateListItem[] {
  return [...new Map(templates.map((t) => [t.id, t])).values()]
}

/** Tracked templates (all, or the named ones) paired with their live list entries. Fails if one is gone. */
export async function resolveTracked(
  client: AgentiaClient,
  config: Config,
  refs: string[],
): Promise<{tracked: TrackedTemplate; listed: TemplateListItem}[]> {
  const all = await client.listTemplates()
  const chosen =
    refs.length === 0
      ? config.templates
      : refs.map((ref) => {
          const r = ref.trim().toLowerCase()
          const t = config.templates.find(
            (x) => x.id === ref || x.slug === r || x.name.toLowerCase() === r || x.id.slice(0, 15) === ref.slice(0, 15),
          )
          if (!t)
            throw new TemplateNotFoundError(ref, {hint: 'Only tracked templates can be planned or applied. See .timemachine/config.json.'})
          return t
        })
  return chosen.map((tracked) => ({tracked, listed: matchTemplate(all, tracked.id)}))
}
