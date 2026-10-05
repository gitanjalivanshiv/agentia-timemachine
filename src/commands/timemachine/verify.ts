import {Args, Flags} from '@oclif/core'

import {ExitCode, TimemachineError} from '../../agentia/errors.js'
import {TimemachineCommand} from '../../base-command.js'
import {fetchDetail} from '../../core/inspect.js'
import {resolveTargets} from '../../core/targets.js'
import {compareWithEngine, type EngineView, type VerifyDifference} from '../../core/verify.js'
import {style} from '../../render/style.js'
import {defaultConfig} from '../../store/config.js'
import {Store} from '../../store/store.js'

export interface VerifyEntry {
  template: {id: string; name: string}
  aligned: boolean
  document: EngineView
  engine?: EngineView
  differences: VerifyDifference[]
  /** Records the engine selects from the source org right now (count only). */
  matchingRecords: number | null
  error?: {code: string; message: string}
}

export default class TimemachineVerify extends TimemachineCommand {
  static override summary = "Check that Copado's data engine uses the template document Time Machine versions."
  static override description = `Asks Copado's record selection (\`agentia cicd data records search\`, a read-only query of the template's source
org) which configuration it uses for each template, and compares it with the live v2 detail document: selected
fields, filters, record limit, batch size and external Id field. Prints how many records match today, never their values.

Why: for templates built in the Copado UI and converted to v2, the UI can show a different copy than the v2 document.
This shows which configuration really drives data selection.`

  static override examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New" --json']

  static override strict = false
  static override args = {
    templates: Args.string({description: 'Template names, Ids or slugs (default: tracked templates).', required: false}),
  }

  static override flags = {
    'credential-id': Flags.string({description: "Source org credential (default: the template's schema credential)."}),
  }

  public async run(): Promise<VerifyEntry[]> {
    const {argv, flags} = await this.parse(TimemachineVerify)
    const store = Store.find(process.cwd())
    const config = store?.loadConfig() ?? defaultConfig()
    const client = this.createClient(store?.root)
    await client.assertSupportedVersion()
    const {templates} = await resolveTargets(client, config, argv as string[])

    const entries: VerifyEntry[] = []
    for (const template of templates) {
      const id = {id: template.id, name: template.name}
      try {
        const document = await fetchDetail(client, template)
        const credential = flags['credential-id'] ?? template.sourceOrgId ?? document.schemaCredential
        if (!credential)
          throw new TimemachineError('AGENTIA_USAGE', 'No source credential is known for this template.', ExitCode.Usage, {
            hint: 'Pass --credential-id.',
          })
        const search = await client.searchRecords(credential, template.id)
        const comparison = compareWithEngine(document, search.detail?.[template.id] ?? Object.values(search.detail ?? {})[0])
        entries.push({
          template: id,
          aligned: comparison.differences.length === 0,
          ...comparison,
          matchingRecords: search.totalRecords ?? null,
        })
      } catch (error) {
        if (!(error instanceof TimemachineError) || error.exitCode === ExitCode.AuthMissing) throw error
        entries.push({
          template: id,
          aligned: false,
          document: {fields: [], filters: [], limit: null, batchSize: null, externalIdField: null},
          differences: [],
          matchingRecords: null,
          error: {code: error.code, message: error.message},
        })
      }
    }

    if (!this.jsonEnabled()) for (const e of entries) this.render(e)
    if (entries.some((e) => !e.aligned)) this.fail(1)
    return entries
  }

  private render(e: VerifyEntry): void {
    this.log(style.bold(e.template.name))
    if (e.error) {
      this.log(`  ${style.red('✖')} ${e.error.message}\n`)
      return
    }
    if (e.aligned) this.log(`  ${style.green('✔')} Copado's record selection uses the current v2 document`)
    else for (const d of e.differences) this.log(`  ${style.red('✖')} ${d.message}`)
    const v = e.engine ?? e.document
    this.log(`    ${v.fields.length} fields: ${v.fields.join(', ')}`)
    this.log(
      `    filter: ${v.filters.join(' AND ') || '(none)'} · limit ${v.limit?.toLocaleString('en') ?? '(not set)'} · batch ${v.batchSize ?? '?'}`,
    )
    if (e.matchingRecords !== null)
      this.log(`    ${e.matchingRecords} ${e.matchingRecords === 1 ? 'record matches' : 'records match'} in the source org today`)
    this.log('')
  }
}
