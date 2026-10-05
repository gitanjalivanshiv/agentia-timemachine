/**
 * Time Machine as an MCP server (`agentia timemachine mcp`).
 *
 * Agentia plugins cannot add tools to `agentia mcp start`, so Time Machine ships its own stdio server that
 * any MCP client can run next to Copado's. Every tool runs the Time Machine CLI (`agentia timemachine … --json`)
 * so all safety rules apply unchanged, and writes are two-step: a *_preview tool returns a `previewId`, and the
 * matching *_apply tool only runs with that id and `confirmed: true`. An agent cannot save what nobody saw.
 */
import {spawn} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js'
import {z} from 'zod'

/** Runs `agentia timemachine <args> --json` and returns the parsed envelope. */
export type TimemachineRunner = (args: string[]) => Promise<{exitCode: number; envelope: Envelope}>

export interface Envelope {
  status?: number
  result?: unknown
  error?: {code?: string; message?: string; hint?: string; [k: string]: unknown}
}

export interface ServerOptions {
  /** Workspace root (contains .timemachine/). */
  root: string
  run: TimemachineRunner
  version: string
  /** How long a preview stays valid. */
  previewTtlMs?: number
}

interface EditPreview {
  kind: 'edit'
  template: string
  file: string
  base?: string
  merge?: boolean
  createdAt: number
}

interface RestorePreview {
  kind: 'restore'
  template: string
  to: string
  createdAt: number
}

export const INSTRUCTIONS = `Time Machine versions Copado Release Data Templates: snapshot to git, readable diffs, safe edits, one-command restore.
Rules for changing a template:
1. tm_status, then tm_snapshot the template (reason = what the user asked).
2. Read the base document: .timemachine/templates/<slug>/template.json (slug from tm_status). Build the COMPLETE edited
   document, changing only what the user asked (adding a field = set "isSelected": true on its entry in details[].columns).
3. tm_edit_preview → show the user the statements → ask for confirmation.
4. Only after the user agrees: tm_edit_apply with the previewId and confirmed=true.
5. CONFLICT (someone changed the template meanwhile): stop, show theirs/yours/conflicts, ask. If mergeable, offer merge=true.
To undo: tm_history → tm_restore_preview → confirm → tm_restore_apply.
Never call agentia cicd data template save-detail directly for a tracked template.`

const READ = {readOnlyHint: true, destructiveHint: false, openWorldHint: true} as const
const ORG_WRITE = {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true} as const

export function createServer(options: ServerOptions): McpServer {
  const {root, run} = options
  const ttl = options.previewTtlMs ?? 30 * 60_000
  const previews = new Map<string, EditPreview | RestorePreview>()
  const server = new McpServer({name: 'timemachine', version: options.version}, {instructions: INSTRUCTIONS})

  const call = async (
    args: string[],
    summarise?: (result: unknown) => string,
    extra?: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    const {exitCode, envelope} = await run(args)
    if (envelope.error) return errorResult(envelope)
    const body = extra ? {...(envelope.result as object), ...extra} : envelope.result
    const content: CallToolResult['content'] = []
    if (summarise) content.push({type: 'text', text: summarise(envelope.result)})
    content.push({type: 'text', text: JSON.stringify(body, null, 2)})
    // Partial failures (e.g. one snapshot failed) come back as a result with a non-zero status.
    return {content, isError: exitCode !== 0 && envelope.status !== 0 ? true : undefined}
  }

  const takePreview = <K extends 'edit' | 'restore'>(
    id: string,
    kind: K,
  ): Extract<EditPreview | RestorePreview, {kind: K}> | CallToolResult => {
    const preview = previews.get(id)
    if (!preview || preview.kind !== kind)
      return toolError('PREVIEW_REQUIRED', `Unknown previewId. Call tm_${kind}_preview first and show the user the result.`)
    if (Date.now() - preview.createdAt > ttl) {
      previews.delete(id)
      return toolError('PREVIEW_EXPIRED', `The preview expired. Call tm_${kind}_preview again.`)
    }
    previews.delete(id) // one apply per preview
    return preview as Extract<EditPreview | RestorePreview, {kind: K}>
  }

  // ---------- read-only ----------

  server.registerTool(
    'tm_status',
    {
      title: 'Template status',
      description: 'Tracked data templates: in sync / drifted / never snapshotted, v2 or legacy, saveable, edits in progress.',
      inputSchema: {templates: z.array(z.string()).optional().describe('Template names, Ids or slugs (default: all tracked).')},
      annotations: READ,
    },
    async ({templates}) => call(['status', ...(templates ?? [])]),
  )

  server.registerTool(
    'tm_history',
    {
      title: 'Template history',
      description:
        'Snapshot timeline of a template: ref, date, author, hash, change summary, reason. Use ref with tm_diff / tm_restore_preview.',
      inputSchema: {template: z.string(), limit: z.number().int().positive().optional()},
      annotations: READ,
    },
    async ({template, limit}) => call(['history', template, ...(limit ? ['--limit', String(limit)] : [])]),
  )

  server.registerTool(
    'tm_diff',
    {
      title: 'Diff a template',
      description: 'Readable diff between two versions (snapshot refs or "live"). Default: last snapshot → live.',
      inputSchema: {template: z.string(), from: z.string().optional(), to: z.string().optional().describe('A ref or "live" (default).')},
      annotations: READ,
    },
    async ({template, from, to}) =>
      call(['diff', template, ...(from ? ['--from', from] : []), ...(to ? ['--to', to] : [])], (r) => statementsText(r)),
  )

  server.registerTool(
    'tm_lint',
    {
      title: 'Lint templates',
      description: 'Checks templates for mistakes (missing filter or record limit, unquoted filter values, Id-only matching, …).',
      inputSchema: {templates: z.array(z.string()).optional(), ref: z.string().optional().describe('Git ref or "live" (default HEAD).')},
      annotations: READ,
    },
    async ({templates, ref}) => call(['lint', ...(templates ?? []), ...(ref ? ['--ref', ref] : [])]),
  )

  server.registerTool(
    'tm_verify',
    {
      title: 'Verify what Copado uses',
      description:
        "Checks that Copado's data engine (record selection) uses the live v2 template document: fields, filters, limit, batch size. Reports how many records match, never their values.",
      inputSchema: {templates: z.array(z.string()).optional()},
      annotations: READ,
    },
    async ({templates}) => call(['verify', ...(templates ?? [])]),
  )

  server.registerTool(
    'tm_plan',
    {
      title: 'Plan committed changes',
      description: 'What applying the committed template versions (git ref, default HEAD) would change in Copado.',
      inputSchema: {templates: z.array(z.string()).optional(), ref: z.string().optional()},
      annotations: READ,
    },
    async ({templates, ref}) => call(['plan', ...(templates ?? []), ...(ref ? ['--ref', ref] : [])]),
  )

  // ---------- local write (git only) ----------

  server.registerTool(
    'tm_snapshot',
    {
      title: 'Snapshot templates',
      description:
        'Records the live state of templates in git (commits only when something changed). Always do this before changing a template.',
      inputSchema: {
        templates: z.array(z.string()).optional(),
        all: z.boolean().optional().describe('Snapshot every tracked template.'),
        reason: z.string().optional(),
      },
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
    },
    async ({templates, all, reason}) => {
      if (!all && !templates?.length) return toolError('USAGE', 'Name templates or set all=true.')
      return call(['snapshot', ...(templates ?? []), ...(all ? ['--all'] : []), ...(reason ? ['--reason', reason] : [])])
    },
  )

  // ---------- org writes: preview → apply ----------

  server.registerTool(
    'tm_edit_preview',
    {
      title: 'Preview a template edit',
      description:
        'Shows what saving an edited v2 template document would change, and checks that nobody changed the template since its base (last snapshot). Writes nothing. Returns a previewId for tm_edit_apply. Show the statements to the user and get their confirmation before applying.',
      inputSchema: {
        template: z.string(),
        document: z.record(z.string(), z.unknown()).optional().describe('The COMPLETE edited v2 detail document.'),
        file: z.string().optional().describe('Or: path to a file with the edited document (relative to the workspace).'),
        base: z.string().optional().describe('"live" or a snapshot ref (default: last snapshot).'),
        merge: z
          .boolean()
          .optional()
          .describe('If the template changed meanwhile and nothing overlaps, apply on top of the current version.'),
      },
      annotations: READ,
    },
    async ({template, document, file, base, merge}) => {
      if (!document === !file) return toolError('USAGE', 'Pass exactly one of document or file.')
      let docFile: string
      if (document) {
        const dir = path.join(root, '.timemachine', '.lock', 'mcp')
        fs.mkdirSync(dir, {recursive: true})
        const digest = createHash('sha256').update(JSON.stringify(document)).digest('hex').slice(0, 16)
        docFile = path.join(dir, `${digest}.json`)
        fs.writeFileSync(docFile, `${JSON.stringify(document, null, 2)}\n`)
      } else {
        docFile = path.resolve(root, file!)
      }
      const args = ['edit', template, '--file', docFile, '--dry-run', ...(base ? ['--base', base] : []), ...(merge ? ['--merge'] : [])]
      const {exitCode, envelope} = await run(args)
      if (envelope.error) return errorResult(envelope)
      const result = envelope.result as {outcome?: string; statements?: unknown[]}
      if (result.outcome === 'no-changes') return call(args, () => 'No changes compared with the base. Nothing to save.')
      const previewId = randomUUID()
      previews.set(previewId, {kind: 'edit', template, file: docFile, base, merge, createdAt: Date.now()})
      return {
        content: [
          {
            type: 'text',
            text: `${statementsText(result)}\n\nShow this to the user. If they agree, call tm_edit_apply with previewId ${previewId} and confirmed=true.`,
          },
          {type: 'text', text: JSON.stringify({...result, previewId}, null, 2)},
        ],
        isError: exitCode !== 0 ? true : undefined,
      }
    },
  )

  server.registerTool(
    'tm_edit_apply',
    {
      title: 'Save a previewed template edit',
      description:
        'Saves the edit from tm_edit_preview through the safe write path: concurrency re-check, pre-change snapshot, save, read-back verification, post-change snapshot. Only call after the user confirmed the preview. Returns an undo command.',
      inputSchema: {
        previewId: z.string(),
        confirmed: z.literal(true).describe('Set to true only after the user approved the previewed changes.'),
        reason: z.string().optional(),
      },
      annotations: ORG_WRITE,
    },
    async ({previewId, reason}) => {
      const p = takePreview(previewId, 'edit')
      if ('content' in p) return p
      return call(
        [
          'edit',
          p.template,
          '--file',
          p.file,
          '--yes',
          ...(p.base ? ['--base', p.base] : []),
          ...(p.merge ? ['--merge'] : []),
          ...(reason ? ['--reason', reason] : []),
        ],
        (r) => appliedText(r),
      )
    },
  )

  server.registerTool(
    'tm_restore_preview',
    {
      title: 'Preview a restore',
      description:
        'Shows what restoring a template to an earlier snapshot would change. Writes nothing. Returns a previewId for tm_restore_apply.',
      inputSchema: {template: z.string(), to: z.string().describe('Snapshot ref from tm_history.')},
      annotations: READ,
    },
    async ({template, to}) => {
      const {exitCode, envelope} = await run(['restore', template, '--to', to, '--dry-run'])
      if (envelope.error) return errorResult(envelope)
      const result = envelope.result as {outcome?: string}
      if (result.outcome === 'already-current')
        return {content: [{type: 'text', text: `The template already matches ${to}. Nothing to restore.`}]}
      const previewId = randomUUID()
      previews.set(previewId, {kind: 'restore', template, to, createdAt: Date.now()})
      return {
        content: [
          {
            type: 'text',
            text: `${statementsText(result)}\n\nShow this to the user. If they agree, call tm_restore_apply with previewId ${previewId} and confirmed=true.`,
          },
          {type: 'text', text: JSON.stringify({...result, previewId}, null, 2)},
        ],
        isError: exitCode !== 0 ? true : undefined,
      }
    },
  )

  server.registerTool(
    'tm_restore_apply',
    {
      title: 'Restore a template',
      description:
        'Restores the previewed version (pre-change snapshot, save, verification, post-change snapshot). Only after the user confirmed. Returns an undo command.',
      inputSchema: {previewId: z.string(), confirmed: z.literal(true)},
      annotations: ORG_WRITE,
    },
    async ({previewId}) => {
      const p = takePreview(previewId, 'restore')
      if ('content' in p) return p
      return call(['restore', p.template, '--to', p.to, '--yes'], (r) => appliedText(r))
    },
  )

  // ---------- prompt ----------

  server.registerPrompt(
    'safe_template_change',
    {
      title: 'Change a data template safely',
      description: 'Guides the agent through snapshot → edit → preview → confirm → apply for one template.',
      argsSchema: {template: z.string(), request: z.string().describe('What should change, in plain words.')},
    },
    ({template, request}) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Change the Copado data template "${template}": ${request}\n\nFollow the Time Machine rules exactly:\n${INSTRUCTIONS}`,
          },
        },
      ],
    }),
  )

  return server
}

/** Spawns `agentia timemachine …` (the same CLI that started this server). */
export function spawnRunner(root: string, bin = process.env.TM_MCP_AGENTIA_BIN, timeoutMs = 5 * 60_000): TimemachineRunner {
  // Default: re-run the host CLI that launched us (node <agentia bin> timemachine …).
  const [command, prefix] = bin ? [bin, [] as string[]] : [process.execPath, [process.argv[1]]]
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, [...prefix, 'timemachine', ...args, '--json'], {
        cwd: root,
        env: {...process.env, NO_COLOR: '1'},
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const out: Buffer[] = []
      child.stdout.on('data', (c: Buffer) => out.push(c))
      child.stderr.resume() // warnings/spinners; never forwarded to the MCP stdout
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const text = Buffer.concat(out).toString('utf8')
        const start = text.indexOf('{')
        try {
          resolve({exitCode: code ?? 1, envelope: JSON.parse(start >= 0 ? text.slice(start) : text) as Envelope})
        } catch {
          resolve({
            exitCode: code ?? 1,
            envelope: {error: {code: 'UNEXPECTED_OUTPUT', message: text.trim().slice(0, 500) || `exit code ${code}`}},
          })
        }
      })
    })
}

// ---------- helpers ----------

function errorResult(envelope: Envelope): CallToolResult {
  return {content: [{type: 'text', text: JSON.stringify(envelope.error, null, 2)}], isError: true}
}

function toolError(code: string, message: string): CallToolResult {
  return {content: [{type: 'text', text: JSON.stringify({code, message})}], isError: true}
}

function statementsText(result: unknown): string {
  const r = result as {statements?: {sign: string; text: string}[]; summary?: {added: number; removed: number; changed: number}}
  const lines = (r.statements ?? []).map((s) => `${s.sign} ${s.text}`)
  if (lines.length === 0) return 'No differences.'
  const s = r.summary
  return `${lines.join('\n')}${s ? `\n\n${s.added} added · ${s.removed} removed · ${s.changed} changed` : ''}`
}

function appliedText(result: unknown): string {
  const r = result as {apply?: {after?: {hash?: string}}; undo?: string; merged?: boolean}
  return `Saved and verified${r.merged ? ' (merged with the current version)' : ''} (hash ${r.apply?.after?.hash?.slice(0, 12) ?? '?'}). Undo: ${r.undo ?? 'see tm_history'}`
}
