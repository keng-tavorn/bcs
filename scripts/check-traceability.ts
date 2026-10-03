// Traceability gate (spec §15.7 · docs/traceability/README.md "verify ใช้ไฟล์นี้อย่างไร"): every AC owned by a ticked
// §16 item needs a passing test whose name carries [FR-xxx-nnn/ACn]. The rules live in scripts/lib/traceability.ts;
// this file only loads the inputs and prints the result.
// Usage: tsx scripts/check-traceability.ts [--reports=<vitest json>,<vitest json>] [--e2e-report=<path>] [--json]
//   Vitest reports: --reports=, otherwise env BCS_VITEST_REPORTS (pnpm verify sets it to this run's reports)
//   e2e: test-results/e2e-results.json (playwright.config.ts), used only when newer than every test file
//   --json prints one verify gate result { status, detail, impact, fix } instead of the full report
// Exit code 1 when anything FAILs. A SKIP (an e2e-only AC without e2e results) exits 0 and says SKIP.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { testTitleTags } from './lib/feature-status'
import { evaluateTraceability, traceGateResult, traceLines, type E2eReportInput, type NewestTest } from './lib/traceability'
import type { GateResult, VitestJson } from './lib/verify-gates'

const ROOT = path.resolve(import.meta.dirname, '..')
const abs = (p: string) => path.resolve(ROOT, p)
const relPath = (p: string) => path.relative(ROOT, p).split(path.sep).join('/')
const MAP = 'docs/traceability/ac-map.yaml'
const E2E_REPORT = 'test-results/e2e-results.json'
const TEST_CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const SRC_TEST = /\.test\.tsx?$/

const args = process.argv.slice(2).filter((a) => a !== '--')
const asJson = args.includes('--json')
const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const unknown = args.filter((a) => a !== '--json' && !a.startsWith('--reports=') && !a.startsWith('--e2e-report='))
if (unknown.length) {
  const result: GateResult = {
    status: 'FAIL',
    detail: `ไม่รู้จักตัวเลือก ${unknown.join(' ')}`,
    impact: 'ไม่ได้ตรวจ traceability',
    fix: 'ใช้ได้: --reports=<vitest json,…> --e2e-report=<path> --json',
  }
  console.log(asJson ? JSON.stringify(result) : `FAIL  trace        ${result.detail}\n      วิธีแก้: ${result.fix}`)
  process.exit(1)
}

/** Repo-relative files under `dir` (not folders) whose name matches `pattern`. */
function filesUnder(dir: string, pattern: RegExp): string[] {
  if (!existsSync(abs(dir))) return []
  return readdirSync(abs(dir), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && pattern.test(d.name))
    .map((d) => relPath(path.join(d.parentPath, d.name)))
}

// Vitest reports of this run: they must all be readable, a broken one is a FAIL rather than "no tests"
const reportList = (option('reports') ?? process.env.BCS_VITEST_REPORTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const inputProblems: string[] = []
const vitest: VitestJson[] = []
for (const file of reportList) {
  try {
    const report = JSON.parse(readFileSync(abs(file), 'utf8')) as VitestJson
    if (!Array.isArray(report.testResults)) throw new Error('ไม่มี testResults')
    vitest.push(report)
  } catch (error) {
    inputProblems.push(`รายงาน Vitest ${file}: ${(error as Error).message.split('\n')[0]}`)
  }
}

// Test sources: tags in test titles (static scan) tell an e2e-only AC from one with a Vitest test, and the newest
// file of test code decides whether the Playwright report is recent enough to count
const testFiles = [...filesUnder('tests', TEST_CODE), ...filesUnder('src', SRC_TEST)]
const sources = { vitest: new Map<string, string[]>(), e2e: new Map<string, string[]>() }
let newestTest: NewestTest | null = null
for (const file of testFiles) {
  const mtimeMs = statSync(abs(file)).mtimeMs
  if (!newestTest || mtimeMs > newestTest.mtimeMs) newestTest = { file, mtimeMs }
  const index = file.startsWith('tests/e2e/') ? sources.e2e : sources.vitest
  for (const key of new Set(testTitleTags(readFileSync(abs(file), 'utf8')))) index.set(key, [...(index.get(key) ?? []), file])
}

const e2ePath = option('e2e-report') ?? E2E_REPORT
let e2e: E2eReportInput
if (!existsSync(abs(e2ePath))) e2e = { kind: 'missing', path: e2ePath }
else {
  try {
    e2e = { kind: 'report', path: e2ePath, report: JSON.parse(readFileSync(abs(e2ePath), 'utf8')), mtimeMs: statSync(abs(e2ePath)).mtimeMs }
  } catch (error) {
    e2e = { kind: 'unreadable', path: e2ePath, error: (error as Error).message.split('\n')[0] ?? '' }
  }
}

const report = evaluateTraceability({
  specText: readFileSync(abs('spec.md'), 'utf8'),
  mapText: existsSync(abs(MAP)) ? readFileSync(abs(MAP), 'utf8') : null,
  vitest: reportList.length ? vitest : null,
  e2e,
  newestTest,
  sources,
  inputProblems,
  root: ROOT,
})
console.log(asJson ? JSON.stringify(traceGateResult(report)) : traceLines(report).join('\n'))
// exitCode instead of process.exit() so a long report is never cut off when stdout is a pipe
process.exitCode = report.status === 'FAIL' ? 1 : 0
