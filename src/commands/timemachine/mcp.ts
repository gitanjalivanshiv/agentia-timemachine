import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {Flags} from '@oclif/core'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'

import {TimemachineCommand} from '../../base-command.js'
import {createServer, spawnRunner} from '../../mcp/server.js'
import {Store} from '../../store/store.js'

export default class TimemachineMcp extends TimemachineCommand {
  static override summary = 'Run Time Machine as an MCP server (stdio) for AI agents.'
  static override description = `Starts a Model Context Protocol server on stdio exposing Time Machine as tools:

  read      tm_status · tm_history · tm_diff · tm_lint · tm_plan · tm_verify
  git only  tm_snapshot
  org write tm_edit_preview → tm_edit_apply · tm_restore_preview → tm_restore_apply

Writes are two-step: an *_apply tool only runs with the previewId of a preview and confirmed=true.
Run it next to Copado's own server (\`agentia mcp start\`). For Claude Code, from your workspace:

  claude mcp add timemachine -- agentia timemachine mcp`

  static override examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --dir ~/hackathon/tm-workspace']

  static override enableJsonFlag = false

  static override flags = {
    dir: Flags.string({description: 'Workspace folder (default: the workspace containing the current folder).'}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(TimemachineMcp)
    const root = flags.dir ? path.resolve(flags.dir) : (Store.find(process.cwd())?.root ?? process.cwd())
    const server = createServer({root, run: spawnRunner(root), version: packageVersion()})
    const transport = new StdioServerTransport()
    const closed = new Promise<void>((resolve) => {
      transport.onclose = () => resolve()
    })
    await server.connect(transport)
    await closed
  }
}

function packageVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  while (dir !== path.dirname(dir)) {
    const file = path.join(dir, 'package.json')
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as {name?: string; version?: string}
      if (pkg.name === 'agentia-plugin-timemachine') return pkg.version ?? '0.0.0'
    }
    dir = path.dirname(dir)
  }
  return '0.0.0'
}
