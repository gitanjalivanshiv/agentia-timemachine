# ⏱️ Agentia Time Machine

**Version control for Copado Release Data Templates.** Every template change is snapshotted to git, shown as a
readable diff, saved only if nobody else changed the template meanwhile, verified after saving, and can be undone
with one command. Works from the terminal, from AI agents (Agent Skill + MCP server) and from pull requests.

![Time Machine: diff and restore](docs/media/timemachine.gif)

```text
$ agentia timemachine diff "TM Demo - Accounts New"
TM Demo - Accounts New 36e5bbd → live

~ Account: batchSize 200 → 100
+ field Description added to Account
- field Fax removed from Account
~ filter on Account: Type = 'Customer' → Type = 'Partner'

1 added · 1 removed · 2 changed
```

---

## Why

A data template decides which records move between environments, and how. Today it is the riskiest configuration
to change without a safety net:

- **One save replaces everything.** `agentia cicd data template save-detail` replaces the complete v2 detail
  document. There are no partial updates.
- **No diff, no preview, no warning.** Two people can edit the same template; the second save silently wipes the
  first person's work.
- **No history.** There is no record of what a template looked like yesterday, and no way back.

Time Machine treats templates like code.

| You want to…                                      | Command                                             |
| ------------------------------------------------- | --------------------------------------------------- |
| Record the current state of templates             | `agentia timemachine snapshot --all`                |
| See what changed, in plain words                  | `agentia timemachine diff <template>`               |
| See who changed what, when and why                | `agentia timemachine history <template>`            |
| Change a template without overwriting anyone      | `agentia timemachine edit <template>`               |
| Undo a change, verified                           | `agentia timemachine restore <template> --to <ref>` |
| Review template changes in pull requests          | `agentia timemachine plan` / `apply`                |
| Catch mistakes before they deploy                 | `agentia timemachine lint`                          |
| Check everything at a glance                      | `agentia timemachine status`                        |
| Confirm what Copado really uses (fields, filters) | `agentia timemachine verify`                        |
| See every template's timeline in the browser      | `agentia timemachine report --open`                 |
| Let AI agents do all of the above safely          | Agent Skill + `agentia timemachine mcp`             |

Every command supports `--json` with Agentia's `{result, status}` envelope and documented exit codes.

## Try it in 2 minutes (no Copado org needed)

```bash
git clone https://github.com/gitanjalivanshiv/agentia-timemachine.git timemachine && cd timemachine
npm ci && npm run build
./examples/demo/try-offline.sh
```

The tour runs the real commands against a simulated offline org (seeded from scrubbed real captures) that behaves
like the Copado API: snapshot, a colleague's change, diff, verified restore, two people editing at once (the second
save is blocked, then merged), and lint.

## Install with your Copado org

**Prerequisites**

- Node.js ≥ 20 and the Agentia CLI: `npm install -g @copado/agentia-cli@beta`
- `agentia setup` done (CICD authentication). Run it yourself; Time Machine never handles credentials.
- A **Source Format** pipeline, and the **Copado Data Deployer** licence assigned to your user. After assigning
  it, re-authenticate the template's source credential, otherwise Copado answers `LGN-001 Login service error`.

**Install the plugin**

```bash
git clone https://github.com/gitanjalivanshiv/agentia-timemachine.git timemachine && cd timemachine
npm ci && npm run build
agentia plugins link .
agentia timemachine --help
```

**Quickstart**

```bash
mkdir ~/template-history && cd ~/template-history     # a PRIVATE folder: snapshots contain your org configuration
agentia timemachine init --track "My Account Template" --skill claude
agentia timemachine snapshot --all --reason "baseline"
agentia timemachine status
```

Then change the template (in Copado, or with `timemachine edit`) and run `agentia timemachine diff "My Account Template"`.

## The timeline page

`agentia timemachine report --open` writes one self-contained HTML page (no network needed) with each template's
version timeline: who changed it, when, why and what changed, with a copyable restore command per version. It also
shows whether Copado changed since the last snapshot, what Copado will deploy (`verify`), and lint findings. It stays
inside the workspace and is git-ignored, because it contains your template configuration.

## Safe edit: nobody's work is overwritten

Every edit starts from a **base** version. Right before saving, Time Machine re-reads the template. If it changed
since your base, the save is **blocked** and you see both sides:

```text
✋ Blocked: TM Demo - Accounts New was changed in Copado after your edit started. Nothing was saved.

  Their changes (base → live now)
    + field Description added to Account

  Your changes (base → yours)
    ~ Account: batchSize 200 → 100

  No overlapping changes: your edits can be re-applied on top of the current version (--merge).
```

```bash
agentia timemachine edit "My Template"                         # opens $EDITOR, previews, confirms, saves
agentia timemachine edit "My Template" --start --session alice # two-step: working copy for alice
agentia timemachine edit "My Template" --apply --session alice
agentia timemachine edit "My Template" --file new.json --yes   # agents/CI: base = last snapshot
agentia timemachine edit "My Template" --apply --merge         # keep both changes when nothing overlaps
```

Every write (`edit`, `restore`, `apply`) goes through one path:

1. refuse documents Copado would reject (no filter, no Max. Record Limit)
2. take the shared org lock, if configured
3. re-check live against the reviewed base
4. snapshot the state being replaced
5. save
6. read back and verify the hash
7. snapshot the result and print the undo command

## For AI agents

**Agent Skill.** `agentia timemachine skill install --target claude|agents|cursor` installs a skill in the same
format and folders as Copado's own Agentia skills. It teaches an agent to snapshot first, edit only through Time
Machine, preview, ask the user before saving, stop on conflicts and never force. In our test, Claude Code loaded
the skill on its own from the prompt _"Add the Website field to the TM Demo - Accounts New data template"_, then
snapshotted, previewed `+ field Website added to Account` and asked before saving.

**MCP server.** Agentia plugins cannot add tools to `agentia mcp start`, so Time Machine ships its own stdio
server to run next to Copado's:

```bash
claude mcp add timemachine -- agentia timemachine mcp
```

| Tools                                                                          | Kind                 |
| ------------------------------------------------------------------------------ | -------------------- |
| `tm_status`, `tm_history`, `tm_diff`, `tm_lint`, `tm_plan`, `tm_verify`        | read-only            |
| `tm_snapshot`                                                                  | writes git only      |
| `tm_edit_preview` → `tm_edit_apply`, `tm_restore_preview` → `tm_restore_apply` | org writes, two-step |

An `*_apply` tool only runs with the `previewId` of a preview (single use) **and** `confirmed: true`, so an agent
cannot save a change nobody saw. Tools carry read-only/destructive annotations so clients can auto-approve reads.

## Pull-request review

Edit `.timemachine/templates/<slug>/template.json` on a branch and open a pull request.
`agentia timemachine plan --format md` prints what applying it would change, for a PR comment. After merge,
`agentia timemachine apply --yes` saves it through the same safe path. If the template changed in Copado after its
last snapshot, `plan` flags it and `apply` refuses: a PR can never silently overwrite a change made in Copado.
Ready-made workflows: [examples/github-actions](examples/github-actions/).

## Lint

| Rule                        | Severity | Checks                                                                                    |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| TM001 filter-required       | error    | object has a main object filter (Copado rejects saves without one)                        |
| TM002 limit-required        | error    | Max. Record Limit is set (Copado rejects saves without it)                                |
| TM003 high-volume-limit     | warning  | large record limit on a high-volume object                                                |
| TM004 record-matching       | warning  | external Id or matching formula present (Id-only matching duplicates records across orgs) |
| TM005 duplicate-field       | error    | no field listed twice                                                                     |
| TM006 filter-unquoted-value | error    | text/picklist filter values are quoted                                                    |
| TM007 filter-text-mismatch  | warning  | filter text matches the filter rows                                                       |
| TM008 filter-invalid        | error    | no filter row marked invalid                                                              |
| TM009 filter-field-missing  | error    | filters only use fields in the template schema                                            |
| TM010 batch-size            | warning  | batch size between 1 and 200                                                              |
| TM011 pii-not-anonymised    | info     | personal data fields have an anonymizer                                                   |

Configure in `.timemachine/config.json`: `{"lint": {"disable": ["TM011"], "highVolumeLimit": 5000}}`.

## Built on Agentia CLI

Time Machine is an oclif plugin for the Agentia CLI (scaffolded with `npm init @copado/agentia-plugin`). It never
imports Agentia internals: every Copado call spawns the public `agentia` binary with `--json` from the workspace
folder. Commands it calls:

| Agentia command                                       | Used for                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `agentia --version`                                   | version check (≥ 1.0.0-beta.2)                                         |
| `agentia cicd data template list`                     | find templates, `lastModified`                                         |
| `agentia cicd data template get-detail <id>`          | read the v2 detail document                                            |
| `agentia cicd data template get <id>`                 | detect legacy (not yet converted) templates                            |
| `agentia cicd data template save-detail <id> --stdin` | the only write: edit, restore, apply                                   |
| `agentia cicd data filter list <id>`                  | advanced filters (snapshotted with the template)                       |
| `agentia cicd data formula list <object>`             | record matching formulas (snapshotted with the template)               |
| `agentia cicd data records search …`                  | `verify`: the configuration Copado's record selection uses (read-only) |

Time Machine suggests, but never runs, `agentia cicd data template convert-old <id>` for legacy templates.
Each command's syntax, JSON shape and error codes: [docs/agentia-commands.md](docs/agentia-commands.md).

## Limitations

- **Scope is the template configuration.** Time Machine versions and restores the template definition (the v2
  detail document). It does not back up or restore the record data a deployment moves. Advanced filters and
  matching formulas are snapshotted and diffed, but `restore` writes only the detail document; their differences
  are listed.
- **Copado UI and CLI can hold different copies of a template.** We tested a template built in the Copado UI and
  converted with `convert-old`. Afterwards, UI edits did not reach the v2 document that `get-detail` returns (nor
  `lastModified`), and CLI saves did not show in the UI. **Copado's record selection follows the v2 document**: asked
  for records, it queried a field that was deselected in the UI but selected in v2. So Time Machine versions the copy
  that drives data selection. No public Agentia command exposes the UI's copy, so Time Machine **cannot detect
  UI-only edits**. Make template changes through Time Machine (or the CLI), and run `agentia timemachine verify`
  to see exactly which fields, filters and limits Copado will use. The evidence and reproduction steps are in [docs/decisions.md](docs/decisions.md).
- **Saves without a filter or record limit fail.** Copado drops empty lists and nulls when saving, then rejects the
  document. Time Machine detects this before writing and tells you which field to fill in.
- **Legacy templates** must be converted to v2 once (`convert-old`, a write you run yourself).
- **Filter operators:** only `equals` (`"e"`) has been observed in real documents; the skill tells agents not to
  invent other operator codes.
- While the plugin is linked for development, `agentia` prints an "ESM module" warning on stderr. It does not affect
  `--json` output on stdout.

## Development

```bash
npm ci
npm run build       # TypeScript → dist/
npm test            # vitest: 220+ tests, no Copado org needed
npm run lint        # ESLint + Prettier
npm run typecheck   # including tests
```

- Tests run against a **stateful fake org** that reproduces the real API's behaviour (`test/fake-org.ts`) and
  scrubbed real captures (`fixtures/agentia`). `TM_RECORD=1` records new captures; `node scripts/scrub-fixtures.mjs`
  anonymises them and fails if an original Id or name survives.
- `./bin/run.js timemachine …` runs the plugin without the Agentia host; `TM_AGENTIA_BIN` points it at another
  `agentia` (e.g. `scripts/fake-agentia.mjs` with `TM_FAKE_STATE=<dir>` for the offline org).
- Architecture: [docs/architecture.md](docs/architecture.md). Every finding and decision, with dates:
  [docs/decisions.md](docs/decisions.md).

## License

[MIT](LICENSE). Open-source components and their licences: [docs/open-source.md](docs/open-source.md).
Agentia™ and Copado are trademarks of Copado, Inc. This is an independent hackathon project.
