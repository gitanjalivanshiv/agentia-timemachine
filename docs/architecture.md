# Architecture

```
  people                    AI agents                         CI (GitHub Actions)
    │                          │                                    │
    │  agentia timemachine …   │ Agent Skill (SKILL.md)             │ plan --format md / apply --yes
    │                          │ MCP: agentia timemachine mcp       │
    ▼                          ▼                                    ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ oclif commands  src/commands/timemachine/*.ts                            │
 │ status · init · snapshot · diff · history · edit · restore · plan ·      │
 │ apply · lint · mcp · skill install                                       │
 └──────────────┬───────────────────────────────────────────────────────────┘
                ▼
 ┌──────────────────────────────┐      ┌───────────────────────────────────┐
 │ core                         │─────►│ store  (git, simple-git)           │
 │ canonical · differ · describe│      │ .timemachine/config.json           │
 │ conflict · merge · lint ·    │      │ templates/<slug>/template.json     │
 │ plan · inspect · snapshot ·  │      │                  extras.json       │
 │ apply (the one write path) · │      │                  meta.json         │
 │ edit-session · org-lock      │      │ .lock/<slug>/<session>/  (ignored) │
 └──────────────┬───────────────┘      └───────────────────────────────────┘
                ▼
 ┌──────────────────────────────┐
 │ AgentiaClient                │  spawns `agentia … --json` from the workspace, zod-validates,
 │ ProcessRunner / FakeRunner / │  maps Copado errors (DAT-004, LGN-001, MDW-003, auth, exit 2)
 │ RecordingRunner              │  to typed errors with exit codes
 └──────────────┬───────────────┘
                ▼
       public agentia CLI ──► Copado
```

## Modules

| Module                              | Responsibility                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentia/client.ts`                 | The only adapter to Copado. Builds documented commands, parses the `{result,status}` / `{error}` envelope, validates with loose zod schemas (unknown fields are kept), maps errors.             |
| `agentia/runner.ts`                 | `ProcessRunner` (spawns the binary, timeout, stdin), `FakeRunner` (canned responses), `RecordingRunner` (`TM_RECORD=1`).                                                                        |
| `core/canonical.ts`                 | Storage JSON (sorted keys, Copado's array order kept so restores are faithful) and the canonical SHA-256 used for change detection and concurrency (keyed collections sorted, `null` ≡ absent). |
| `core/differ.ts`                    | JSON-path diff with keyed collections (objects by `templateId`, columns by `name`, filter rows by `order`, advanced filters by `uuid`, formulas by `id`), moves via LCS.                        |
| `core/describe.ts`                  | Turns raw changes into statements in template language; groups filter rows; summary counts statements.                                                                                          |
| `core/apply.ts`                     | The single write path: blockers → lock → re-check → pre-snapshot → save → verify → post-snapshot.                                                                                               |
| `core/conflict.ts`, `core/merge.ts` | Three-way view (theirs / yours / conflicts) and merge of non-overlapping edits.                                                                                                                 |
| `core/plan.ts`                      | Committed version vs live, base check against the last snapshot (for PR review).                                                                                                                |
| `core/lint.ts`                      | Rule set TM001–TM011.                                                                                                                                                                           |
| `store/store.ts`                    | `.timemachine/` in git; commits touch only the template's folder (`git commit --only`); history with trailers.                                                                                  |
| `mcp/server.ts`                     | MCP tools over the CLI, preview → apply with single-use `previewId` + `confirmed: true`.                                                                                                        |
| `core/skill.ts`                     | Installs `skills/timemachine` for agents / Claude / Cursor; AGENTS.md pointer.                                                                                                                  |

## Identity and concurrency

Copado's v2 document has no revision number (`version: 2` is a format marker). Time Machine uses the canonical
hash of the document as its identity:

- **Snapshot** commits only when the detail hash or the extras hash (advanced filters + matching formulas) changed.
  Hashes are recomputed from stored files, never trusted from `meta.json`.
- **Edit** remembers the base hash; the write path refuses to save when live ≠ base (`CONFLICT`, exit 6).
- **Apply** uses the last snapshot (the last commit that wrote `meta.json`) as the base of a committed change.
- `null` and "absent" hash the same because Copado drops null keys inside filter rows when it saves; otherwise a
  restored document would never verify.

## Error model and exit codes

| Exit | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| 0    | success                                                        |
| 1    | generic / verify failed / lint errors                          |
| 2    | usage (missing arguments, no workspace, confirmation required) |
| 3    | Agentia not authenticated                                      |
| 4    | template or snapshot not found                                 |
| 5    | legacy template (needs `convert-old`)                          |
| 6    | conflict: the template changed meanwhile                       |
| 7    | Agentia CLI missing or too old                                 |
| 8    | Copado gateway / timeout / source-org login                    |
| 9    | Copado would reject or rejected the document                   |
| 10   | org busy (shared lock held)                                    |

The plugin ships its own `@oclif/core`, so the host does not recognise its `ExitError`. Commands print their own
errors and set `process.exitCode` instead of throwing.
