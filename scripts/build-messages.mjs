#!/usr/bin/env node
// Builds messages/th.json and messages/en.json (spec §14.4) from per-feature fragments in
// messages/src/{th,en}/<namespace>.json, so parallel work never edits one shared file (ADR on message fragments).
// Usage: node scripts/build-messages.mjs           → write the two files
//        node scripts/build-messages.mjs --check   → exit 1 if generated files are stale or th/en keys differ
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const LOCALES = ['th', 'en']
const ROOT = join(import.meta.dirname, '..', 'messages')
const check = process.argv.includes('--check')

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortDeep(value[k])]))
  }
  return value
}

function keyPaths(value, prefix = '') {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k))
  }
  return [prefix]
}

const built = {}
for (const locale of LOCALES) {
  const dir = join(ROOT, 'src', locale)
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []
  const merged = {}
  for (const file of files) {
    const ns = file.replace(/\.json$/, '')
    merged[ns] = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  }
  built[locale] = sortDeep(merged)
}

const problems = []
const [base, ...others] = LOCALES
const baseKeys = new Set(keyPaths(built[base]))
for (const locale of others) {
  const keys = new Set(keyPaths(built[locale]))
  for (const k of baseKeys) if (!keys.has(k)) problems.push(`${locale} ขาด key ${k}`)
  for (const k of keys) if (!baseKeys.has(k)) problems.push(`${base} ขาด key ${k}`)
}

for (const locale of LOCALES) {
  const out = join(ROOT, `${locale}.json`)
  const text = JSON.stringify(built[locale], null, 2) + '\n'
  if (check) {
    const current = existsSync(out) ? readFileSync(out, 'utf8') : ''
    if (current !== text) problems.push(`messages/${locale}.json ไม่ตรงกับ messages/src/${locale}/ — รัน pnpm messages:build`)
  } else {
    writeFileSync(out, text)
  }
}

if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
if (!check) console.log(`messages: ${LOCALES.map((l) => `${l}=${keyPaths(built[l]).length} keys`).join(' · ')}`)
