#!/usr/bin/env node
/**
 * Records a short, deterministic terminal session as an asciinema v2 cast, using the offline org:
 *
 *   node examples/demo/record.mjs [out.cast]          (default: docs/media/timemachine.cast)
 *   agg --theme monokai --font-size 16 docs/media/timemachine.cast docs/media/timemachine.gif
 *
 * Commands are "typed" with a human rhythm and their real output is captured, so the GIF always matches the code.
 */
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = path.resolve(process.argv[2] ?? path.join(repo, 'docs', 'media', 'timemachine.cast'))
const demo = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-record-'))
const ws = path.join(demo, 'workspace')
fs.mkdirSync(ws, {recursive: true})
const env = {
  ...process.env,
  TM_AGENTIA_BIN: path.join(repo, 'scripts', 'fake-agentia.mjs'),
  TM_FAKE_STATE: path.join(demo, 'org'),
  FORCE_COLOR: '0',
  NO_COLOR: '1',
}
const run = (cmd, args) => execFileSync(cmd, args, {cwd: ws, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})
run('git', ['init', '-q', '-b', 'main'])
run('git', ['config', 'user.name', 'Alex (Release Manager)'])
run('git', ['config', 'user.email', 'alex@example.com'])

const COLS = 100
const ROWS = 30
const events = []
let t = 0.4
const emit = (text, dt = 0) => {
  t += dt
  events.push([Number(t.toFixed(3)), 'o', text.replace(/\n/g, '\r\n')])
}
const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
const DIM = '\u001b[2m'
const BOLD = '\u001b[1m'
const CYAN = '\u001b[36m'
const RESET = '\u001b[0m'
const colour = (line) => {
  if (/^\s*\+ /.test(line)) return GREEN + line + RESET
  if (/^\s*- /.test(line)) return RED + line + RESET
  if (/^\s*~ /.test(line)) return YELLOW + line + RESET
  if (/^✔/.test(line)) return GREEN + line + RESET
  if (/\d+ added · \d+ removed/.test(line)) return BOLD + line + RESET
  if (/^\s*(Undo|Previous version)/.test(line)) return DIM + line + RESET
  return line
}
const type = (command) => {
  emit(`${CYAN}$${RESET} `, 0.6)
  for (const ch of command) emit(ch, 0.035 + (ch === ' ' ? 0.03 : 0))
  emit('\n', 0.35)
}
const tm = (...args) => {
  const shown = args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')
  type(`agentia timemachine ${shown}`)
  let text
  try {
    text = run(path.join(repo, 'bin', 'run.js'), ['timemachine', ...args])
  } catch (e) {
    text = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
  for (const line of text.replace(/\s+$/, '').split('\n')) emit(`${colour(line)}\n`, 0.03)
  emit('', 1.6)
}
const comment = (text) => {
  emit(`${DIM}# ${text}${RESET}\n`, 0.8)
}

const T = 'TM Demo - Accounts New'
run(path.join(repo, 'bin', 'run.js'), ['timemachine', 'init', '--track', T]) // set-up, not shown
tm('snapshot', '--all', '--reason', 'baseline')
comment('meanwhile, someone changes the template in Copado…')
run('node', [path.join(repo, 'scripts', 'fake-org.mjs'), 'deselect', 'Fax'])
run('node', [path.join(repo, 'scripts', 'fake-org.mjs'), 'select', 'Description'])
run('node', [path.join(repo, 'scripts', 'fake-org.mjs'), 'batch-size', '100'])
tm('status')
tm('diff', T)
tm('restore', T, '--to', 'HEAD', '--yes')
emit('', 2.5)

const header = {
  version: 2,
  width: COLS,
  height: ROWS,
  timestamp: 1791100000,
  title: 'Agentia Time Machine',
  env: {TERM: 'xterm-256color', SHELL: '/bin/zsh'},
}
fs.mkdirSync(path.dirname(out), {recursive: true})
fs.writeFileSync(out, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n')
fs.rmSync(demo, {recursive: true, force: true})
console.log(`Recorded ${events.length} events (${t.toFixed(1)} s) → ${path.relative(process.cwd(), out)}`)
