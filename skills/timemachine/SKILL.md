---
name: timemachine
description: Use this skill whenever the user asks an agent to change, edit, review, compare, undo or restore a Copado Release Data Template (data template), e.g. "add the Region field to the Account template", "why did the template change?", "undo yesterday's template change". It wraps every template change in snapshot → readable diff → confirmed safe edit → verification, and never overwrites someone else's change. Use it instead of calling `agentia cicd data template save-detail` directly.
---

<!-- timemachine managed skill file: agentia timemachine skill install -->

# Agentia Time Machine

Use this skill to change Copado Release Data Templates like code: every change is snapshotted to git,
shown as a human-readable diff, confirmed by the user, saved only if nobody else changed the template
meanwhile, verified after saving, and can be undone with one command.

`agentia cicd data template save-detail` replaces the **whole** template document with no preview and no
concurrency check, so one save can silently wipe a colleague's work. `agentia timemachine` wraps it safely.
Always add `--json` and parse the result.

Prefer the Time Machine MCP tools (`tm_status`, `tm_snapshot`, `tm_diff`, `tm_history`, `tm_edit_preview` →
`tm_edit_apply`, `tm_restore_preview` → `tm_restore_apply`, `tm_lint`, `tm_plan`) when they are connected
(`agentia timemachine mcp`); the rules below are the same. Use the CLI as the fallback.

## Start Here

1. Run `agentia timemachine status --json` from the workspace folder (the one containing `.timemachine/`).
   - `error.code` `NOT_INITIALISED`: ask the user which folder should hold template snapshots, then run
     `agentia timemachine init --track "<template name>"` there.
   - The result lists tracked templates with `name`, `id`, `format`, `saveable`, `snapshot` and `saveBlockers`.
2. Work only on templates the user named or that are tracked in `.timemachine/config.json`.
3. Pick the workflow below and follow it step by step. Do not skip the snapshot, the preview or the confirmation.

## Change A Template (always this order)

1. **Snapshot first.** `agentia timemachine snapshot "<template>" --reason "<what the user asked>" --json`
2. **Read the base.** Open `.timemachine/templates/<slug>/template.json` (slug from `status`/`snapshot`).
   That snapshot is the base your edit is checked against.
3. **Write the edited document** to a new file outside `.timemachine/`, e.g. `./tm-edits/<slug>.json`:
   copy `template.json` and change only what the user asked for. Read
   [references/template-document.md](references/template-document.md) for where things live. Adding a
   field means setting `"isSelected": true` on its existing entry in `details[].columns`.
4. **Preview.** `agentia timemachine edit "<template>" --file <file> --dry-run --json`. Show the user the
   `result.statements[].text` lines (e.g. `+ field Region__c added to Account`) and ask them to confirm.
   If a statement appears that the user did not ask for, fix your file and preview again.
5. **Save only after the user says yes.**
   `agentia timemachine edit "<template>" --file <file> --yes --reason "<what the user asked>" --json`
6. **Report** the statements, `result.apply.after.hash` (verified) and the `result.undo` command.

## When The Save Is Blocked

`error.code` `CONFLICT` (exit 6) means someone changed the template after your base. Nothing was saved.

1. Stop. Show the user `error.theirs` (their changes), `error.yours` (yours) and `error.conflicts`.
2. Ask how to proceed. Never retry with `--base live` to get around the block unless the user has seen
   their changes and explicitly asks to build on top of them.
3. If `error.mergeable` is true (nothing overlaps), offer to keep both: after the user agrees, re-run the same
   `edit` command with `--merge` (preview first with `--merge --dry-run`). It applies your changes on top of the
   current version.
4. Otherwise redo your change on the current version: `snapshot` again, rebuild your file from the new
   `template.json`, preview, confirm, save.

## Undo Or Restore

1. `agentia timemachine history "<template>" --json`: find the version (`ref`, `date`, `author`, `reason`, `change`).
2. `agentia timemachine restore "<template>" --to <ref> --dry-run --json`: show the user what will change.
3. After the user confirms: `agentia timemachine restore "<template>" --to <ref> --yes --json`.
4. Report the verified hash and the `undo` command (restores can be undone too).

## Review What Changed

- Live vs last snapshot: `agentia timemachine diff "<template>" --json`
- Between versions: `agentia timemachine diff "<template>" --from <ref> --to <ref|live> --json`
- For a pull request comment: `--format md` (without `--json`).

## References

- Every timemachine command, flag, JSON field and error code: [references/commands.md](references/commands.md)
- The v2 template document: objects, fields, filters, limits, relations: [references/template-document.md](references/template-document.md)

## General Rules

- Never call `agentia cicd data template save-detail`, `convert-old`, `delete` or `data filter add/update/delete`
  for a tracked template unless the user explicitly asks for that exact command. Use `timemachine edit` / `restore`.
- Never pass `--yes` before the user has seen the preview and agreed. Never pass `--ignore-busy` without asking:
  an `ORG_BUSY` error means another tool or person is writing to the same org right now.
- `TEMPLATE_LEGACY`: the template was built in the Copado UI and has no v2 document. Explain that
  `agentia cicd data template convert-old <id>` converts it in place (a write) and run it only if the user agrees.
- `SAVE_BLOCKED`: Copado would reject the document (empty filter or Max. Record Limit). Pass on the `hint`;
  the fix is in the Copado UI or in your file.
- `AUTH_MISSING`: ask the user to run `agentia setup` themselves. Never handle API keys.
- Edits made only in the Copado UI may not reach the v2 document that timemachine versions (and that Copado's record
  selection uses). If the user says they changed a template in the UI, explain this, run
  `agentia timemachine verify "<template>" --json` to show what Copado will actually use, and offer to make the change
  through `timemachine edit` instead.
- Keep human output off stdout in JSON workflows; parse `result` / `error` from the envelope.

## Report Back

When you finish, report: the template, the statements that changed (or that nothing changed), the snapshot
refs before and after, the verified hash, and the undo command. Never include secrets.
