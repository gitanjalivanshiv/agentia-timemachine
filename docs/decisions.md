# Decisions and deviations from the brief

Where the real CLI differs from the original build brief, the CLI wins and the change is recorded here.

## 2026-10-02 · Phase 0 (help/source discovery, pre-auth)

1. **Read/write commands are `get-detail` / `save-detail`.** The brief said "update the detail".
   The real commands are `agentia cicd data template get-detail ID` and
   `agentia cicd data template save-detail ID (--file|--stdin)`. `save-detail` is an HTTP PUT
   (full replace), which confirms the problem statement.
2. **`--json` errors go to stdout, not stderr**, as `{error:{message,name}, transactionId}` with exit 1.
   Success is `{result, status:0, transactionId}`. `AgentiaClient` parses stdout in both cases and
   classifies errors by message text, because `name` is generic (`"Error"`).
3. **Filters are separate resources** (`cicd data filter list|add|update|delete`, keyed by UUID).
   Plan: snapshot into `extras.json` unless Phase 0 shows they are embedded in the detail.
4. **Matching formulas are per sObject, not per template** (`cicd data formula list OBJECTAPINAME`).
   Plan: derive the object list from the detail document and snapshot the formulas for those objects. Restore
   will initially restore **detail only**. Formula/filter restore is a later decision, because formulas
   are shared across templates.
5. **There is no "field-sync group"** under that name. It is `cicd data sync preview-updates|apply`.
   It is another writer that can change templates, so drift detection must not assume only humans edit.
6. **`convert-old` exists** for legacy templates. timemachine will detect legacy templates and _suggest_
   it, but never run it automatically (it is a write).
7. **CI auth via env vars** (`AGENTIA_CICD_API_KEY`, `AGENTIA_CICD_BASE_URL`) is supported by the CLI.
   The GitHub Actions example will use repository secrets for these.
8. **Spawn `agentia` with cwd = project root.** Project-scoped auth is only found from the folder it was
   configured in. `AgentiaClient` takes an explicit `cwd`.
9. **Concurrency signal:** `list` exposes `lastModified`. Use it as a cheap pre-check, but keep the
   canonical-hash comparison as the authority until we confirm `save-detail` bumps `lastModified`.
10. **Error mapping by category:** `CicdGatewayError` carries `statusCode` + `categories`
    (`DAT-004` not found / no attachment, `LGN-001` source-org login failure). Exit 2 = oclif parse
    error with a huge JSON body, so we validate our own args first and never echo it.
11. **`template create` is not atomic.** It can error after creating the record. Demo/seed scripts must
    look the template up by name before (re)creating it.

## 2026-10-03 · Phase 0 blocker (resolved)

All Copado calls that need to log in to a source org fail with `LGN-001 Login service error: HTTP 500`
(502), for both Dev1-SFP and Dev2-SFP, while `environment auth status` reports both credentials
`validated: true`. Copado-side reads (`list`, `filter list`, `formula list`, environments) work.
Effect: the test template `TM Demo Accounts` exists but has no detail attachment, so `get-detail`
returns `DAT-004`/404. The `get-detail` shape, `save-detail` round-trip and legacy behaviour remain
unverified until this is resolved with Copado support.

**Resolution:** the playground user lacked the Copado Data Deployer licence. After assigning it, the
**credential had to be re-authenticated**. Only then did `LGN-001` stop (Dev1 works; Dev2, not
re-authenticated, still fails). The broken template was deleted and recreated; `get-detail` now works.
README troubleshooting must mention: _data deployer licence + re-authenticate the credential_.

12. **Diff keys (from real detail):** `details[]` by `templateId` (fallback `table`), `columns[]` by `name`.
    Field "removal" in the UI is likely `isSelected: true → false`; the differ renders that as
    "field X deselected", not as a removal. `version: 2` is a schema marker; a non-2 value means a legacy template.

13. **Install note:** on this Mac the global npm prefix is root-owned, so the CLI was installed with `sudo`.
    README should recommend a user-owned npm prefix so that `agentia plugins link` works without sudo.

## 2026-10-04 · Project moved to `~/hackathon/timemachine`, brief v2

- Brief v2 adds **positioning** (template versioning, not a backup/restore of record data) and
  **shared-playground rules** (Mutant session,
  `~/hackathon/.org-busy` lock, `TM Demo –` template prefix).
- Project moved from `~/AgentiaTimemachine` with full git history. Project-scoped CICD login lives in
  `.agentia/config.user.json` (git-ignored) and moved with it. Copado skills are in `.agents/skills/`.
- A leftover `~/.agentia/config.user.json` exists from the first `agentia setup` run in the home folder.
  It is not used by this project; the user may remove it via `agentia auth unset` run from `~`.
- **CLI bug:** `agentia setup skills create` fails in a git repo with no commits
  (`git rev-parse --abbrev-ref HEAD`). Workaround: make an initial commit first. Mention in README.
- Existing test template is named `TM Demo Accounts` (created before the prefix rule). Rename or
  recreate as `TM Demo – Accounts` before the demo; ask before writing.

### Phase 0 status at the move

Done: help capture, command reference, envelope/error/exit codes, list + v2 detail shapes, diff keys.
Remaining (needs org writes, user approval pending): `save-detail` round-trip on the unchanged document,
whether `lastModified` bumps on save, `save-detail` result shape, whether advanced filters appear in
`details[].filters`. Legacy-template behaviour is not testable in this playground.

## 2026-10-05 · `save-detail` round-trip fails for templates without filters (Copado-side)

Test on `TM Demo – Accounts` (fresh, no filters). Saving the exact `get-detail` result back:

- `--file` → **422 `VALIDATION_EXCEPTION`, `MDW-003`**: `[details.0.filters] (missing): Field required`,
  `[details.0.rawFilters] (missing): Field required`. Transaction `01a107fb-fb62-73e7-ab9c-f8ff64111439`.
- `--stdin` → same. `filters: null` → same "missing" (not a type error).
- `filters: "probe"` → `(list_type): Input should be a valid list`, so non-empty values **do** arrive.

**Conclusion:** empty arrays and nulls are stripped between the CLI and the validator (the CLI passes the
body through untouched; most likely the `/json/v1/webhook/cicd-api` relay), while the backend requires
`filters`/`rawFilters`. A template with no filters therefore cannot be saved through `save-detail`.
Failed saves did not change the template (`lastModified` unchanged).

Impact on timemachine: `restore`, `edit` and `apply` all depend on `save-detail`.

- Report to Copado with the transaction Id above.
- Workaround to evaluate: demo templates carry at least one filter so `filters`/`rawFilters` are non-empty.
- `AgentiaClient` maps `MDW-003`/422 to a `TemplateValidationError` that shows the field list, and
  `timemachine` pre-checks for empty `filters`/`rawFilters` and explains this limitation before saving.

## 2026-10-05 · Legacy templates confirmed; required-empty fields block saves

- **UI-built templates are legacy (v1).** `TM Demo - Accounts New`, built in the Copado UI, had no v2
  attachment: `get` worked, but `get-detail` returned `DAT-004` 404 _"Failed to download template
  attachment"_, the same error as a non-existent Id. **Detection rule:** listed + `get` OK + `get-detail`
  DAT-004 ⇒ legacy; `status` reports "legacy (run `agentia cicd data template convert-old <id>`)".
- **`convert-old` converts in place** (returns the same Id; no new template). Afterwards `get-detail`
  returns `version: 2` with all describe columns (31), of which the UI-selected ones (8) have
  `isSelected: true`. Note: `get` returns only selected columns.
- **Filter shape (real):** `filters: ["Type = 'Customer'"]` (generated condition text) and
  `rawFilters: [{ order, fieldName: "<Label>-<ApiName>", fieldLabel, fieldType, operator: "e",
input, finalValue, isValid, operatorSet, numberInput, dateInput, dateTimeInput }]`.
  Diff key for rawFilters: `order`. Human rendering uses `finalValue`.
- **Required-but-empty fields cannot be saved.** The gateway strips `null` and `[]` (see the previous entry), and
  the validator requires at least `details[].filters`, `details[].rawFilters` and `details[].limit`.
  The converted UI template has `limit: null` (no record limit), so its identity save fails with
  `MDW-003 [details.0.limit] (missing)`. Optional nulls/empties (`parentTemplates`, `recordMatchingFormulaId`,
  `rawFilters[].dateInput` …) are fine.
  → timemachine adds a **pre-save check** listing these fields with a plain-English explanation and the
  UI fix, rather than silently inventing values (which would change the template).

## 2026-10-05 · Round-trip proven ✅ (Phase 0 closed)

On `TM Demo - Accounts New` (converted UI template, 1 filter), under the `.org-busy` lock:

1. `limit` set to 50000 via `save-detail` (the UI edit of _Max. Record Limit_ did **not** reach the v2
   document; see below). `save-detail` result is `true`.
2. **Identity save** of the `get-detail` result → re-read canonical hash identical.
3. Fax `isSelected: true → false` → saved doc == re-read doc (server does not normalise).
4. Restore original → hash identical to step 2.
5. `list.lastModified` changes on every save (second resolution). It is a valid cheap pre-check for `edit`;
   the canonical hash stays the authority.

**Removing a field = `isSelected: false`.** Columns are never dropped from the v2 document.

**Open: UI ↔ v2 sync.** After conversion, the user set _Max. Record Limit = 50000_ in the UI. `lastModified`
moved, but neither `get` nor `get-detail` changed. Either the UI save did not persist, or the UI writes to a
store the API does not read. Must be checked before the demo, because §11 step 2 has "someone changes the
template" (do that change with the CLI/raw `save-detail` if the UI path is disconnected).
**Update:** API → UI works (UI showed 50000 after the CLI save). UI → API is unconfirmed: the earlier UI
edit may simply not have been saved. Re-test with a UI edit before recording the demo.

## 2026-10-05 · Phase 1 done

- Scaffolded with `@copado/create-agentia-plugin` 0.3.0. Its prompts use `readline/promises` and drop piped
  stdin, so it was run by calling its exported `main()` with the answers injected. Output is unchanged.
- `execa` dropped (v10 needs Node ≥ 22); `node:child_process` keeps the plugin on Node ≥ 20.
- `save-detail` is called with `--stdin` (no temp file with org data on disk).
- Exit codes: 0 ok · 1 generic · 2 usage · 3 auth missing · 4 not found · 5 legacy · 6 conflict ·
  7 Agentia missing/too old · 8 gateway/timeout/source-org login · 9 validation · 10 org busy.
- **Auth resolution, corrected:** on 2026-10-05 `agentia timemachine status` also worked from a folder with no
  `.agentia/`, so a user-level login now exists as well (likely from a later `agentia setup` run). The earlier
  subfolder failure predates it. timemachine still spawns `agentia` from the project root (nearest
  `.timemachine/`, else `.agentia/`), which is correct for project-scoped auth and harmless otherwise.
- Linked with `agentia plugins link .`. Linked ESM plugins print a "cannot be auto-transpiled" warning and run
  the compiled `dist/`, so run `npm run build` after changes.

## 2026-10-05 · Phase 2 done

- **Workspace ≠ plugin repo.** Snapshots hold real org configuration and record Ids, so they live in a private
  workspace (`~/hackathon/tm-workspace`, own git repo, local identity) and never in this public repo.
- **Storage vs identity.** `template.json` keeps Copado's array order (sorted keys only), so a restore saves
  back exactly what Copado returned. The hash canonicalises keyed collections (`details` by `templateId`,
  `columns` by `name`, `rawFilters` by `order`, parent/child templates by `templateId`), so reordering is
  not drift. `filters` (strings) keep their order, because filter numbering refers to it.
- **Change detection** compares the detail hash and a separate `extrasHash` (advanced filters + record
  matching formulas for every object in the template). `meta.json` is rewritten only when a commit is made.
- **Commits** use `git commit --only -- <paths>`, so other staged work in the repo is never swept in.
  Subject `tm: snapshot <name> (<hash12>) by <git user> [reason]`; trailers `Template-Id`, `Template-Name`,
  `Template-Hash`, `Change`, `Reason`, `Copado-Last-Modified` feed `history`.
- **Tracking:** `init --track` and naming a template in `snapshot` add it to `config.json`; commands default
  to tracked templates only (shared-playground rule). Tracked templates deleted in Copado show as `missing`.
- **Exit handling inside the host:** the plugin ships its own `@oclif/core`, so the host did not recognise
  our `ExitError` and printed `Error: EEXIT`. Commands now print errors themselves and set
  `process.exitCode` (verified: the host honours it).
- **simple-git 4 strips ambient `GIT_*` env vars** (security guard). Users' `GIT_AUTHOR_*` env overrides are
  therefore ignored; the identity comes from git config. Tests use a local repo identity.

## 2026-10-05 · UI and CLI/API do not share edits (converted template) ⚠

Test on `TM Demo - Accounts New` (UI-built, then `convert-old`): the user deselected **Phone** in the
Copado UI and saved; after a page reload the UI shows Phone deselected. 40+ minutes later:

- `get-detail` (v2) and `get` (export graph) both still show Phone **selected**.
- `list.lastModified` is unchanged (still the last CLI save), so the UI save did not touch anything the API reads.

**Correction:** the earlier note "API → UI works (UI showed 50000)" is not evidence. The user had entered
50000 in the UI before the CLI save, so the UI may have shown its own stored value.

Open question (decides the product's scope): **which representation does a Copado data deployment use**,
the UI's store or the v2 detail document the CLI reads and writes? Ask Copado. Until answered:

- timemachine versions the **v2 detail document** (the CLI/API path the hackathon is about) and says so.
- `status` cannot see UI-only edits. README "Limitations" must state this plainly.
- The demo's "someone changes the template" step uses the CLI (`save-detail` / `timemachine edit`).

**Follow-up test (same day):** a CLI `save-detail` deselected **Industry** in v2 (Phone stayed selected in v2).
After a reload the UI showed Industry **selected** and Phone **deselected**, i.e. the UI neither reads v2
nor lost its own change. **For a converted template, the Copado UI and the v2 detail document are fully
separate copies.** v2 was then restored from snapshot `36e5bbd` (hash verified, `status` in sync), which was the
first real restore from a git snapshot.

Consequences until Copado says which copy deployments use:

- timemachine is positioned as versioning the **v2 detail document: the copy the Agentia CLI, MCP tools
  and AI agents read and write**. The README states that UI-only edits are invisible to it.
- Raise with Copado (hackathon channel), including that UI and CLI edits silently diverge. This is itself a
  strong argument for the tool (one source of truth, reviewable in git).
- Demo templates should be created and edited via the CLI from now on, so UI state does not confuse the video.

## 2026-10-05 · Phase 3 done; incident during the demo edit

- Real diff verified on `TM Demo - Accounts New` (CLI edit: Description selected, Fax deselected, batchSize
  200 → 100, filter Customer → Partner), snapshotted as `5273beb`.
- **Incident:** the first save of that edit used inline `node -e` inside a single-quoted shell string;
  the `'` escapes were swallowed and the filter was saved as `Type = Partner` (invalid SOQL). It was fixed
  within a minute by a second save (`Type = 'Partner'`, verified), and was never snapshotted.
  **Rule from now on:** org writes run from script files, never inline code inside shell quotes. timemachine
  itself is not affected (it passes documents over stdin as JSON).
- Hash display: `history` recomputes hashes from the stored files, so hashes computed before the
  null-handling change (`f758…`) show in the current form.

## 2026-10-05 · Phase 4 done: round-trip restore proven in the sandbox

`restore "TM Demo - Accounts New" --to 36e5bbd --yes` on the real org: diff live → target shown, lock
`~/hackathon/.org-busy` held during the write, save, read-back hash `236166866460` = target, post-restore
snapshot `e5598d4`, undo command printed (`--to 5273beb`). `diff --from 36e5bbd` → no differences.

- **One write path** (`core/apply.ts`) for restore / edit / apply: pre-check save blockers → lock →
  re-read live and compare with the hash the user reviewed (ConcurrencyError, exit 6) → snapshot the
  replaced state → save → read back + verify (VerifyError) → snapshot the result. The post-write snapshot
  is taken even when verification fails, so history always shows what is really live.
- **Shared lock is configuration**, not hard-coded: `orgBusyFile` in `.timemachine/config.json`
  (set to `~/hackathon/.org-busy` in the demo workspace). Created with `wx` (atomic), always removed in
  `finally`. `--ignore-busy` to override a stale lock.
- **Restore writes only the detail document.** Advanced filters and matching formulas are separate
  resources (formulas are shared between templates); their differences are listed, not written.
- **Non-interactive safety:** without a TTY (agents, CI) restore requires `--yes`; `--json` never prompts.

## 2026-10-05 · Phase 5 done: two-terminal conflict reproduced on the real org

Sessions `alice` and `bob` both started from `236166866460`. Alice selected Description and applied
(saved + verified, `b33f16c`). Bob changed batchSize and applied → **blocked, exit 6, nothing saved**,
three-way view: theirs `+ field Description added`, yours `~ batchSize 200 → 100`, no overlap; working
copy kept. Cleaned up: bob aborted, baseline restored (`62e8f88`, verified).

- **Base of an edit:** a session's base is the live document at `--start`. For one-shot `--file` edits
  (agents) the default base is the **last snapshot**, because that is what an agent following the skill
  read. So any change after the agent's snapshot blocks the save. `--base live|<ref>` overrides.
- **Two concurrency checks:** before asking for confirmation (so people see the conflict first) and
  again inside the write path right before saving (catches a save that lands during the prompt).
- **Conflict = overlapping paths with different outcomes** (same property, or a change inside an element
  the other side added/removed). Different properties of the same field are not a conflict. When nothing
  overlaps, the hint says the edit can be re-applied on top; `--merge` (stretch) would automate exactly that case.
- Sessions live in `.timemachine/.lock/<slug>/<session>/` (git-ignored), one per person (`--session`, default:
  the git user name), and are shown by `status`.

## 2026-10-05 · Phase 6 done: an agent follows the skill unprompted

Headless Claude Code 2.1.289 in `~/hackathon/tm-workspace` (skill installed for `claude` and `agents`), prompt
only: _"Add the Website field to the TM Demo - Accounts New data template."_ Guard-rails: allowed tools limited
to file tools + `agentia timemachine …`; the shared org lock was held so no save could succeed.

The agent loaded the `timemachine` skill itself, then: `status --json` → `snapshot --reason "add Website field"`
→ read `.timemachine/templates/<slug>/template.json` → built the edit (`isSelected` false → true on the existing
Website column, nothing else) → `edit --file … --dry-run --json` → showed `+ field Website added to Account`
and **asked for confirmation**, explaining the concurrency guarantee and the undo. No `save-detail`, no write.

Notes for the README / demo:

- The two denials came from the test's permission rules (shell redirects), not from the skill. In an interactive
  session the user approves them.
- While the plugin is _linked_ (development), every `agentia` call prints an ESM warning on stderr. Agents
  that do not redirect stderr see it before the JSON. Installing the plugin from npm (not linked) removes it.
- Demo scene 5 uses **Website** (Region does not exist on standard Account in the sandbox).

## 2026-10-05 · Phase 7 done: plan/apply, lint, merge

- **PR workflow.** A pull request edits `.timemachine/templates/<slug>/template.json`. `plan` compares that committed
  version with live Copado and prints "what apply would change", as Markdown for a PR comment (summary table,
  `diff` blocks, `<!-- timemachine-plan -->` marker so CI updates one comment). Verified read-only on the real org
  with a throwaway branch selecting Website: `+ field Website added to Account`, status ready to apply.
- **Base of an apply** = the template.json of the last commit that wrote `meta.json` (snapshots write meta, hand edits
  in a PR do not). If live ≠ that base, Copado changed after the last snapshot; `plan` marks it ⚠️ and `apply` refuses
  (exit 6). Same guarantee as `edit`: a PR can never silently overwrite a change made in Copado.
- **GitHub Actions examples** (`examples/github-actions/`): plan comment on PRs (read-only) and apply on merge to `main`
  (writes; sandbox first; GitHub environment for approval; pushes the snapshot commits back). Both need the user's
  `AGENTIA_CICD_API_KEY` / `AGENTIA_CICD_BASE_URL` secrets and belong in the **private** workspace repo. Not run on
  GitHub yet: that needs a private repo with secrets set by the user.
- **lint**: 11 rules (TM001–TM011), several taken from things we hit for real: Copado's save rejections (TM001/TM002)
  and the unquoted `Type = Partner` value (TM006). Lints the committed version by default (what apply would push), or `--ref live`.
- **`edit --merge`**: three-way merge only when nothing overlaps; refuses otherwise or when a path vanished. Blocked-save
  errors expose `mergeable` so agents can offer it (the skill tells them to ask first).

## 2026-10-05 · MCP server (`agentia timemachine mcp`)

Plugins cannot register tools in `agentia mcp start`, so Time Machine ships its **own stdio MCP server**, run next to
Copado's. It covers the third extensibility pillar the judges name ("skills, commands, and MCP").

- Tools run the Time Machine CLI as a subprocess (`agentia timemachine … --json`, re-invoking the same host binary),
  so every safety rule applies unchanged and nothing can write to the protocol's stdout.
- Read-only: `tm_status`, `tm_history`, `tm_diff`, `tm_lint`, `tm_plan`; git only: `tm_snapshot`; org writes are two-step:
  `tm_edit_preview` → `tm_edit_apply`, `tm_restore_preview` → `tm_restore_apply`. Apply requires the single-use
  `previewId` (30 min TTL) **and** `confirmed: true` (a `z.literal(true)` the protocol layer validates). Tool annotations
  (`readOnlyHint` / `destructiveHint`) let clients auto-approve reads and ask before writes. Server `instructions` and a
  `safe_template_change` prompt carry the workflow.
- Verified three ways: (1) SDK in-memory client tests with the fake org (8 tests); (2) a real stdio client against
  `agentia timemachine mcp` in the host and the real org (list, status, diff, preview, refused fake apply; stdout clean);
  (3) headless Claude Code with **only** this MCP server (`--mcp-config … --strict-mcp-config`, apply tools not allowed,
  org lock held). The agent loaded the skill, used `tm_status` → `tm_snapshot` → `tm_edit_preview` (passing the document
  inline when file writes were not permitted), showed `+ field Website added to Account` and asked before saving.

## 2026-10-05 · Phase 8: positioning wording (overrides the brief)

The brief asked the README and deck for a comparison line with another marketplace listing. The user decided
**not to name or compare with any other product anywhere**. Positioning is stated on its own terms: Time Machine
versions the template _configuration_; it does not back up or restore record data.

## 2026-10-05 · Phase 8: publish preparation

- **Offline org** for judges, CI and recordings: `scripts/fake-agentia.mjs` with `TM_FAKE_STATE=<dir>` keeps a small stateful org
  seeded from scrubbed captures and reproduces the measured API behaviour (whole-document saves, null stripping in
  filter rows, 422 MDW-003 for empty filters / no limit, `lastModified` bumps). `bin/run.js` runs the plugin without
  the agentia host; `topicSeparator: " "` keeps standalone and host command syntax identical.
- **GIF** is generated, not screen-recorded: `examples/demo/record.mjs` runs the real commands against the offline org
  and writes an asciinema cast; `agg` (asciinema's renderer, downloaded with the user's approval into the session
  scratchpad, not installed) turns it into `docs/media/timemachine.gif`. `npm run demo:record` re-renders it.
- **Fresh clone check:** clone → `npm ci` → build → lint → typecheck → 223 tests → offline tour: 25 s, all green.
- **Publishing** (decided 2026-10-05): the public repo `gitanjalivanshiv/agentia-timemachine` starts from a fresh
  single-commit history (earlier commits mention a marketplace listing the user does not want named). The build brief and
  the captured Agentia CLI help text (`docs/help/`, Copado's wording) are not published; `scripts/export-public.sh`
  builds the public copy and fails if private content is found. The copyright line stays generic.

## 2026-10-05 · Investigation: which copy does Copado's data engine use?

Template `TM Demo - Accounts New` (built in the UI, converted with `convert-old`). Current state of the two copies:

| Field    | v2 detail document (`get-detail`, `get`) | Copado UI (after the user's edits)                 |
| -------- | ---------------------------------------- | -------------------------------------------------- |
| Phone    | **selected**                             | deselected                                         |
| Industry | selected                                 | selected (a CLI deselect never appeared in the UI) |

`agentia cicd data records search --credential-id <cred> --data-template-id <id>` (Copado's record selection for data
commits; read-only query of the source sandbox) returned 1 record (`Type = Customer`, the v2 filter) with exactly the
v2-selected fields: `Id, Name, Type, BillingCountry, Phone, Fax, Industry, AnnualRevenue`, **including Phone**, which
the UI shows as deselected. Its `detail` block echoes the v2 template configuration.

**Conclusions (evidence-based):**

1. Copado's record selection follows the **v2 detail document**: the copy Time Machine versions, diffs and restores.
2. For this converted template the UI reads and writes a **separate copy**: UI edits change neither `get-detail` nor
   `get` nor `list.lastModified`, and CLI saves do not show in the UI. No public Agentia command exposes the UI copy,
   so Time Machine **cannot detect UI-only edits** (plugins may only use the public CLI).
3. Not proven: whether the UI behaves the same for templates created directly as v2 (via CLI/API); what storage the
   UI writes to; a full data commit (a write to a user story) was not run.

**Decision:** document it as a known limitation, framed by the evidence (README "Limitations", deck "What we found").
Advise making template changes through Time Machine / the CLI. Report to Copado with the reproduction steps.

### Follow-up: `agentia timemachine verify`

Detecting UI-only edits is impossible through the public CLI, so Time Machine instead **shows what Copado's data engine
actually uses**: `verify` calls `records search` (read-only), compares the engine's selected fields, filters, record limit,
batch size and external Id field with the live v2 document, and prints the number of matching records (never values).
On the real org both demo templates report "✔ Copado's record selection uses the current v2 document". Also available
as the MCP tool `tm_verify`; the skill tells agents to run it when a user mentions UI edits. Documented as a known
limitation in the README with the evidence above.
