<!-- timemachine managed skill file: agentia timemachine skill install -->

# Time Machine Commands Reference

All commands run from a workspace folder (it contains `.timemachine/`) or any subfolder. Add `--json` for
machine-readable output.

## JSON Envelope

| Outcome                                                | Shape                                                         | Exit code |
| ------------------------------------------------------ | ------------------------------------------------------------- | --------- |
| Success                                                | `{"result": …, "status": 0}`                                  | 0         |
| Partial failure (e.g. one of several snapshots failed) | `{"result": …, "status": <code>}`                             | non-zero  |
| Error                                                  | `{"error": {"code", "message", "hint", …}, "status": <code>}` | non-zero  |

## Commands

| Command                                                                           | Use For                                                                   | Notes                                                                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `status [template…]`                                                              | Tracked templates: snapshot state, format, saveability, edits in progress | `result[]`: `name`, `id`, `snapshot` (`in-sync`/`drifted`/`never`), `format` (`v2`/`legacy`), `saveable`, `saveBlockers[]`, `editSessions[]` |
| `init [--track <t>]…`                                                             | Create a workspace / track templates                                      | Commits `.timemachine/config.json`.                                                                                                          |
| `snapshot <t>… \| --all [--reason r] [--dry-run]`                                 | Record the live state in git                                              | `result.snapshots[]`: `outcome` (`created`/`updated`/`unchanged`), `hash`, `commit`, `change`. Commits only when something changed.          |
| `diff <t> [--from ref] [--to ref\|live] [--format md] [--exit-code]`              | Readable diff                                                             | Default: last snapshot → live. `result.statements[]`: `type`, `sign`, `text`, `entity`, `changes[]` (raw JSON paths). `result.summary`.      |
| `history <t> [-n N]`                                                              | Timeline of snapshots                                                     | `result[]`: `ref`, `date`, `author`, `hash`, `change`, `reason`. Use `ref` with `diff`/`restore`.                                            |
| `edit <t> --file f [--base live\|ref] [--dry-run] [--yes] [--merge] [--reason r]` | Safe change (agents)                                                      | Base defaults to the last snapshot. `result.statements`, `result.apply`, `result.undo`.                                                      |
| `edit <t> --start \| --apply \| --abort [--session name]`                         | Two-step edit sessions (people)                                           | `--start` returns `result.session.file` (the working copy).                                                                                  |
| `restore <t> --to <ref> [--dry-run] [--yes]`                                      | Bring back an earlier version                                             | Snapshots the current state first; verifies after saving; returns `result.undo`.                                                             |
| `plan [t…] [--ref r] [--format md] [--output f]`                                  | What applying committed versions would change (PR review)                 | `result.templates[]`: `status` (`changes`/`in-sync`/`base-drifted`/…), `statements`, `saveBlockers`                                          |
| `apply [t…] [--ref r] [--dry-run] [--yes]`                                        | Push committed versions to Copado                                         | Refuses templates changed in Copado since their last snapshot. `result.results[]`: `outcome`, `undo`                                         |
| `verify [t…]`                                                                     | What Copado's data engine really uses (fields, filters, limit)            | `result[]`: `aligned`, `engine`, `document`, `differences[]`, `matchingRecords` (count only). Exit 1 if not aligned                          |
| `lint [t…] [--ref r\|live] [--strict]`                                            | Check templates for mistakes                                              | `result.templates[].findings[]`: `rule`, `severity`, `message`, `fix`. Exit 1 on errors                                                      |
| `mcp [--dir d]`                                                                   | Stdio MCP server exposing these commands as `tm_*` tools                  | Writes are two-step: `tm_*_preview` returns a `previewId`; `tm_*_apply` needs it plus `confirmed: true`                                      |
| `skill install [--target agents\|claude\|cursor]`                                 | Install this skill                                                        |                                                                                                                                              |

`<t>` is a template name (exact, case-insensitive), a Salesforce Id, or the slug shown by `status`.

## Error Codes

| `error.code`                         | Exit | Meaning                                         | What to do                                                                        |
| ------------------------------------ | ---- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `CONFLICT`                           | 6    | Template changed after your base; nothing saved | Show `theirs`, `yours`, `conflicts`; ask the user; offer `--merge` if `mergeable` |
| `SAVE_BLOCKED`                       | 9    | Document has empty filters or Max. Record Limit | Pass on `hint`                                                                    |
| `TEMPLATE_VALIDATION`                | 9    | Copado rejected the save (`problems[]`)         | Pass on `hint`                                                                    |
| `ORG_BUSY`                           | 10   | Another write to the org is in progress         | Wait; ask before `--ignore-busy`                                                  |
| `TEMPLATE_LEGACY`                    | 5    | No v2 document yet                              | Explain `convert-old`; run only with consent                                      |
| `TEMPLATE_NOT_FOUND` / `NO_SNAPSHOT` | 4    | Unknown template / no snapshot or ref           | Check `status` / `history`                                                        |
| `AUTH_MISSING`                       | 3    | Agentia not authenticated                       | User runs `agentia setup`                                                         |
| `NOT_INITIALISED`                    | 2    | No workspace here                               | `init` (ask where)                                                                |
| `CONFIRMATION_REQUIRED`              | 2    | Needs `--yes` (no terminal)                     | Preview first, confirm with the user, then `--yes`                                |
| `VERIFY_FAILED`                      | 1    | Saved, but read-back differs                    | Report; run `diff` against the target                                             |
| `SOURCE_ORG_LOGIN`                   | 8    | Copado cannot log in to the source org          | User re-authenticates the credential                                              |

## Examples

```sh
agentia timemachine status --json
agentia timemachine snapshot "TM Demo - Accounts New" --reason "add Region" --json
agentia timemachine edit "TM Demo - Accounts New" --file tm-edits/tm-demo-accounts-new.json --dry-run --json
agentia timemachine edit "TM Demo - Accounts New" --file tm-edits/tm-demo-accounts-new.json --yes --reason "add Region" --json
agentia timemachine history "TM Demo - Accounts New" --json
agentia timemachine restore "TM Demo - Accounts New" --to 36e5bbd --dry-run --json
```
