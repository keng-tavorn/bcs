// Validates docs/feature-status.yaml against spec.md and the tests (spec §15.5 gate 10, §15.6).
// - every tier-1 FR in spec §8 has an entry and every entry is a real FR
// - status is valid and step is one of the steps on the FR's "ขั้น" line
// - evidence is test files under tests/, at least one tagged [FR-xxx-nnn/ACn]
// - done/verified/live: every AC of the FR has a tagged test, and (with --reports) that test passed in this run
// - planned: no AC of the FR has a test yet (otherwise the status is out of date)
// - verified/live: verifiedBy names the real users who tried it
// Usage: tsx scripts/check-feature-status.ts [--reports=<vitest json>,<vitest json>]   (pnpm verify passes its reports)
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { acTags, featureStatusProblems, frsFromSpec, testTitleTags, type FeatureDoc, type TestIndex } from './lib/feature-status'
import type { VitestJson } from './lib/verify-gates'

const ROOT = path.resolve(import.meta.dirname, '..')
const abs = (p: string) => path.join(ROOT, p)

function testIndex(reportFiles: string[]): TestIndex {
  const files = new Map<string, string[]>()
  for (const d of readdirSync(abs('tests'), { recursive: true, withFileTypes: true })) {
    if (!d.isFile()) continue
    const file = path.relative(ROOT, path.join(d.parentPath, d.name)).split(path.sep).join('/')
    if (!/\.(ts|tsx)$/.test(file)) continue
    for (const key of new Set(testTitleTags(readFileSync(abs(file), 'utf8')))) files.set(key, [...(files.get(key) ?? []), file])
  }
  if (reportFiles.length === 0) return { files, passed: null }
  const passed = new Set<string>()
  for (const reportFile of reportFiles) {
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as VitestJson
    for (const r of report.testResults) for (const a of r.assertionResults) if (a.status === 'passed') for (const key of acTags(a.fullName)) passed.add(key)
  }
  return { files, passed }
}

const reportsArg = process.argv.find((a) => a.startsWith('--reports='))
const reportFiles = (reportsArg?.slice('--reports='.length).split(',') ?? []).map((s) => s.trim()).filter(Boolean)
for (const f of reportFiles) {
  if (!existsSync(f)) {
    console.error(`ไม่พบรายงาน ${f}`)
    process.exit(1)
  }
}

const frs = frsFromSpec(readFileSync(abs('spec.md'), 'utf8'))
const doc = parse(readFileSync(abs('docs/feature-status.yaml'), 'utf8')) as FeatureDoc
const tests = testIndex(reportFiles)
const problems = featureStatusProblems({
  frs,
  doc,
  tests,
  fs: {
    kind: (p) => (existsSync(abs(p)) ? (statSync(abs(p)).isDirectory() ? 'dir' : 'file') : 'missing'),
    text: (p) => readFileSync(abs(p), 'utf8'),
  },
})

if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
const features = doc.features ?? {}
const count = (s: string) => Object.values(features).filter((f) => f.status === s).length
const passNote = tests.passed ? 'ตรวจกับผลเทสต์รอบนี้' : 'ไม่ได้ตรวจว่าเทสต์ผ่าน (ไม่มี --reports)'
console.log(
  `${Object.keys(features).length} FR · done ${count('done')} · verified ${count('verified')} · live ${count('live')} · in_progress ${count('in_progress')} · planned ${count('planned')} · ${passNote}`,
)
