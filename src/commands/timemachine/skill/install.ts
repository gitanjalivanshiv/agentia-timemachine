import {Flags} from '@oclif/core'

import {ExitCode, TimemachineError} from '../../../agentia/errors.js'
import {TimemachineCommand} from '../../../base-command.js'
import {
  installSkill,
  TARGETS,
  UnmanagedSkillError,
  updateAgentsMd,
  type InstallResult,
  type InstalledFile,
  type SkillTarget,
} from '../../../core/skill.js'
import {style} from '../../../render/style.js'
import {Store} from '../../../store/store.js'

export interface SkillInstallResult {
  root: string
  installs: InstallResult[]
  agentsMd?: InstalledFile
}

export default class TimemachineSkillInstall extends TimemachineCommand {
  static override summary = 'Install the Time Machine Agent Skill for your coding agent.'
  static override description = `Copies skills/timemachine (SKILL.md + references) into the project so coding agents change data templates
the safe way: snapshot → preview → confirm → edit → verify. Targets use the same folders as
\`agentia setup skills create\`:

  agents  .agents/skills/timemachine   (also adds a pointer to AGENTS.md)
  claude  .claude/skills/timemachine   (Claude Code discovers it automatically)
  cursor  .cursor/skills/timemachine

Re-running updates managed files. Files you created yourself are only replaced with --force.`

  static override examples = [
    '<%= config.bin %> <%= command.id %> --target claude',
    '<%= config.bin %> <%= command.id %> --target agents --target cursor',
  ]

  static override flags = {
    target: Flags.string({
      description: 'Where to install (repeatable).',
      options: Object.keys(TARGETS),
      multiple: true,
      default: ['agents'],
    }),
    force: Flags.boolean({description: 'Replace skill files that were not installed by timemachine.'}),
    dir: Flags.string({description: 'Project folder (default: the timemachine workspace, else the current folder).'}),
  }

  public async run(): Promise<SkillInstallResult> {
    const {flags} = await this.parse(TimemachineSkillInstall)
    const root = flags.dir ?? Store.find(process.cwd())?.root ?? process.cwd()
    const targets = [...new Set(flags.target as SkillTarget[])]
    let installs: InstallResult[]
    try {
      installs = targets.map((t) => installSkill(root, t, flags.force))
    } catch (error) {
      if (error instanceof UnmanagedSkillError) {
        throw new TimemachineError('SKILL_CONFLICT', error.message, ExitCode.Usage, {
          hint: 'Move it away, or re-run with --force to replace it.',
        })
      }
      throw error
    }
    const agentsMd = updateAgentsMd(root, targets)

    if (!this.jsonEnabled()) {
      for (const i of installs) {
        const changed = i.files.filter((f) => f.action !== 'unchanged').length
        this.log(
          `${style.green('✔')} ${i.target}: ${i.dir} ${style.dim(changed === 0 ? '(already up to date)' : `(${changed} file${changed === 1 ? '' : 's'} written)`)}`,
        )
      }
      if (agentsMd && agentsMd.action !== 'unchanged')
        this.log(`${style.green('✔')} AGENTS.md ${agentsMd.action} with a pointer to the skill`)
      this.log(style.dim('\nTry it: ask your agent to "add the <Field> field to the <template name> template".'))
    }
    return {root, installs, agentsMd}
  }
}
