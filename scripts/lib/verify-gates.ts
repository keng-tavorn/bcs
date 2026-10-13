// Pure parts of pnpm verify (spec §15.5): argument parsing and how ESLint and Vitest runs are judged.
// Kept free of I/O so the gate logic itself has tests (tests/unit/lint-rules.test.ts).
import path from 'node:path'

export type Status = 'PASS' | 'FAIL' | 'SKIP'
export interface GateResult {
  status: Status
  detail: string
  impact?: string
  fix?: string
}

export interface VerifyArgs {
  strict: boolean
  e2e: boolean
  only: string[] | null
  /** --docs-only=<base>: the e2e gate may skip when every file changed since that commit is a document (CI, P1-03) */
  docsOnlySince: string | null
}

/**
 * Gates that read what other gates of the same run produce. `--only` adds them, so such a gate never judges an
 * empty (or another run's) set of reports: golden case ids are reconciled against the golden and integration
 * reports, because GC-BUD-07 runs against real Postgres in the int project (S3-03, §15.4); the traceability gate
 * reads every Vitest report of the run (an AC may be tested in any project). Its e2e evidence comes from the
 * e2e gate only with --e2e, so --only=trace does not start Playwright by itself.
 */
export const GATE_REQUIRES: Readonly<Record<string, readonly string[]>> = {
  'golden-ids': ['golden', 'integration'],
  trace: ['unit', 'golden', 'property', 'integration'],
}

/** `--strict`, `--e2e`, `--only=a,b`, `--docs-only=<commit>`. Unknown flags and gate names are errors, never a silent "nothing to run". */
export function parseVerifyArgs(
  argv: readonly string[],
  gateNames: readonly string[],
  requires: Readonly<Record<string, readonly string[]>> = {},
): { args: VerifyArgs } | { error: string } {
  const args: VerifyArgs = { strict: false, e2e: false, only: null, docsOnlySince: null }
  for (const arg of argv) {
    if (arg === '--') continue
    if (arg === '--strict') args.strict = true
    else if (arg === '--e2e') args.e2e = true
    else if (arg.startsWith('--docs-only=')) {
      const base = arg.slice('--docs-only='.length).trim()
      if (!/^[0-9a-f]{7,40}$/i.test(base)) return { error: '--docs-only= ต้องตามด้วยเลข commit ฐาน (7 ถึง 40 ตัว 0-9 a-f)' }
      args.docsOnlySince = base
    }
    else if (arg.startsWith('--only=')) {
      const names = arg
        .slice('--only='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (names.length === 0) return { error: '--only= ต้องระบุชื่อด่านอย่างน้อย 1 ด่าน' }
      const unknown = names.filter((n) => !gateNames.includes(n))
      if (unknown.length) return { error: `ไม่รู้จักด่าน ${unknown.join(', ')} — ด่านที่มี: ${gateNames.join(' ')}` }
      args.only = [...new Set([...(args.only ?? []), ...names])]
    } else return { error: `ไม่รู้จักตัวเลือก ${arg} — ใช้ได้: --strict --e2e --only=<ด่าน,ด่าน> --docs-only=<commit>` }
  }
  if (args.only) {
    const selected = [...args.only]
    for (let i = 0; i < selected.length; i++) for (const dep of requires[selected[i]!] ?? []) if (!selected.includes(dep)) selected.push(dep)
    args.only = selected
  }
  return { args }
}

export const lastLines = (text: string, n = 6) =>
  text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-n)
    .join('\n      ')

const rel = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/')

// ---------- ESLint ----------
export interface EslintMessage {
  ruleId: string | null
  severity: number
  line: number
  message: string
  fatal?: boolean
}
export interface EslintFileResult {
  filePath: string
  messages: EslintMessage[]
}

const IMPACT_BY_RULE: Record<string, string> = {
  'bcs/no-money-literal': 'วงเงินฝังในโค้ด ถ้า DOA เปลี่ยน ระบบจะส่งไปผู้อนุมัติผิดข้อ (ขัด P-2)',
  'bcs/no-org-code': 'มีโค้ดเฉพาะลูกค้า ขายให้ลูกค้ารายอื่นไม่ได้ (ขัด NG-7)',
  'boundaries/dependencies': 'ชั้นของโค้ดปนกัน ตรรกะธุรกิจหลุดออกจาก service/core (ขัด P-1 §4.10)',
  'bcs/core-imports': 'core มี I/O หรือ dependency นอก allowlist ผลคำนวณเงินอาจไม่ deterministic (§4.10)',
  'bcs/core-purity': 'core อ่านเวลา สุ่ม หรืออ่าน environment ผล golden และ SLA จะเปลี่ยนตามเวลาที่รัน (§4.2 §17.3)',
  'bcs/restricted-imports': 'โค้ดอ่านข้อมูลข้าม tenant ได้โดยไม่ผ่าน db.forTenant() หรือแตะฐานข้อมูลจากชั้นที่ห้าม (§4.8 §17.3)',
  'bcs/no-raw-sql': 'raw SQL นอก src/server/db/sql ข้ามการกรอง organizationId ได้ (§4.8)',
  'bcs/query-read-only': 'query เขียนข้อมูลโดยไม่ผ่าน runCommand ไม่มี Event และ idempotency (§4.2 §4.3)',
  'bcs/no-thai-literal': 'ข้อความหน้าจอไม่ผ่านไฟล์แปล ผู้ใช้อีกภาษาเห็นข้อความผิดภาษา (NFR-I18N-01)',
  'bcs/no-ui-literal': 'ข้อความหน้าจอไม่ผ่านไฟล์แปล ผู้ใช้อีกภาษาเห็นข้อความผิดภาษา (FR-PLT-002 AC2)',
  'bcs/no-test-skip': 'เทสต์ถูกข้ามหรือกลับผล verify จะผ่านทั้งที่โค้ดผิด (CLAUDE.md §9)',
}

/**
 * Judges one `eslint . --format json` run. Exit code 2 (or any code other than 0/1) means ESLint crashed and
 * linted nothing; the JSON must come from this run's stdout, never from a file an earlier run left behind.
 * `expectedFiles` (repo-relative) must all appear in the results, so an ignore pattern cannot hide a folder.
 */
export function evaluateEslintRun(
  run: { code: number; stdout: string; stderr: string },
  opts: { root: string; expectedFiles: readonly string[] },
): GateResult {
  const crashFix = 'รัน pnpm lint ดูข้อความเต็ม แล้วแก้ eslint.config.mjs หรือ eslint/bcs-plugin.mjs ให้ ESLint ทำงานได้'
  if (run.code !== 0 && run.code !== 1) {
    return {
      status: 'FAIL',
      detail: `ESLint หยุดทำงาน (exit ${run.code}) ไม่ได้ตรวจโค้ด:\n      ${lastLines(`${run.stderr}\n${run.stdout}`, 6)}`,
      impact: 'ไม่ได้ตรวจกฎโค้ดเลย ผลผ่านก่อนหน้านี้ใช้อ้างไม่ได้',
      fix: crashFix,
    }
  }
  let results: EslintFileResult[]
  try {
    results = JSON.parse(run.stdout) as EslintFileResult[]
    if (!Array.isArray(results)) throw new Error('not an array')
  } catch {
    return {
      status: 'FAIL',
      detail: `อ่านผล JSON ของ ESLint ไม่ได้ (exit ${run.code}):\n      ${lastLines(`${run.stderr}\n${run.stdout}`, 6)}`,
      impact: 'ไม่รู้ว่าโค้ดผ่านกฎหรือไม่',
      fix: crashFix,
    }
  }
  const linted = new Set(results.map((r) => rel(opts.root, r.filePath)))
  const notLinted = opts.expectedFiles.filter((f) => !linted.has(f))
  if (notLinted.length) {
    return {
      status: 'FAIL',
      detail: `ESLint ไม่ได้ตรวจ ${notLinted.length} ไฟล์ เช่น ${notLinted.slice(0, 5).join(', ')}`,
      impact: 'ไฟล์ที่ไม่ถูกตรวจเลี่ยงกฎ boundaries เงิน และ tenant ได้ทั้งหมด',
      fix: 'เอา pattern ที่ ignore ไฟล์เหล่านี้ออกจาก eslint.config.mjs (ยกเว้นไว้ได้เฉพาะโค้ดที่ generate)',
    }
  }
  const errors = results.flatMap((f) => f.messages.filter((m) => m.severity === 2 || m.fatal).map((m) => ({ ...m, file: rel(opts.root, f.filePath) })))
  if (errors.length === 0 && run.code === 0) {
    return { status: 'PASS', detail: `${results.length} ไฟล์ · 0 errors (รวม boundaries, bcs/no-money-literal, bcs/no-org-code)` }
  }
  if (errors.length === 0) {
    return { status: 'FAIL', detail: `ESLint คืน exit ${run.code} โดยไม่มี error ในรายงาน`, impact: 'ไม่รู้ว่าโค้ดผ่านกฎหรือไม่', fix: crashFix }
  }
  const first = errors[0]!
  const text = (e: EslintMessage) => {
    const line = e.message.split('\n')[0]!
    return e.ruleId && line.startsWith(`${e.ruleId}: `) ? line.slice(e.ruleId.length + 2) : line
  }
  const list = errors.slice(0, 8).map((e) => `${e.file}:${e.line} ${e.ruleId ?? 'parse'}: ${text(e)}`)
  return {
    status: 'FAIL',
    detail: `${errors.length} errors\n      ${list.join('\n      ')}`,
    impact: IMPACT_BY_RULE[first.ruleId ?? ''] ?? 'โค้ดผิดกฎของโปรเจกต์ (§17.3)',
    fix: 'รัน pnpm lint แล้วแก้ตามไฟล์และบรรทัดที่แสดง (ห้ามปิดกฎด้วย eslint-disable — ไม่มีผลในโปรเจกต์นี้)',
  }
}

// ---------- Vitest ----------
export interface VitestAssertion {
  fullName: string
  title?: string
  status: string
}
export interface VitestJson {
  numTotalTests: number
  numPassedTests: number
  numFailedTests: number
  numPendingTests?: number
  numTodoTests?: number
  testResults: Array<{ name: string; status: string; message?: string; assertionResults: VitestAssertion[] }>
}

/**
 * Judges one `vitest run --reporter=json` run. Only `passed` counts: a skipped, todo or pending test is a FAIL
 * (CLAUDE.md §9), and so is a test file that exists but did not run, or a run with no tests at all.
 */
export function evaluateVitestRun(
  run: { code: number; out: string; report: VitestJson | null },
  opts: { root: string; project: string; expectedFiles: readonly string[]; impact: string },
): GateResult {
  const rerun = `pnpm exec vitest run --project ${opts.project}`
  const { report } = run
  if (!report) {
    return { status: 'FAIL', detail: `vitest ไม่สร้างรายงาน: ${lastLines(run.out)}`, impact: opts.impact, fix: `รัน ${rerun} แล้วแก้ตามข้อความ` }
  }
  const failed: string[] = []
  const notRun: string[] = []
  for (const f of report.testResults) {
    const file = rel(opts.root, f.name)
    for (const a of f.assertionResults) {
      if (a.status === 'failed') failed.push(`${file} › ${a.fullName}`)
      else if (a.status !== 'passed') notRun.push(`${file} › ${a.fullName} (${a.status})`)
    }
    if (f.status === 'failed' && f.assertionResults.length === 0) failed.push(`${file}: ${(f.message ?? '').split('\n')[0]}`)
  }
  const ran = new Set(report.testResults.map((f) => rel(opts.root, f.name)))
  const missing = opts.expectedFiles.filter((f) => !ran.has(f))
  if (failed.length) {
    return {
      status: 'FAIL',
      detail: `${report.numFailedTests}/${report.numTotalTests} เคสไม่ผ่าน\n      ${failed.slice(0, 8).join('\n      ')}`,
      impact: opts.impact,
      fix: `แก้โค้ดให้เทสต์ผ่าน (ห้ามแก้ expect ของ golden หรือข้ามเทสต์) แล้วรัน ${rerun}`,
    }
  }
  const pending = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0)
  if (notRun.length || pending > 0) {
    return {
      status: 'FAIL',
      detail: `${Math.max(notRun.length, pending)} เคสไม่ได้รัน (skip/todo/pending)\n      ${notRun.slice(0, 8).join('\n      ')}`,
      impact: 'เคสที่ถูกข้ามไม่ได้ตรวจอะไรเลย แต่ verify จะดูเหมือนผ่าน (CLAUDE.md §9)',
      fix: 'ลบ .skip/.todo/.only/ctx.skip() แล้วทำให้เทสต์ผ่านจริง',
    }
  }
  if (missing.length) {
    return {
      status: 'FAIL',
      detail: `ไฟล์เทสต์ไม่ได้รัน ${missing.length} ไฟล์: ${missing.slice(0, 5).join(', ')}`,
      impact: 'ไฟล์เทสต์ที่ถูก exclude ไม่ได้ตรวจอะไรเลย',
      fix: `ตรวจ include/exclude ของ project ${opts.project} ใน vitest.config.ts`,
    }
  }
  if (report.numTotalTests === 0) {
    return { status: 'FAIL', detail: 'มีไฟล์เทสต์แต่ไม่มีเคสที่รัน', impact: opts.impact, fix: `รัน ${rerun} แล้วตรวจว่าไฟล์มี it()/test()` }
  }
  if (run.code !== 0) {
    return { status: 'FAIL', detail: `vitest คืน exit ${run.code}:\n      ${lastLines(run.out)}`, impact: opts.impact, fix: `รัน ${rerun} แล้วแก้ตามข้อความ` }
  }
  return { status: 'PASS', detail: `${report.testResults.length} ไฟล์ · ${report.numTotalTests} เคส` }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Case ids (from golden YAML) that have no passed test whose name carries the id, in any of this run's reports
 * (spec §7.0 item 2, §15.2): most cases run in the golden project, concurrency cases such as GC-BUD-07 in int.
 */
export function casesWithoutPassingTest(caseIds: readonly string[], reports: VitestJson | readonly VitestJson[]): string[] {
  const all = Array.isArray(reports) ? (reports as readonly VitestJson[]) : [reports as VitestJson]
  const passed = all.flatMap((r) => r.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === 'passed').map((a) => a.fullName)))
  return caseIds.filter((id) => {
    const re = new RegExp(`(?<![\\w-])${escapeRe(id)}(?![\\w-])`)
    return !passed.some((name) => re.test(name))
  })
}

const TEST_LIKE = /\.(test|spec)\.[cm]?[jt]sx?$/

/**
 * Test files (`*.test.*` / `*.spec.*`) that no runner picks up: a Vitest project include or the Playwright test
 * folder. Such a file never runs, so its tests could never fail — the same as a skipped test (CLAUDE.md §9).
 */
export function orphanTestFiles(files: readonly string[], runnerPatterns: readonly string[]): string[] {
  return files.filter((f) => TEST_LIKE.test(f) && !runnerPatterns.some((p) => path.posix.matchesGlob(f, p)))
}

// ---------- Coverage ----------
/** spec §7.0 item 4 and NFR-MNT-02: the engines of money and authority whose every branch needs a test */
export const COVERAGE_ENGINES = ['money', 'vat', 'thai', 'numbering', 'doa', 'sod', 'delegation', 'budget', 'sla', 'invoice', 'grni', 'ai-checks', 'matching'] as const

export interface CoverageCount {
  total: number
  covered: number
}
/** `--coverage.reporter=json-summary`: one entry per file (absolute path) plus `total` */
export type CoverageSummary = Record<string, { branches: CoverageCount }>

const COVERAGE_OPT_OUT = /\b(?:v8|c8|istanbul)\s+ignore\b/

/**
 * Judges one `vitest run --coverage` over the engines. `files` are the engine files on disk with their source: each
 * must be in the report (a file no test loads is not covered) with every branch covered, and none may opt out of
 * coverage with an ignore comment.
 */
export function evaluateCoverage(
  run: { code: number; out: string; summary: CoverageSummary | null },
  opts: { root: string; files: ReadonlyArray<{ path: string; source: string }> },
): GateResult {
  const impact = 'มีทางเดินของโค้ดเงินหรืออำนาจที่ไม่มีเทสต์ ผลผิดในกรณีนั้นจะไม่ถูกจับ (§7.0 ข้อ 4 · NFR-MNT-02)'
  const rerun = `pnpm exec vitest run --project unit --project golden --project property --coverage.enabled --coverage.include="src/core/{${COVERAGE_ENGINES.join(',')}}/**"`
  if (run.code !== 0 || !run.summary) {
    return { status: 'FAIL', detail: `vitest กับ coverage ล้ม (exit ${run.code}):\n      ${lastLines(run.out)}`, impact, fix: `รัน ${rerun} แล้วแก้ตามข้อความ` }
  }
  const optedOut = opts.files.filter((f) => COVERAGE_OPT_OUT.test(f.source)).map((f) => f.path)
  if (optedOut.length) {
    return { status: 'FAIL', detail: `มีคำสั่งข้าม coverage ใน ${optedOut.join(', ')}`, impact, fix: 'ลบคอมเมนต์ ignore แล้วเพิ่มเทสต์ให้ทางเดินนั้น' }
  }
  const byFile = new Map(
    Object.entries(run.summary)
      .filter(([k]) => k !== 'total')
      .map(([k, v]) => [rel(opts.root, k), v.branches]),
  )
  const missing = opts.files.filter((f) => !byFile.has(f.path)).map((f) => f.path)
  const short = opts.files.flatMap((f) => {
    const b = byFile.get(f.path)
    return b && b.covered < b.total ? [`${f.path} ${b.covered}/${b.total} branch`] : []
  })
  if (missing.length || short.length) {
    const lines = [...short, ...missing.map((p) => `${p} ไม่มีเทสต์ที่โหลดไฟล์นี้`)]
    return { status: 'FAIL', detail: `${lines.length} ไฟล์ไม่ถึง 100% branch\n      ${lines.slice(0, 8).join('\n      ')}`, impact, fix: `เพิ่มเทสต์ใน tests/unit tests/golden หรือ tests/property ให้ทุก branch แล้วรัน ${rerun} --coverage.reporter=text` }
  }
  const total = opts.files.reduce((n, f) => n + byFile.get(f.path)!.total, 0)
  return { status: 'PASS', detail: `${opts.files.length} ไฟล์ของ engine เงินและอำนาจ · branch 100% (${total}/${total})` }
}

// ---------- Playwright ----------
export interface PlaywrightJson {
  stats?: { expected?: number; skipped?: number; unexpected?: number; flaky?: number }
}

/**
 * One report of several `playwright test` runs (the screens, then the demo scenes on their own database): suites and
 * errors side by side, the counts added up, so the traceability gate reads every e2e test of this verify in one file
 */
export function mergePlaywrightReports(reports: ReadonlyArray<PlaywrightJson & Record<string, unknown>>): PlaywrightJson & Record<string, unknown> {
  const stats = { expected: 0, skipped: 0, unexpected: 0, flaky: 0 }
  const suites: unknown[] = []
  const errors: unknown[] = []
  for (const report of reports) {
    stats.expected += report.stats?.expected ?? 0
    stats.skipped += report.stats?.skipped ?? 0
    stats.unexpected += report.stats?.unexpected ?? 0
    stats.flaky += report.stats?.flaky ?? 0
    if (Array.isArray(report.suites)) suites.push(...(report.suites as unknown[]))
    if (Array.isArray(report.errors)) errors.push(...(report.errors as unknown[]))
  }
  const first = reports[0] ?? {}
  return { ...first, suites, errors, stats: { ...(first.stats ?? {}), ...stats } }
}

/**
 * Judges one `playwright test` run by the JSON report it wrote in this run (verify deletes the old one first).
 * A missing report, no test that ran, or a skipped, failed or flaky test is a FAIL.
 */
export function evaluatePlaywrightRun(run: { code: number; out: string; report: PlaywrightJson | null }): GateResult {
  const fix = 'รัน pnpm test:e2e แล้วดูรายงานใน playwright-report'
  if (run.code !== 0) return { status: 'FAIL', detail: lastLines(run.out, 8), impact: 'ฉาก demo ใช้งานจริงไม่ได้', fix }
  const stats = run.report?.stats
  if (!stats) {
    return {
      status: 'FAIL',
      detail: 'Playwright ไม่ได้เขียนรายงาน JSON ของรอบนี้ (test-results/e2e-results.json)',
      impact: 'ไม่รู้ว่าฉากไหนถูกข้าม ผลผ่านจึงอ้างไม่ได้',
      fix: 'ตรวจ reporter json ใน playwright.config.ts',
    }
  }
  const { expected = 0, skipped = 0, unexpected = 0, flaky = 0 } = stats
  if (skipped > 0) return { status: 'FAIL', detail: `${skipped} เคส e2e ไม่ได้รัน (skip/fixme)`, impact: 'ฉากที่ถูกข้ามไม่ได้ตรวจอะไรเลย (CLAUDE.md §9)', fix: 'ลบ test.skip/test.fixme แล้วทำให้ฉากผ่านจริง' }
  if (unexpected > 0 || flaky > 0) {
    return { status: 'FAIL', detail: `${unexpected} เคสล้ม · ${flaky} เคสผ่านเมื่อรันซ้ำ (flaky)`, impact: 'ฉาก demo ล้มได้ต่อหน้าผู้ใช้', fix }
  }
  if (expected === 0) return { status: 'FAIL', detail: 'ไม่มีเคส e2e ที่รัน', impact: 'ไม่ได้ตรวจฉาก demo เลย', fix }
  return { status: 'PASS', detail: `${expected} เคสผ่าน · ไม่มีเคสที่ข้าม` }
}
