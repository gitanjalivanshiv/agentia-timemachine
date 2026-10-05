import {z} from 'zod'

import {DEFAULT_KEYS, type KeyMap} from '../core/canonical.js'

export const TrackedTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Folder under `.timemachine/templates/`. Stable even if the template is renamed in Copado. */
  slug: z.string(),
})
export type TrackedTemplate = z.infer<typeof TrackedTemplateSchema>

export const ConfigSchema = z.object({
  version: z.literal(1),
  /** The only templates timemachine operates on by default (shared-playground rule). */
  templates: z.array(TrackedTemplateSchema).default([]),
  /** Overrides/additions to the natural keys used for diffs and hashing. */
  keys: z.record(z.string(), z.string()).default({}),
  /** Schema paths hidden from diff output (never from hashing), e.g. `details[].columns[].anonymizerType`. */
  ignore: z.array(z.string()).default([]),
  /**
   * Optional lock file shared with other tools writing to the same org (e.g. `~/hackathon/.org-busy`).
   * Writes refuse to start while it exists and hold it while they run.
   */
  orgBusyFile: z.string().optional(),
  /** `timemachine lint` settings. */
  lint: z
    .object({
      disable: z.array(z.string()).optional(),
      highVolumeObjects: z.array(z.string()).optional(),
      highVolumeLimit: z.number().optional(),
    })
    .optional(),
})
export type Config = z.infer<typeof ConfigSchema>

export function defaultConfig(): Config {
  return {version: 1, templates: [], keys: {}, ignore: []}
}

export function keyMap(config: Config): KeyMap {
  return {...DEFAULT_KEYS, ...config.keys}
}

/** Folder-safe slug: "TM Demo – Accounts New" → "tm-demo-accounts-new". */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'template'
}

/** A slug for a new template that does not collide with other tracked templates. */
export function uniqueSlug(config: Config, name: string, id: string): string {
  const base = slugify(name)
  const taken = config.templates.some((t) => t.slug === base && t.id !== id)
  return taken ? `${base}-${id.slice(-6).toLowerCase()}` : base
}
