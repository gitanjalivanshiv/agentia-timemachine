import fs from 'node:fs'
import path from 'node:path'

import type {Command} from '@oclif/core'
import {describe, expect, it} from 'vitest'

import {ExitCode} from '../src/agentia/errors.js'
import TimemachineInit, {type InitResult} from '../src/commands/timemachine/init.js'
import TimemachineSkillInstall, {type SkillInstallResult} from '../src/commands/timemachine/skill/install.js'
import {MANAGED_MARKER, bundledSkillDir} from '../src/core/skill.js'
import {runCli} from './cli.js'
import {ROOT, tempDir, tempRepo} from './helpers.js'

const SKILL = path.join(ROOT, 'skills', 'timemachine')
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8')
const docs = () => ['SKILL.md', 'references/commands.md', 'references/template-document.md'].map((f) => read(SKILL, f)).join('\n')

describe('the bundled skill', () => {
  it("has Agent Skill front-matter like Copado's skills", () => {
    const md = read(SKILL, 'SKILL.md')
    const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(md)
    expect(front?.[1]).toBe('timemachine')
    expect(front![2].length).toBeLessThanOrEqual(1024)
    expect(md).toContain(MANAGED_MARKER)
    for (const heading of ['## Start Here', '## References', '## General Rules', '## Report Back']) expect(md).toContain(heading)
  })

  it('links only to files that exist', () => {
    for (const [, link] of read(SKILL, 'SKILL.md').matchAll(/\]\(([^)]+\.md)\)/g)) expect(fs.existsSync(path.join(SKILL, link))).toBe(true)
  })

  it('teaches the safe order: snapshot, preview, confirm, save', () => {
    const full = read(SKILL, 'SKILL.md')
    const md = full.slice(full.indexOf('## Change A Template'), full.indexOf('## When The Save Is Blocked'))
    const order = ['timemachine snapshot', '--dry-run', 'confirm', '--yes'].map((s) => md.indexOf(s))
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(full).toMatch(/Never call `agentia cicd data template save-detail`/)
  })

  it('mentions only commands and flags that exist (doc-test)', async () => {
    const mentions = [...docs().matchAll(/agentia timemachine ([a-z]+(?: install)?)\b([^\n`|]*)/g)]
    expect(mentions.length).toBeGreaterThan(15)
    for (const [, name, rest] of mentions) {
      const file = path.join(ROOT, 'src', 'commands', 'timemachine', `${name.replace(' ', '/')}.ts`)
      expect(fs.existsSync(file), `command "${name}"`).toBe(true)
      const command = ((await import(file)) as {default: typeof Command}).default
      const flags = new Set([...Object.keys(command.flags ?? {}), ...Object.keys(command.baseFlags ?? {}), 'json'])
      for (const [, flag] of rest.matchAll(/--([a-z-]+)/g)) expect(flags.has(flag), `${name} --${flag}`).toBe(true)
    }
  })

  it('is found from the compiled or source tree', () => {
    expect(bundledSkillDir()).toBe(SKILL)
  })

  it('ships with the npm package', () => {
    expect(JSON.parse(read(ROOT, 'package.json')).files).toContain('/skills')
  })
})

describe('timemachine skill install', () => {
  it('installs for agents, claude and cursor, and points AGENTS.md at it', async () => {
    const root = tempDir()
    const res = await runCli(TimemachineSkillInstall, [
      '--target',
      'agents',
      '--target',
      'claude',
      '--target',
      'cursor',
      '--dir',
      root,
      '--json',
    ])
    expect(res.exitCode).toBe(0)
    for (const dir of ['.agents/skills', '.claude/skills', '.cursor/skills']) {
      expect(read(root, dir, 'timemachine', 'SKILL.md')).toBe(read(SKILL, 'SKILL.md'))
      expect(fs.existsSync(path.join(root, dir, 'timemachine', 'references', 'commands.md'))).toBe(true)
    }
    const agents = read(root, 'AGENTS.md')
    expect(agents).toContain('.agents/skills/timemachine/SKILL.md')
    expect(agents).toContain('.cursor/skills/timemachine/SKILL.md')
    expect(agents).not.toContain('.claude/')
    expect(res.json<{result: SkillInstallResult}>().result.installs).toHaveLength(3)
  })

  it("is idempotent and keeps Copado's AGENTS.md content", async () => {
    const root = tempDir()
    fs.writeFileSync(
      path.join(root, 'AGENTS.md'),
      '# Agentia CLI for AI Agents\n\n<!-- agentia:managed:start -->\nCopado text\n<!-- agentia:managed:end -->\n',
    )
    await runCli(TimemachineSkillInstall, ['--dir', root])
    const once = read(root, 'AGENTS.md')
    const again = await runCli(TimemachineSkillInstall, ['--dir', root])
    expect(again.stdout).toContain('already up to date')
    expect(read(root, 'AGENTS.md')).toBe(once)
    expect(once).toContain('Copado text')
    expect(once.match(/timemachine:managed:start/g)).toHaveLength(1)
  })

  it('updates managed files but never overwrites files it did not write, unless --force', async () => {
    const root = tempDir()
    const dest = path.join(root, '.claude', 'skills', 'timemachine', 'SKILL.md')
    fs.mkdirSync(path.dirname(dest), {recursive: true})
    fs.writeFileSync(dest, 'my own skill')
    const refused = await runCli(TimemachineSkillInstall, ['--target', 'claude', '--dir', root])
    expect(refused.exitCode).toBe(ExitCode.Usage)
    expect(refused.stderr).toContain('--force')
    expect(read(dest)).toBe('my own skill')

    await runCli(TimemachineSkillInstall, ['--target', 'claude', '--dir', root, '--force'])
    fs.writeFileSync(dest, `${MANAGED_MARKER}\nold version`)
    const updated = await runCli(TimemachineSkillInstall, ['--target', 'claude', '--dir', root])
    expect(updated.exitCode).toBe(0)
    expect(read(dest)).toBe(read(SKILL, 'SKILL.md'))
  })

  it('installs into the workspace when run inside one', async () => {
    const ws = tempRepo()
    await runCli(TimemachineInit, [], undefined, ws)
    const sub = path.join(ws, 'deep')
    fs.mkdirSync(sub)
    await runCli(TimemachineSkillInstall, ['--target', 'claude'], undefined, sub)
    expect(fs.existsSync(path.join(ws, '.claude', 'skills', 'timemachine', 'SKILL.md'))).toBe(true)
  })

  it('can be installed by init', async () => {
    const ws = tempRepo()
    const res = await runCli(TimemachineInit, ['--skill', 'claude', '--json'], undefined, ws)
    const [dir] = res.json<{result: InitResult}>().result.skills
    expect(fs.realpathSync(dir)).toBe(path.join(fs.realpathSync(ws), '.claude', 'skills', 'timemachine'))
  })
})
