import {Args, Flags} from '@oclif/core'

import {TemplateDetailSchema} from '../../agentia/schemas.js'
import {TimemachineCommand} from '../../base-command.js'
import {lintDocument, RULES, type Finding} from '../../core/lint.js'
import {fetchLive} from '../../core/snapshot.js'
import {resolveTracked} from '../../core/targets.js'
import {style} from '../../render/style.js'
import {Store} from '../../store/store.js'

export interface LintEntry {
  template: {id: string; name: string; slug: string}
  source: string
  findings: Finding[]
}

export interface LintResult {
  templates: LintEntry[]
  counts: {error: number; warning: number; info: number}
}

const ICON = {error: style.red('✖'), warning: style.yellow('!'), info: style.blue('i')}

export default class TimemachineLint extends TimemachineCommand {
  static override summary = 'Check data templates for mistakes before they are applied or deployed.'
  static override description = `Runs rules against each tracked template's v2 document: the committed version (default HEAD), or live with
--ref live. Exits with 1 when there are errors (or warnings, with --strict).

Rules:
${RULES.map((r) => `  ${r.id} ${r.name.padEnd(22)} ${r.severity.padEnd(8)} ${r.description}`).join('\n')}

Disable rules or tune thresholds in .timemachine/config.json: {"lint": {"disable": ["TM011"], "highVolumeLimit": 5000}}.`

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --ref live',
    '<%= config.bin %> <%= command.id %> --strict --json',
  ]

  static override strict = false
  static override args = {
    templates: Args.string({description: 'Tracked template names, Ids or slugs (default: all tracked).', required: false}),
  }

  static override flags = {
    ref: Flags.string({description: 'Version to lint: a git ref, or "live" to read Copado.', default: 'HEAD'}),
    strict: Flags.boolean({description: 'Also fail on warnings.'}),
  }

  public async run(): Promise<LintResult> {
    const {argv, flags} = await this.parse(TimemachineLint)
    const store = Store.require(process.cwd())
    const config = store.loadConfig()
    const client = this.createClient(store.root)
    await client.assertSupportedVersion()
    const targets = await resolveTracked(client, config, argv as string[])

    const templates: LintEntry[] = []
    for (const {tracked, listed} of targets) {
      let doc: unknown
      let source = flags.ref
      if (flags.ref !== 'live') doc = await store.showAt(flags.ref, store.templateRel(tracked.slug, 'template.json'))
      if (doc === undefined) {
        doc = (await fetchLive(client, listed, config)).detail
        source = 'live'
      } else doc = JSON.parse(doc as string)
      const findings = lintDocument(TemplateDetailSchema.parse(doc), config.lint)
      templates.push({template: {id: tracked.id, name: tracked.name, slug: tracked.slug}, source, findings})
    }

    const all = templates.flatMap((t) => t.findings)
    const counts = {error: 0, warning: 0, info: 0}
    for (const f of all) counts[f.severity]++

    if (!this.jsonEnabled()) {
      for (const t of templates) {
        this.log(`${style.bold(t.template.name)} ${style.dim(`(${t.source})`)}`)
        if (t.findings.length === 0) this.log(`  ${style.green('✔')} no problems`)
        for (const f of t.findings) {
          this.log(`  ${ICON[f.severity]} ${style.dim(f.rule)} ${f.message}`)
          this.log(`    ${style.dim('→')} ${f.fix}`)
        }
        this.log('')
      }
      this.log(
        `${counts.error} error${counts.error === 1 ? '' : 's'} · ${counts.warning} warning${counts.warning === 1 ? '' : 's'} · ${counts.info} info`,
      )
    }
    if (counts.error > 0 || (flags.strict && counts.warning > 0)) this.fail(1)
    return {templates, counts}
  }
}
