#!/usr/bin/env node
/**
 * Turns raw Agentia captures (git-ignored fixtures/raw/**) into anonymised, committable fixtures.
 *
 *   node scripts/scrub-fixtures.mjs [manifest]     (default: fixtures/manifest.json)
 *
 * Manifest entries: { "from": "fixtures/raw/…json", "to": "fixtures/agentia/…json", "exitCode": 0 }.
 * `from` may be a plain `--json` stdout capture or a RecordingRunner file ({args, exitCode, stdout}).
 * Output files use the FakeRunner response shape: { "exitCode": n, "stdout": <parsed JSON> }.
 *
 * Scrubbing (applied consistently across all files in one run, so Ids still line up):
 * - Salesforce record Ids (15/18 chars, containing a digit) → `<3-char key prefix>000000000<n>` (+ `AAA`)
 * - person fields (createdBy, lastModifiedBy, username, fullName, owner…) → "Demo User"
 * - transactionId → deterministic fake UUID
 * After writing, the script fails if any original Id or person value is still present.
 */
import fs from 'node:fs'
import path from 'node:path'

const manifestPath = process.argv[2] ?? 'fixtures/manifest.json'
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

const ID = /\b(?=[A-Za-z0-9]*\d)([A-Za-z0-9]{3})([A-Za-z0-9]{12})([A-Za-z0-9]{3})?\b/g
const PERSON_KEYS = new Set(['createdBy', 'lastModifiedBy', 'username', 'fullName', 'owner', 'ownerName', 'email', 'userName'])
const idMap = new Map()
const secrets = new Set()
let txCounter = 0

function fakeId(match, prefix, body, suffix) {
  // Ignore things that are clearly not Ids (all digits, ISO dates, version strings)
  if (/^\d+$/.test(match)) return match
  const key15 = match.slice(0, 15)
  if (!idMap.has(key15)) idMap.set(key15, `${prefix}${String(idMap.size + 1).padStart(12, '0')}`)
  secrets.add(key15)
  return idMap.get(key15) + (suffix ? 'AAA' : '')
}

function scrub(value, key) {
  if (typeof value === 'string') {
    if (key === 'transactionId') return `00000000-0000-7000-8000-${String(++txCounter).padStart(12, '0')}`
    if (PERSON_KEYS.has(key) && value) {
      secrets.add(value)
      return 'Demo User'
    }
    return value.replace(ID, fakeId)
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, key))
  if (value && typeof value === 'object') {
    // Object keys can be Ids too (`data template get` returns { [templateId]: … })
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(ID, fakeId), scrub(v, k)]))
  }
  return value
}

function load(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (raw && typeof raw === 'object' && 'stdout' in raw && 'args' in raw) {
    return {exitCode: raw.exitCode, stdout: JSON.parse(raw.stdout)}
  }
  return {exitCode: undefined, stdout: raw}
}

const written = []
for (const entry of manifest) {
  const {exitCode, stdout} = load(entry.from)
  const out = {exitCode: entry.exitCode ?? exitCode ?? (stdout && stdout.error ? 1 : 0), stdout: scrub(stdout)}
  fs.mkdirSync(path.dirname(entry.to), {recursive: true})
  fs.writeFileSync(entry.to, JSON.stringify(out, null, 2) + '\n')
  written.push(entry.to)
}

// Verify nothing sensitive survived
const leaks = []
for (const file of written) {
  const text = fs.readFileSync(file, 'utf8')
  for (const s of secrets) if (text.includes(s)) leaks.push(`${file}: ${s.slice(0, 4)}…`)
}
if (leaks.length > 0) {
  console.error(`Scrub failed, sensitive values remain:\n${leaks.join('\n')}`)
  process.exit(1)
}
console.log(`Scrubbed ${written.length} fixtures (${idMap.size} Ids mapped).`)
