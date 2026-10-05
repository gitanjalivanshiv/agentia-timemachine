import {spawnSync} from 'node:child_process'
import fs from 'node:fs'

import {Args, Flags} from '@oclif/core'

import {matchTemplate, type AgentiaClient} from '../../agentia/client.js'
import {
  ConcurrencyError,
  ConfirmationRequiredError,
  EditInProgressError,
  ExitCode,
  InvalidDocumentError,
  NoEditSessionError,
  SaveBlockedError,
  TimemachineError,
} from '../../agentia/errors.js'
import {TemplateDetailSchema, type TemplateDetail, type TemplateListItem} from '../../agentia/schemas.js'
import {TimemachineCommand} from '../../base-command.js'
import {applyDetail, type ApplyResult} from '../../core/apply.js'
import {hashDocument, shortHash} from '../../core/canonical.js'
import {threeWay, type ThreeWay} from '../../core/conflict.js'
import {describeChanges, formatStatementSummary, summariseStatements, type Statement} from '../../core/describe.js'
import {diffTemplates} from '../../core/differ.js'
import {EditSessions, type EditSession} from '../../core/edit-session.js'
import {findSaveBlockers} from '../../core/inspect.js'
import {checkOrgBusy, resolveLockPath} from '../../core/org-lock.js'
import {applyChanges} from '../../core/merge.js'
import {fetchLive, type LiveTemplate} from '../../core/snapshot.js'
import {renderText, renderThreeWay} from '../../render/diff.js'
import {confirm, isInteractive} from '../../render/prompt.js'
import {style} from '../../render/style.js'
import {keyMap, slugify, type Config, type TrackedTemplate} from '../../store/config.js'
import {Store} from '../../store/store.js'
import {loadSnapshot} from './diff.js'
import {findTracked} from './history.js'

export interface EditResult {
  template: {id: string; name: string; slug: string}
  outcome: 'started' | 'aborted' | 'applied' | 'no-changes' | 'dry-run' | 'cancelled'
  base?: {hash: string; source: string}
  session?: {name: string; file: string}
  statements?: Statement[]
  apply?: ApplyResult
  /** True when the save merged your changes onto a newer live version (--merge). */
  merged?: boolean
  undo?: string
}

interface Base {
  doc: TemplateDetail
  hash: string
  /** Human description: "edit session started 10:02", "snapshot 36e5bbd", "live". */
  source: string
}

export default class TimemachineEdit extends TimemachineCommand {
  static override summary = "Edit a data template safely: preview the change and refuse to overwrite anyone else's."
  static override description = `Every edit starts from a base version. Before saving, timemachine re-reads the template; if it changed since
your base (someone else saved), the save is blocked and you see their changes, yours, and any conflicts.
Nothing is ever overwritten silently.

  Interactive:   edit <template>                       opens $EDITOR, previews, confirms, saves
  Two steps:     edit <template> --start               writes a working copy and prints its path
                 edit <template> --apply [--file f]    previews and saves (blocked if live moved)
                 edit <template> --abort               discards the edit
  Agents / CI:   edit <template> --file new.json --yes  base = last snapshot (or --base live|<ref>)

Saving goes through the same path as restore: pre-change snapshot, save, read-back verification,
post-change snapshot and an undo command.`

  static override examples = [
    '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New"',
    '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New" --start --session alice',
    '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New" --apply --session alice',
    '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New" --file new-detail.json --yes --json',
  ]

  static override args = {
    template: Args.string({description: 'Tracked template name, Id or slug.', required: true}),
  }

  static override flags = {
    file: Flags.string({char: 'f', description: 'Edited v2 detail document (JSON) to save.'}),
    start: Flags.boolean({description: 'Start an edit session and write a working copy.', exclusive: ['apply', 'abort']}),
    apply: Flags.boolean({description: 'Save the edit session (or --file) after a preview.', exclusive: ['start', 'abort']}),
    abort: Flags.boolean({description: 'Discard the edit session.', exclusive: ['start', 'apply']}),
    session: Flags.string({description: 'Edit session name (default: your git user name). Lets several people edit at once.'}),
    base: Flags.string({
      description: 'With --file and no session: the version your edit is based on ("live" or a snapshot ref). Default: last snapshot.',
    }),
    reason: Flags.string({char: 'r', description: 'Why (stored in the snapshot commit).'}),
    yes: Flags.boolean({char: 'y', description: 'Do not ask for confirmation.'}),
    'dry-run': Flags.boolean({description: 'Preview only; write nothing.'}),
    'ignore-busy': Flags.boolean({description: 'Proceed even if the shared org lock file exists.'}),
    merge: Flags.boolean({
      description: 'If the template changed meanwhile and nothing overlaps, re-apply your changes on top of the current version.',
    }),
  }

  private store!: Store
  private workspaceConfig!: Config
  private tracked!: TrackedTemplate

  public async run(): Promise<EditResult> {
    const {args, flags} = await this.parse(TimemachineEdit)
    this.store = Store.require(process.cwd())
    this.workspaceConfig = this.store.loadConfig()
    this.tracked = findTracked(this.workspaceConfig.templates, args.template)
    const sessions = new EditSessions(this.store)
    const sessionName = slugify(flags.session ?? (await this.store.gitUser()))
    const existing = sessions.get(this.tracked.slug, sessionName)
    const id = {id: this.tracked.id, name: this.tracked.name, slug: this.tracked.slug}

    if (flags.abort) {
      if (!existing) throw new NoEditSessionError(this.tracked.name, sessionName)
      sessions.remove(existing)
      if (!this.jsonEnabled()) this.log(`${style.green('✔')} Discarded the edit of ${this.tracked.name} (session ${sessionName}).`)
      return {template: id, outcome: 'aborted'}
    }

    const client = this.createClient(this.store.root)
    const agentiaVersion = await client.assertSupportedVersion()
    const template = matchTemplate(await client.listTemplates(), this.tracked.id)

    if (flags.start) {
      if (existing) throw new EditInProgressError(this.tracked.name, sessionName, existing.info.startedAt, existing.editFile)
      const session = await this.startSession(client, sessions, template, sessionName)
      if (!this.jsonEnabled()) {
        this.log(
          `${style.green('✔')} Edit of ${style.bold(this.tracked.name)} started from ${shortHash(session.info.baseHash)} (session ${sessionName}).`,
        )
        this.log(`  Edit:  ${style.cyan(session.editFile)}`)
        this.log(
          `  Save:  ${style.cyan(`agentia timemachine edit "${this.tracked.name}" --apply${flags.session ? ` --session ${flags.session}` : ''}`)}`,
        )
      }
      return {
        template: id,
        outcome: 'started',
        base: {hash: session.info.baseHash, source: 'live'},
        session: {name: sessionName, file: session.editFile},
      }
    }

    if (flags.apply) {
      if (!existing) throw new NoEditSessionError(this.tracked.name, sessionName)
      const base = this.sessionBase(sessions, existing)
      const edited = readDocument(flags.file ?? existing.editFile)
      return this.save(client, template, base, edited, flags, agentiaVersion, existing, sessions)
    }

    if (flags.file) {
      if (existing) throw new EditInProgressError(this.tracked.name, sessionName, existing.info.startedAt, existing.editFile)
      const base = await this.resolveBase(client, template, flags.base)
      return this.save(client, template, base, readDocument(flags.file), flags, agentiaVersion)
    }

    // Interactive: start a session, open the editor, then save.
    if (existing) throw new EditInProgressError(this.tracked.name, sessionName, existing.info.startedAt, existing.editFile)
    if (this.jsonEnabled() || !isInteractive()) {
      throw new TimemachineError('CONFIRMATION_REQUIRED', 'Interactive editing needs a terminal.', ExitCode.Usage, {
        hint: 'Use --file <edited.json> (agents/CI), or --start then --apply.',
      })
    }
    const session = await this.startSession(client, sessions, template, sessionName)
    openEditor(session.editFile)
    const edited = readDocument(session.editFile)
    return this.save(client, template, this.sessionBase(sessions, session), edited, flags, agentiaVersion, session, sessions)
  }

  private async startSession(
    client: AgentiaClient,
    sessions: EditSessions,
    template: TemplateListItem,
    session: string,
  ): Promise<EditSession> {
    const live = await fetchLive(client, template, this.workspaceConfig)
    return sessions.start(
      {
        templateId: template.id,
        name: template.name,
        slug: this.tracked.slug,
        session,
        baseHash: live.hash,
        baseLastModified: template.lastModified ?? null,
        startedAt: new Date().toISOString(),
        startedBy: await this.store.gitUser(),
      },
      live.detail,
    )
  }

  private sessionBase(sessions: EditSessions, session: EditSession): Base {
    const doc = TemplateDetailSchema.parse(sessions.readBase(session))
    return {doc, hash: session.info.baseHash, source: `edit session "${session.info.session}" started ${session.info.startedAt}`}
  }

  /** Base for one-shot --file edits: last snapshot by default (what an agent read), or live, or a ref. */
  private async resolveBase(client: AgentiaClient, template: TemplateListItem, base?: string): Promise<Base> {
    const keys = keyMap(this.workspaceConfig)
    let ref = base
    if (!ref) ref = (await this.store.history(this.tracked.slug, 1))[0]?.commit ?? 'live'
    if (ref === 'live') {
      const live = await fetchLive(client, template, this.workspaceConfig)
      return {doc: live.detail, hash: live.hash, source: 'live (read just now)'}
    }
    const state = await loadSnapshot(this.store, this.tracked, ref)
    const doc = TemplateDetailSchema.parse(state.detail)
    return {doc, hash: hashDocument(doc, keys), source: `snapshot ${ref.slice(0, 7)}`}
  }

  private async save(
    client: AgentiaClient,
    template: TemplateListItem,
    base: Base,
    edited: {doc: TemplateDetail; file: string},
    flags: {yes: boolean; 'dry-run': boolean; 'ignore-busy': boolean; merge: boolean; reason?: string},
    agentiaVersion: string,
    session?: EditSession,
    sessions?: EditSessions,
  ): Promise<EditResult> {
    const keys = keyMap(this.workspaceConfig)
    const id = {id: this.tracked.id, name: this.tracked.name, slug: this.tracked.slug}
    if (edited.doc.templateId !== template.id) {
      throw new InvalidDocumentError(edited.file, `it belongs to template ${edited.doc.templateId}, not ${template.id}.`)
    }
    const statements = describeChanges(diffTemplates({detail: base.doc}, {detail: edited.doc}, {keys, ignore: this.workspaceConfig.ignore}))
    const result: EditResult = {template: id, outcome: 'no-changes', base: {hash: base.hash, source: base.source}, statements}
    if (session) result.session = {name: session.info.session, file: session.editFile}

    if (statements.length === 0) {
      if (session && sessions) sessions.remove(session)
      if (!this.jsonEnabled()) this.log('No changes. Nothing to save.')
      return result
    }

    if (!this.jsonEnabled()) {
      this.log(renderText(statements, summariseStatements(statements), {title: `Edit ${this.tracked.name}`, from: 'base', to: 'yours'}))
      this.log(style.dim(`Base: ${base.source}`))
    }
    const blockers = findSaveBlockers(edited.doc)
    if (blockers.length > 0)
      throw new SaveBlockedError(
        this.tracked.name,
        blockers.map((b) => b.fix),
      )

    // Early concurrency check, so people see a conflict before being asked to confirm.
    let target = edited.doc
    let expectedLiveHash = base.hash
    let merged = false
    const conflict = await this.liveConflict(client, template, base, edited)
    if (conflict) {
      if (!flags.merge || !conflict.view.disjoint) throw this.conflictError(conflict, base, edited, flags.merge)
      const yours = diffTemplates({detail: base.doc}, {detail: edited.doc}, {keys})
      target = applyChanges(conflict.live.detail, yours)
      expectedLiveHash = conflict.live.hash
      merged = true
      if (!this.jsonEnabled()) {
        this.log(`\n${style.yellow('↻')} ${this.tracked.name} changed in Copado after your edit started:`)
        for (const s of conflict.view.theirs) this.log(`    ${s.sign} ${s.text}`)
        this.log(`  ${style.green('Nothing overlaps')}: your changes will be applied on top of the current version (--merge).`)
      }
      const mergedBlockers = findSaveBlockers(target)
      if (mergedBlockers.length > 0)
        throw new SaveBlockedError(
          this.tracked.name,
          mergedBlockers.map((b) => b.fix),
        )
    }

    if (flags['dry-run']) {
      if (!this.jsonEnabled()) this.log(style.dim('\nDry run: nothing was written.'))
      return {...result, outcome: 'dry-run'}
    }
    checkOrgBusy(resolveLockPath(this.workspaceConfig.orgBusyFile), flags['ignore-busy'])
    if (!flags.yes) {
      if (this.jsonEnabled() || !isInteractive()) throw new ConfirmationRequiredError('Saving an edit')
      if (!(await confirm(`\nSave these changes to ${this.tracked.name} (${formatStatementSummary(summariseStatements(statements))})?`))) {
        if (!this.jsonEnabled())
          this.log(`Cancelled. Nothing was written.${session ? ` Your working copy is kept at ${session.editFile}.` : ''}`)
        return {...result, outcome: 'cancelled'}
      }
    }

    let apply: ApplyResult
    try {
      apply = await applyDetail({
        client,
        store: this.store,
        template,
        target,
        expectedLiveHash,
        action: 'edit',
        reasonBefore: 'before edit',
        reasonAfter: flags.reason ?? `edit${session ? ` (${session.info.session})` : ''}`,
        ignoreBusy: flags['ignore-busy'],
        agentiaVersion,
      })
    } catch (error) {
      if (error instanceof ConcurrencyError) {
        // Someone saved during the confirmation: show the three-way view against the newest version.
        const late = await this.liveConflict(client, template, base, edited)
        if (late) throw this.conflictError(late, base, edited, flags.merge)
      }
      throw error
    }
    if (session && sessions) sessions.remove(session)
    const undo = `agentia timemachine restore "${this.tracked.name}" --to ${apply.before.commit.slice(0, 7)}`
    if (!this.jsonEnabled()) {
      this.log(
        `\n${style.green('✔')} Saved ${style.bold(this.tracked.name)}${merged ? ' (merged with the current version)' : ''} and verified (hash ${shortHash(apply.after.hash)}).`,
      )
      this.log(`  Undo: ${style.cyan(undo)}`)
    }
    return {...result, outcome: 'applied', merged, apply, undo}
  }

  /** The live version and three-way view, if live no longer matches the base. */
  private async liveConflict(
    client: AgentiaClient,
    template: TemplateListItem,
    base: Base,
    edited: {doc: TemplateDetail; file: string},
  ): Promise<{live: LiveTemplate; view: ThreeWay} | undefined> {
    const live = await fetchLive(client, template, this.workspaceConfig)
    if (live.hash === base.hash) return undefined
    return {live, view: threeWay(base.doc, live.detail, edited.doc, keyMap(this.workspaceConfig))}
  }

  /** Prints the three-way view and builds the ConcurrencyError for a blocked save. */
  private conflictError(
    conflict: {live: LiveTemplate; view: ThreeWay},
    base: Base,
    edited: {doc: TemplateDetail; file: string},
    triedMerge: boolean,
  ): ConcurrencyError {
    const {view, live} = conflict
    if (!this.jsonEnabled()) this.log(`\n${renderThreeWay(this.tracked.name, view, edited.file)}\n`)
    const name = this.tracked.name
    return new ConcurrencyError(name, base.hash, live.hash, {
      hint: view.disjoint
        ? `Your changes do not overlap theirs. Re-run with --merge to apply them on top of the current version.`
        : `${triedMerge ? 'Cannot merge automatically: both sides changed the same thing. ' : ''}Resolve the conflicts with whoever changed it, then start again from the current version (\`agentia timemachine edit "${name}" --abort\`, then --start).`,
      theirs: view.theirs.map((s) => `${s.sign} ${s.text}`),
      yours: view.yours.map((s) => `${s.sign} ${s.text}`),
      conflicts: view.conflicts,
      mergeable: view.disjoint,
      keptFile: edited.file,
    })
  }
}

function readDocument(file: string): {doc: TemplateDetail; file: string} {
  let json: unknown
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : `not valid JSON (${(error as Error).message})`
    throw new InvalidDocumentError(file, reason)
  }
  const parsed = TemplateDetailSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new InvalidDocumentError(file, `${issue.path.join('.') || '(root)'}: ${issue.message}`)
  }
  return {doc: parsed.data, file}
}

function openEditor(file: string): void {
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
  const result = spawnSync(`${editor} "${file.replace(/"/g, '\\"')}"`, {stdio: 'inherit', shell: true})
  if (result.status !== 0) {
    throw new TimemachineError('INVALID_DOCUMENT', `The editor (${editor}) exited with code ${result.status}.`, ExitCode.Usage, {
      hint: `Your working copy is kept at ${file}. Save it with \`--apply\` or discard with --abort.`,
    })
  }
}
