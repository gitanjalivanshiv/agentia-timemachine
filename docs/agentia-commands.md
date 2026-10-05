# Agentia CLI commands used by timemachine

Discovered from `@copado/agentia-cli/1.0.0-beta.2` (darwin-arm64, node 24). Raw `--help`
output for any command below: `agentia <command> --help`. Status markers:

- ✅ **verified**: observed from real CLI output
- 🟡 **from help/source**: read from `--help` or the shipped CLI package, not yet run against an org
- ❓ **open**: needs a real org call (Phase 0, step 3)

## JSON envelope (all commands) ✅

Every Agentia command extends a shared base command with oclif's `enableJsonFlag`.
With `--json`, **both success and error go to stdout**, and stderr is empty.

```ts
// exit code 0
interface AgentiaSuccess<T> {
  result: T // the command's return value (shapes below)
  status: 0
  transactionId: string // UUIDv7, useful for Copado support tickets
}

// exit code 1 (observed); oclif's default error exit code
interface AgentiaError {
  error: {
    message: string
    name: string // observed: "Error" (generic), so classify by message text
    // oclif may also include: code?, exitCode?, suggestions?, stack? (with --debug)
  }
  transactionId: string
}
```

Observed auth error (no CICD key configured), exit 1:

```json
{
  "error": {
    "message": "CICD API key is not configured. Run `agentia auth set --cicd <key> [--region <region> | --custom-url <url>]` or set AGENTIA_CICD_API_KEY.",
    "name": "Error"
  },
  "transactionId": "…"
}
```

### Gateway (HTTP) errors ✅

Errors from the Copado API have a richer, structured shape. Map these by `statusCode` + `categories`:

```ts
interface CicdGatewayErrorJson {
  name: 'CicdGatewayError'
  code: string // observed: 'HANDLED_EXCEPTION'
  categories: string[] // observed: 'DAT-004', 'LGN-001'
  statusCode: number // HTTP status from Copado (observed 404, 502)
  requestMethod: string
  requestUrl: string // api_key is already masked as %3Cmasked%3E, but we still never log it
  message: string
}
```

| Category  | Status | Observed when                                                                                                                                                            | timemachine error                                           |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `DAT-004` | 404    | `get`/`get-detail` on a non-existent Id **and** on a template whose detail attachment was never generated. The message is `Failed to download template attachment: <id>` | `TemplateNotFound` (use `list` to tell the two cases apart) |
| `LGN-001` | 502    | Copado's data service can't log in to the source org (`sobject fields`, `template create`)                                                                               | `SourceOrgLoginError`                                       |

### Exit codes ✅

| Exit | Meaning                                                                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | success (`{result,status:0}`)                                                                                                                                                                      |
| 1    | runtime error (auth missing, gateway error)                                                                                                                                                        |
| 2    | **oclif parse error** (e.g. missing arg). JSON is `{error:{oclif:{exit:2}, parse:{…}}}` and can be **~1.6 MB** (it embeds command metadata). Never echo it; validate our own args before spawning. |

### Working directory matters ✅ (for project-scoped auth)

Project-scoped auth (`agentia setup` → "Project-scoped") is found **only when `agentia` runs with the
project root as cwd**. From a subfolder (`fixtures/raw`) the same command fails with "CICD API key is
not configured". `AgentiaClient` must spawn with `cwd` = the timemachine project root.

➡ `AgentiaClient` must parse stdout for both outcomes, map `CicdGatewayError` by status/category,
then by `error.message` patterns for plain `Error`, and fall back to a generic
`AgentiaCommandError` that carries `transactionId`.

Auth can also come from the environment (`AGENTIA_CICD_API_KEY`, `AGENTIA_CICD_BASE_URL`,
per Copado's shipped `agentia-cicd` skill). That is useful for CI.

## Data template commands

All of them call the Copado REST base `/release/data-templates`.

### `agentia cicd data template list` ✅

```
agentia cicd data template list [--json] [--active|--no-active] [--fetch-related]
                                [--main-object <sObject>] [--name <name>]
```

`GET /release/data-templates?…`. The CLI unwraps `{data:[…]}` to an array. Empty org → `result: []`.

```ts
interface TemplateListItem {
  id: string // record Id, e.g. a0U…  (prefix is org-specific, not a0X)
  name: string
  mainObject: string // e.g. "Account"
  status: string // e.g. "Inactive"
  active: boolean
  actionType: string // e.g. "none"
  createdBy: string // display name (PII: scrub in fixtures)
  createdDate: string // "2026-10-02T18:45:22.000+0000"
  lastModified: string // same format; candidate concurrency signal (❓ bumped by save-detail?)
  sourceOrgId: string // NB: this is the *credential* Id (a11…), not an org Id
  sourceOrgName: string // credential name
  sourceEnvironmentId: string
  [k: string]: unknown // keep via zod passthrough
}
type TemplateListResult = TemplateListItem[]
```

### `agentia cicd data template create` ✅ (gotcha)

**Not atomic.** On Dev1-SFP it returned `LGN-001`/502 (exit 1), yet the template **record was
created**, without its detail attachment. Never retry a failed create blindly; `list --name` first.

### `agentia cicd data template get-detail ID` ✅ (the document we version)

`GET /release/data-templates/{id}/detail`. Returns the raw API payload unchanged (`result = TemplateDetail`).
A freshly created template (Account, Dev1-SFP) produced ~9 KB with 29 auto-selected columns.

```ts
interface TemplateDetail {
  version: 2 // SCHEMA version (v2 marker), NOT a revision counter
  templateName: string
  templateApiName: string
  templateId: string
  mainObject: {apiName: string; label: string}
  application: string // "" observed
  applicationModule: string // "" observed
  details: TemplateObjectDetail[] // one per object in the template graph
  status: string // "Inactive"
  schemaCredential: string // credential Id (a11…)
}

interface TemplateObjectDetail {
  // natural key: templateId (fallback: table)
  templateId: string
  templateName: string
  apiName: string
  table: string // sObject API name, e.g. "Account"
  autoUpdate: string // "manual"
  batchSize: number // 200
  limit: number // 50000
  matchOwner: boolean
  matchRecordType: boolean
  attachmentOption: string // "NONE"
  fileOption: string // "NONE"
  queryTemplate: string // "1"
  continueOnError: string // "Stop deployment on first issue"
  filters: unknown[] // ❓ element shape (empty so far). Natural key TBD
  rawFilters: unknown[] // ❓
  columns: TemplateColumn[] // natural key: name
  externalIdField: string // "Id"
  externalIdGeneration: IdGeneration
  virtualIdGeneration: IdGeneration
  virtualExternalIdEnabled: boolean
  parentTemplates: unknown[] // ❓ relations to other templates. Natural key likely templateId
  childTemplates: unknown[] // ❓
}

interface TemplateColumn {
  name: string // field API name: natural key
  type: string // "id" | "string" | "picklist" | "textarea" | "double" | "phone" | "url" | "currency" | "int" | …
  anonymizerType: {type: string} // "None"
  lookUpType: string // "NONE"
  isSelected: boolean // ⚠ "removing" a field may mean isSelected:false, not deletion
  externalId: boolean
}

interface IdGeneration {
  generateExternalId: boolean
  needsHashing: boolean
  fields: unknown[]
  recordMatchingFormulaId: string | null // link to `data formula` resources
  recordMatchingFormulaName: string | null
}
```

**No etag / lastModified inside the detail.** Concurrency must use the canonical hash of this document
(plus `list`'s `lastModified` as a cheap pre-check).

### `agentia cicd data template get ID` ✅

Returns `{ [templateId]: TemplateObjectDetail }`, i.e. the same per-object block as `details[]`, keyed by Id,
without the outer header. Redundant for us; `get-detail` is the source of truth.

### `agentia cicd data template save-detail ID (--file <path> | --stdin)` ✅

`PUT /release/data-templates/{id}/detail`. The body must be a JSON **object** (the CLI asserts this),
and exactly one of `--file`/`--stdin`. This is a full-document replace (PUT). **Result: `true`.** The exact `get-detail` result round-trips
(identical canonical hash) **provided no required field is null/empty**: the gateway strips `null`/`[]`, and
`details[].filters`, `details[].rawFilters` and `details[].limit` are required → else `422 MDW-003
"[details.0.<field>] (missing): Field required"`. Every save bumps `list.lastModified`.
The human output is `Saved data template detail for <id>.`

### `agentia cicd data template convert-old ID` 🟡

`POST`, which converts a legacy template to v2. Result is printed as `Converted legacy data template (ID: <result>)`,
so `result` is probably the (new?) template Id string ❓. **Write operation; never call it automatically.**

### Others (not used by timemachine core)

`create`, `delete` (destructive), `open` (browser only).

## Advanced filters: separate from the detail document 🟡

| Command                                                 | HTTP                 | Notes                                |
| ------------------------------------------------------- | -------------------- | ------------------------------------ |
| `cicd data filter list TEMPLATEID`                      | GET `/{id}/…filters` | result: array (CLI unwraps `{data}`) |
| `cicd data filter add TEMPLATEID (-f\|--stdin)`         | POST                 | result: new filter UUID              |
| `cicd data filter update TEMPLATEID UUID (-f\|--stdin)` | PUT                  |                                      |
| `cicd data filter delete TEMPLATEID UUID`               | DELETE               |                                      |

```ts
interface AdvancedFilter {
  uuid: string // natural diff key
  filterName?: string // ❓ key (table column NAME)
  objects?: unknown[] // ❓ table shows objects.length
  [k: string]: unknown
}
```

❓ Is the filter also embedded inside `get-detail`? If so, snapshotting it separately is
redundant. If not, it goes in `extras.json`.

## Record matching formulas: keyed by sObject, not template 🟡

| Command                                                                                   | Notes                             |
| ----------------------------------------------------------------------------------------- | --------------------------------- |
| `cicd data formula list OBJECTAPINAME`                                                    | **per sObject**, not per template |
| `cicd data formula create TEMPLATEID --name --object-api-name --fields… [--hash-formula]` | up to 3 fields                    |
| `cicd data formula update FORMULAID [flags \| -f \| --stdin]`                             |                                   |

```ts
interface RecordMatchingFormula {
  id: string
  name: string
  objectApiName: string
  hashFormula?: boolean
  [k: string]: unknown // ❓ fields array key
}
```

➡ To snapshot formulas for a template, we list formulas for each sObject that appears in the
detail document. Formulas are shared across templates for the same object.

## Record selection ✅ (`verify`)

`agentia cicd data records search --credential-id <cred> --data-template-id <id> [--changed-date-from <iso>] (-f|--stdin)`.
`POST /release/data-templates/records`, a **read-only query of the source org** that Copado uses to select records for data
commits. The result is **not** unwrapped by the CLI:

```ts
interface RecordSearch {
  totalRecords: number
  currentPage: number
  pageSize: number
  totalPages: number
  hasMore: boolean | null
  nextCursor: string | null
  data: {
    id: string
    name: string
    type: string
    lastModifiedDate: string
    lastModifiedBy: string
    createdDate: string
    detail: Record<string, unknown> /* the record's field values: never print or store */
    templateIds: string[]
    externalIdField: string
    externalIdGeneration: {generated: boolean; validation: {isValid: boolean; warning: string | null}}
  }[]
  detail: {[templateId: string]: TemplateObjectDetail /* selected columns only */}
}
```

Observed: for a converted template whose UI copy had Phone deselected, `detail.columns` and the record fields followed the
**v2 document** (Phone included). Time Machine's `verify` compares this `detail` with the live v2 document.

## Field sync 🟡

`cicd data sync preview-updates (-f|--stdin)` and `cicd data sync apply (-f|--stdin)`. These update
templates after metadata changes. They are **another writer** that can change a template outside
timemachine, so `status`/`edit` must treat any hash change as drift regardless of cause.

## Supporting read-only commands

| Command                                                                            | Use                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `agentia --version`                                                                | version gate (`@copado/agentia-cli/<ver> …`)            |
| `agentia cicd user get --json`                                                     | cheap auth probe ("who am I"); **never log the result** |
| `agentia cicd data sobject fields SOBJECT --credential-id ID`                      | lint: does a field still exist                          |
| `agentia plugins link .`                                                           | dev install of our plugin                               |
| `agentia setup skills create --cicd --target <agents\|cursor\|claude> --no-prompt` | reference skill layout                                  |
| `agentia mcp start`                                                                | stdio MCP server for the demo                           |

**Avoid** `agentia auth get` in our code. It prints stored keys.

## Skill format (to mirror in `skills/timemachine/SKILL.md`) ✅

Copado's skills live at `<root>/skills/<name>/SKILL.md` plus `references/*.md`. They have YAML
front-matter with `name` and `description` only, then a managed-file HTML comment, then
"Start Here", "References" and "General Rules". Target roots are `agents` (`.agents/skills`),
`cursor` and `claude`. Copado's own data reference already says _"Keep `get-detail` output as a
baseline before changing template detail"_, which timemachine automates.

## Open questions

All Phase 0 questions are answered (see `decisions.md`, 2026-10-05). Remaining unknowns:

- Shapes of `parentTemplates` / `childTemplates` entries (no relations configured yet).
- Whether Copado UI edits on a converted template reach the v2 document.
