import fs from 'node:fs'

import {Args, Flags} from '@oclif/core'

import {TimemachineCommand} from '../../base-command.js'
import {computePlan, publicEntry, type PlanEntry} from '../../core/plan.js'
import {resolveTracked} from '../../core/targets.js'
import {renderPlanMarkdown, renderPlanText} from '../../render/plan.js'
import {style} from '../../render/style.js'
import {Store} from '../../store/store.js'

export interface PlanResult {
  ref: string
  templates: PlanEntry[]
  /** Templates that apply would change. */
  changes: number
}

export default class TimemachinePlan extends TimemachineCommand {
  static override summary = 'Show what applying the committed template versions would change in Copado (for PR review).'
  static override description = `Compares the version of each tracked template committed at a git ref (default HEAD) with live Copado and
prints what \`timemachine apply\` would change. Use --format md for a pull-request comment.

It also checks each template's base (its last snapshot). If Copado changed since then, the plan says so and
apply will refuse, so a pull request can never silently overwrite a change made in Copado.`

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --format md --output plan.md',
    '<%= config.bin %> <%= command.id %> "TM Demo - Accounts New" --ref origin/feature --json',
  ]

  static override strict = false
  static override args = {
    templates: Args.string({description: 'Tracked template names, Ids or slugs (default: all tracked).', required: false}),
  }

  static override flags = {
    ref: Flags.string({description: 'Git ref with the versions to apply.', default: 'HEAD'}),
    format: Flags.string({description: 'Human output format.', options: ['text', 'md'], default: 'text'}),
    output: Flags.string({char: 'o', description: 'Also write the Markdown plan to this file (for CI comments).'}),
    'exit-code': Flags.boolean({description: 'Exit with 1 when apply would change something.'}),
  }

  public async run(): Promise<PlanResult> {
    const {argv, flags} = await this.parse(TimemachinePlan)
    const store = Store.require(process.cwd())
    const config = store.loadConfig()
    const client = this.createClient(store.root)
    await client.assertSupportedVersion()
    const targets = await resolveTracked(client, config, argv as string[])
    const ref = (await store.git.revparse(['--short', flags.ref])).trim()

    const entries = (await computePlan(client, store, config, targets, flags.ref)).map(publicEntry)
    const changes = entries.filter((e) => e.statements.length > 0).length
    const markdown = renderPlanMarkdown(entries, ref)
    if (flags.output) fs.writeFileSync(flags.output, `${markdown}\n`)

    if (!this.jsonEnabled()) {
      this.log(flags.format === 'md' ? markdown : renderPlanText(entries, ref))
      if (flags.output) this.log(style.dim(`\nMarkdown written to ${flags.output}`))
    }
    if (flags['exit-code'] && changes > 0) this.fail(1)
    return {ref, templates: entries, changes}
  }
}
