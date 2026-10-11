// pnpm verify — every quality gate of spec §15.5, reported PASS/FAIL/SKIP one by one.
// A FAIL prints its real-world impact and a concrete fix, and the process exits non-zero.
// A gate may SKIP only when the thing it checks does not exist in the repo yet (never because Docker or the
// database is down). `--strict` (finish line A) turns every SKIP into FAIL except the documented allowlist.
// Flags: --strict  --e2e (run the Playwright gate)  --only=<gate,gate>   Unknown flags or gate names are a FAIL.
// Reports of this run live in a private folder under .vitest/ and are deleted at the end, so a gate never reads
// a file left behind by an earlier run (or by another run going on at the same time). BCS_VITEST_REPORTS lists them
// for the gates and checkers that read them; a value inherited from the shell is dropped first.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import vitestConfig from '../vitest.config'
import {
  COVERAGE_ENGINES,
  GATE_REQUIRES,
  casesWithoutPassingTest,
  evaluateCoverage,
  evaluateEslintRun,
  evaluatePlaywrightRun,
  mergePlaywrightReports,
  evaluateVitestRun,
  lastLines,
  orphanTestFiles,
  parseVerifyArgs,
  type CoverageSummary,
  type GateResult,
  type PlaywrightJson,
  type Status,
  type VitestJson,
} from './lib/verify-gates'

delete process.env.BCS_VITEST_REPORTS

interface Gate {
  name: string
  run: () => GateResult
}

const ROOT = path.resolve(import.meta.dirname, '..')
// SKIPs that are acceptable even in --strict mode, with the reason printed
const STRICT_SKIP_ALLOWED: Record<string, string> = {}
const RUN_DIR = path.join(ROOT, '.vitest', `verify-${process.pid}-${process.hrtime.bigint()}`)
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const TEST_FILE = /\.test\.tsx?$/
// Generated code that eslint.config.mjs ignores on purpose; every other code file in src/ and tests/ must be linted
const LINT_IGNORED = ['src/server/db/generated/']

const exists = (p: string) => existsSync(path.join(ROOT, p))
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

function sh(command: string, opts: { env?: Record<string, string> } = {}) {
  const r = spawnSync(command, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', ...opts.env },
    maxBuffer: 256 * 1024 * 1024,
  })
  const stdout = r.stdout ?? ''
  const stderr = `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`
  return { code: r.status ?? 1, stdout, stderr, out: `${stdout}${stderr}` }
}

/** Files (not folders: a Next.js route folder may be named `sw.js`) under `dir` whose path relative to `dir` matches `pattern`. */
function filesUnder(dir: string, pattern: RegExp): string[] {
  const abs = path.join(ROOT, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(abs, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
    .filter((f) => pattern.test(f))
}

/** A failed checker's stderr (one problem per line) as a count plus the first lines, so a long list is not cut from the top. */
function problemList(r: { stderr: string; out: string }, n = 10): string {
  const lines = r.stderr.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length === 0) return lastLines(r.out, n)
  const more = lines.length > n ? '\n      …' : ''
  return `${lines.length} ปัญหา\n      ${lines.slice(0, n).join('\n      ')}${more}`
}

// ---------- Vitest helpers ----------
const reports = new Map<string, string>()

function runVitest(project: string): { code: number; out: string; report: VitestJson | null } {
  mkdirSync(RUN_DIR, { recursive: true })
  const outFile = path.join(RUN_DIR, `${project}.json`)
  rmSync(outFile, { force: true })
  const r = sh(`pnpm exec vitest run --project ${project} --reporter=json --outputFile="${outFile}" --passWithNoTests`)
  const report = existsSync(outFile) ? (JSON.parse(readFileSync(outFile, 'utf8')) as VitestJson) : null
  if (report) {
    reports.set(project, outFile)
    // Later gates (features, traceability) read this run's reports from here, never from a fixed path
    process.env.BCS_VITEST_REPORTS = [...reports.values()].join(',')
  }
  return { code: r.code, out: r.out, report }
}

function vitestGate(project: string, dirs: string[], label: string, impact: string): { result: GateResult; report: VitestJson | null } {
  const expectedFiles = dirs.flatMap((dir) => filesUnder(dir, TEST_FILE).map((f) => `${dir}/${f}`))
  if (expectedFiles.length === 0) return { result: { status: 'SKIP', detail: `ยังไม่มีเทสต์${label}ใน ${dirs[0]}/` }, report: null }
  const run = runVitest(project)
  return { result: evaluateVitestRun(run, { root: ROOT, project, expectedFiles, impact }), report: run.report }
}

/** Every file pattern a test runner picks up: each Vitest project's include, and Playwright's testDir. */
function runnerPatterns(): string[] {
  const projects = (vitestConfig.test?.projects ?? []) as Array<{ test?: { include?: string[] } } | string>
  const vitest = projects.flatMap((p) => (typeof p === 'object' ? (p.test?.include ?? []) : []))
  const testDir = /testDir:\s*['"]([^'"]+)['"]/.exec(read('playwright.config.ts'))?.[1]
  if (vitest.length === 0 || !testDir) throw new Error('อ่าน include ของ vitest.config.ts หรือ testDir ของ playwright.config.ts ไม่ได้')
  return [...vitest, `${testDir.replace(/^\.\//, '').replace(/\/$/, '')}/**`]
}

function goldenCaseIds(yamlFiles: readonly string[]): string[] {
  const ids: string[] = []
  for (const f of yamlFiles) {
    for (const c of (parseYaml(read(`tests/golden/${f}`)) as { cases?: Array<{ id?: unknown }> }).cases ?? []) {
      if (typeof c.id === 'string') ids.push(c.id)
    }
  }
  return ids
}

// ---------- Gates ----------
const gates: Gate[] = [
  {
    name: 'env',
    run: () => {
      if (!exists('src/lib/env.ts')) return { status: 'SKIP', detail: 'ยังไม่มี src/lib/env.ts (สร้างใน S1-02)' }
      if (!exists('.env')) {
        return { status: 'FAIL', detail: 'ไม่พบไฟล์ .env', impact: 'แอปเปิดไม่ได้เพราะไม่มีค่าตั้งต้น', fix: 'cp .env.example .env แล้วเติม secret ตามคอมเมนต์ในไฟล์' }
      }
      const r = sh('pnpm exec tsx scripts/check-env.ts')
      return r.code === 0
        ? { status: 'PASS', detail: '.env ผ่าน schema' }
        : { status: 'FAIL', detail: lastLines(r.out), impact: 'แอปจะหยุดตอนเริ่มเพราะค่าใน .env ไม่ถูกต้อง', fix: 'แก้ค่าที่ระบุใน .env ให้ตรงกับ src/lib/env.ts' }
    },
  },
  {
    name: 'typecheck',
    run: () => {
      const r = sh('pnpm typecheck')
      const errors = (r.out.match(/error TS\d+/g) ?? []).length
      return r.code === 0
        ? { status: 'PASS', detail: '0 errors' }
        : { status: 'FAIL', detail: `${errors} errors\n      ${lastLines(r.out, 8)}`, impact: 'โค้ดอาจทำงานผิดชนิดข้อมูล โดยเฉพาะเงินที่ต้องเป็น BigInt', fix: 'รัน pnpm typecheck แล้วแก้ตามไฟล์และบรรทัดที่แสดง' }
    },
  },
  {
    name: 'lint',
    run: () => {
      // JSON comes from this run's stdout; a crash (exit 2) or a missing file is a FAIL, never a stale PASS
      const run = sh('pnpm exec eslint . --format json')
      const expectedFiles = ['src', 'tests'].flatMap((dir) =>
        filesUnder(dir, CODE_FILE)
          .map((f) => `${dir}/${f}`)
          .filter((f) => !LINT_IGNORED.some((p) => f.startsWith(p))),
      )
      return evaluateEslintRun(run, { root: ROOT, expectedFiles })
    },
  },
  {
    name: 'prisma',
    run: () => {
      if (!exists('prisma/schema.prisma')) return { status: 'SKIP', detail: 'ยังไม่มี prisma/schema.prisma (สร้างใน S1-03)' }
      const r = sh(`pnpm exec tsx scripts/verify-db.ts schema${STRICT ? ' --strict' : ''}`)
      return r.code === 0
        ? { status: 'PASS', detail: lastLines(r.out, 1) }
        : {
            status: 'FAIL',
            detail: problemList(r),
            impact: 'schema กับ migration ไม่ตรงกัน หรือ migration ที่ apply แล้วถูกแก้ ฐานข้อมูลจริงจะต่างจากที่โค้ดคาด',
            fix: 'สร้าง migration ใหม่ด้วย prisma migrate dev --name <ชื่อ> แล้วรัน pnpm exec tsx scripts/verify-db.ts lock (ห้ามแก้ migration ที่ apply แล้ว)',
          }
    },
  },
  {
    name: 'db',
    run: () => {
      if (!exists('prisma/migrations')) return { status: 'SKIP', detail: 'ยังไม่มี migration (สร้างใน S1-03)' }
      const r = sh(`pnpm exec tsx scripts/verify-db.ts db${STRICT ? ' --strict' : ''}`)
      return r.code === 0
        ? { status: 'PASS', detail: lastLines(r.out, 1) }
        : { status: 'FAIL', detail: problemList(r), impact: 'audit trail หรือ ledger อาจถูกแก้ย้อนหลังได้ ข้อมูลข้าม tenant ได้ หรือ DOA ที่ใช้ผิดกฎ (INV-EVT-01, INV-TEN-01, BR-DOA-08)', fix: 'ดูรายละเอียดด้านบน แล้วเพิ่ม SQL ที่ขาดใน migration ใหม่ (§6.3)' }
    },
  },
  {
    name: 'test-files',
    run: () => {
      // A *.test.* / *.spec.* file that no runner includes never runs: its tests could never fail (CLAUDE.md §9)
      const files = ['src', 'tests'].flatMap((dir) => filesUnder(dir, CODE_FILE).map((f) => `${dir}/${f}`))
      const orphans = orphanTestFiles(files, runnerPatterns())
      if (orphans.length) {
        return {
          status: 'FAIL',
          detail: `${orphans.length} ไฟล์เทสต์ไม่มี runner ใดรัน: ${orphans.slice(0, 6).join(', ')}`,
          impact: 'เทสต์ในไฟล์เหล่านี้ไม่เคยรัน จึงไม่มีวันล้ม เหมือนถูกข้าม (CLAUDE.md §9)',
          fix: 'ตั้งชื่อไฟล์ตาม include ของ vitest.config.ts (เช่น tests/unit/*.test.ts) หรือย้าย e2e ไปไว้ใน tests/e2e',
        }
      }
      const count = files.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)).length
      return { status: 'PASS', detail: `${count} ไฟล์เทสต์ ทุกไฟล์อยู่ใน include ของ vitest หรือ testDir ของ Playwright` }
    },
  },
  {
    name: 'unit',
    run: () => vitestGate('unit', ['tests/unit', 'src'], ' unit ', 'กฎในโค้ดทำงานผิดจากที่ออกแบบ').result,
  },
  {
    name: 'golden',
    run: () => {
      const yamlFiles = filesUnder('tests/golden', /^[^/]+\.yaml$/)
      if (yamlFiles.length === 0) return { status: 'SKIP', detail: 'ยังไม่มีไฟล์ golden (ไฟล์เข้าพร้อม engine ของมัน)' }
      const drift = sh(`pnpm exec tsx scripts/golden-drift.ts${STRICT ? ' --strict' : ''}`)
      if (drift.code !== 0) {
        const lines = drift.stderr.split(/\r?\n/).filter((l) => l.trim())
        return {
          status: 'FAIL',
          detail: `${lines.length} ปัญหา\n      ${(lines.length ? lines.slice(0, 8) : [lastLines(drift.out)]).join('\n      ')}`,
          impact: 'golden case ไม่ตรงกับ spec หรือขาดไฟล์ อาจมีการแก้ค่า expect เพื่อให้เทสต์ผ่าน (§17.3)',
          fix: 'คืนไฟล์ใน tests/golden ให้ตรงกับบล็อกใน spec.md คำต่อคำ และเพิ่มไฟล์ที่ขาด',
        }
      }
      const runners = filesUnder('tests/golden', /^[^/]+\.test\.tsx?$/)
      if (runners.length === 0) {
        return { status: 'FAIL', detail: `มี ${yamlFiles.length} ไฟล์ golden แต่ไม่มี runner (tests/golden/*.test.ts)`, impact: 'golden case ไม่ได้รันเลย ผลคำนวณเงินที่ผิดจะไม่ถูกจับ', fix: 'เพิ่ม runner ตาม §15.2 ที่อ่านทุกไฟล์ YAML แล้วสร้างเทสต์หนึ่งตัวต่อเคส' }
      }
      const { result } = vitestGate('golden', ['tests/golden'], ' golden ', 'ผลคำนวณเงิน งบ หรือ DOA ไม่ตรงกับ golden case')
      if (result.status !== 'PASS') return result
      // Case ids are matched to passed tests in the golden-ids gate, after integration (GC-BUD-07 runs there)
      return { status: 'PASS', detail: `${yamlFiles.length} ไฟล์ YAML · runner ${result.detail} · ${lastLines(drift.stdout, 1)}` }
    },
  },
  {
    name: 'property',
    run: () => vitestGate('property', ['tests/property'], ' property ', 'invariant ของงบหรือเงินอาจพังในบางลำดับการทำงาน').result,
  },
  {
    name: 'coverage',
    run: () => {
      // spec §7.0 item 4: every branch of the money and authority engines has a test (unit, golden or property)
      const engines = COVERAGE_ENGINES.filter((e) => exists(`src/core/${e}`))
      if (engines.length === 0) return { status: 'SKIP', detail: 'ยังไม่มี engine เงินหรืออำนาจใน src/core' }
      const files = engines.flatMap((e) => filesUnder(`src/core/${e}`, CODE_FILE).filter((f) => !TEST_FILE.test(f)).map((f) => `src/core/${e}/${f}`))
      const dir = path.join(RUN_DIR, 'coverage')
      const r = sh(
        `pnpm exec vitest run --project unit --project golden --project property --passWithNoTests --coverage.enabled --coverage.provider=v8 "--coverage.include=src/core/{${engines.join(',')}}/**" --coverage.reporter=json-summary "--coverage.reportsDirectory=${dir}"`,
      )
      const summaryFile = path.join(dir, 'coverage-summary.json')
      const summary = existsSync(summaryFile) ? (JSON.parse(readFileSync(summaryFile, 'utf8')) as CoverageSummary) : null
      return evaluateCoverage({ code: r.code, out: r.out, summary }, { root: ROOT, files: files.map((p) => ({ path: p, source: read(p) })) })
    },
  },
  {
    name: 'integration',
    run: () => {
      const a = vitestGate('int', ['tests/integration'], ' integration ', 'ธุรกรรมกับฐานข้อมูลจริงทำงานผิด').result
      const b = vitestGate('generated', ['tests/generated'], ' generated ', 'สิทธิ์ tenant หรือ state machine ผิดจากตาราง').result
      if (a.status === 'FAIL') return a
      if (b.status === 'FAIL') return b
      if (a.status === 'SKIP' && b.status === 'SKIP') return { status: 'SKIP', detail: `${a.detail} · ${b.detail}` }
      return { status: 'PASS', detail: `integration: ${a.detail} · generated: ${b.detail}` }
    },
  },
  {
    name: 'golden-ids',
    run: () => {
      const yamlFiles = filesUnder('tests/golden', /^[^/]+\.yaml$/)
      if (yamlFiles.length === 0) return { status: 'SKIP', detail: 'ยังไม่มีไฟล์ golden' }
      const caseIds = goldenCaseIds(yamlFiles)
      // Every Vitest report of this run (golden, int, generated …): GC-BUD-07 runs against real Postgres in int
      const runReports = (process.env.BCS_VITEST_REPORTS ?? '').split(',').filter(Boolean)
      const fix = 'runner ต้องสร้างเทสต์หนึ่งตัวต่อเคส และชื่อเทสต์มี id ของเคส เช่น [GC-DOA-07] (§7.0 §15.2) · เคส concurrency อยู่ใน tests/integration'
      if (!reports.has('golden')) {
        return { status: 'FAIL', detail: 'ไม่มีรายงานของด่าน golden ในรอบนี้ จึงจับคู่ id ของเคสไม่ได้', impact: 'ไม่รู้ว่า golden case ใดไม่ได้ตรวจ engine', fix: 'รัน pnpm verify (ด่าน golden-ids ต้องรันหลัง golden และ integration)' }
      }
      const missing = casesWithoutPassingTest(caseIds, runReports.map((f) => JSON.parse(readFileSync(f, 'utf8')) as VitestJson))
      if (missing.length) {
        return {
          status: 'FAIL',
          detail: `${missing.length}/${caseIds.length} เคสใน YAML ไม่มีเทสต์ที่ผ่านในรอบนี้: ${missing.slice(0, 8).join(', ')}`,
          impact: 'golden case ที่ไม่มีเทสต์ที่ผ่านไม่ได้ตรวจ engine เลย',
          fix,
        }
      }
      return { status: 'PASS', detail: `${caseIds.length} เคสจาก ${yamlFiles.length} ไฟล์มีเทสต์ที่ผ่านในรอบนี้ (รายงาน ${[...reports.keys()].join(', ')})` }
    },
  },
  {
    name: 'spec',
    run: () => {
      const r = sh('pnpm spec:check')
      // the line of the current round (spec_check prints A3 first, then A2, A to H)
      const progress = r.out.split(/\r?\n/).find((l) => l.includes('ความคืบหน้าสู่เส้นชัย A3')) ?? ''
      const summary = r.out.split(/\r?\n/).find((l) => l.startsWith('สรุป:')) ?? ''
      if (r.code === 0) return { status: 'PASS', detail: `${summary}\n      ${progress.replace(/^PASS\s+/, '')}` }
      const fails = r.out.split(/\r?\n/).filter((l) => l.startsWith('FAIL'))
      return { status: 'FAIL', detail: fails.slice(0, 6).join('\n      ') || lastLines(r.out), impact: 'spec ผิดรูปแบบ agent จะอ่าน checklist หรือกฎผิด', fix: 'แก้ spec.md ตามรายการ FAIL (ดู pnpm spec:check)' }
    },
  },
  {
    name: 'inputs',
    run: () => {
      // two workbooks: the frozen demo file, then the phase-1 file (spec §16.13 · ADR-065)
      const r = sh('pnpm inputs:check')
      const summaries = r.out.split(/\r?\n/).filter((l) => l.startsWith('สรุป:'))
      return r.code === 0
        ? { status: 'PASS', detail: summaries.join(' · ') }
        : {
            status: 'FAIL',
            detail: r.out.split(/\r?\n/).filter((l) => l.startsWith('FAIL') || l.startsWith('validate_inputs')).slice(0, 8).join('\n      ') || lastLines(r.out),
            impact: 'seed จะสร้างข้อมูลผิดจากไฟล์ input',
            fix: 'demo: docs/inputs/BCS_inputs_v1_demo.xlsx (Excel) · p1: scripts/inputs_p1/*.py then node scripts/py.mjs scripts/inputs_p1/make.py',
          }
    },
  },
  {
    name: 'messages',
    run: () => {
      if (!exists('scripts/build-messages.mjs')) return { status: 'SKIP', detail: 'ยังไม่มีตัวสร้างไฟล์ข้อความ' }
      const r = sh('node scripts/build-messages.mjs --check')
      return r.code === 0
        ? { status: 'PASS', detail: 'messages/th.json และ en.json ตรงกับต้นฉบับ และ key ไทย/อังกฤษครบคู่' }
        : { status: 'FAIL', detail: lastLines(r.out), impact: 'ผู้ใช้บางภาษาจะเห็น key แทนข้อความ (NFR-I18N-01)', fix: 'เพิ่ม key ที่ขาดใน messages/src/{th,en}/ แล้วรัน pnpm messages:build' }
    },
  },
  {
    name: 'claude-md',
    run: () => {
      const text = read('CLAUDE.md')
      const managed = text.includes('nextjs-agent-rules') || (exists('AGENTS.md') && read('AGENTS.md').includes('nextjs-agent-rules'))
      return managed
        ? { status: 'FAIL', detail: 'Next.js เขียน block agent-rules ลง CLAUDE.md หรือ AGENTS.md', impact: 'กติกาของผู้ใช้ใน CLAUDE.md ถูกแก้โดยเครื่องมือ (S1-01)', fix: 'คืน CLAUDE.md จาก git และตรวจว่า next.config.ts ตั้ง agentRules: false' }
        : { status: 'PASS', detail: 'CLAUDE.md ไม่ถูกเครื่องมือแก้ (agentRules: false)' }
    },
  },
  {
    name: 'features',
    run: () => {
      if (!exists('docs/feature-status.yaml')) return { status: 'SKIP', detail: 'ยังไม่มี docs/feature-status.yaml' }
      // Reports of this run let the checker tell a passing test from one that merely exists
      const reportArg = reports.size ? ` --reports="${[...reports.values()].join(',')}"` : ''
      const r = sh(`pnpm exec tsx scripts/check-feature-status.ts${reportArg}`)
      return r.code === 0
        ? { status: 'PASS', detail: lastLines(r.out, 1) }
        : { status: 'FAIL', detail: problemList(r), impact: 'เอกสารขายอาจอ้างความสามารถที่ยังไม่มีจริง หรือสถานะไม่ตรงกับงานที่ทำแล้ว (§0.5, ADR-016)', fix: 'แก้ docs/feature-status.yaml ตามรายการด้านบน' }
    },
  },
  {
    name: 'e2e',
    run: () => {
      if (!WITH_E2E) return { status: 'SKIP', detail: 'รันเมื่อสั่ง pnpm verify --e2e (เฉพาะก่อน merge เข้า main และที่เส้นชัย)' }
      // playwright.config.ts writes this JSON report; remove the previous run's copy so nothing reads it as this run's
      const e2eReport = path.join(ROOT, 'test-results/e2e-results.json')
      const demoDir = 'test-results/demo'
      const demoReport = path.join(ROOT, demoDir, 'e2e-results.json')
      rmSync(e2eReport, { force: true })
      rmSync(demoReport, { force: true })
      const readReport = (file: string) => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as PlaywrightJson & Record<string, unknown>) : null)
      const screens = sh('pnpm test:e2e')
      const screensReport = readReport(e2eReport)
      const screensResult = evaluatePlaywrightRun({ code: screens.code, out: screens.out, report: screensReport })
      // The demo scenes (D-04, tests/e2e/demo) run alone on their own database with the demo history, after the screens
      const scenes = existsSync(path.join(ROOT, 'tests/e2e/demo')) && readdirSync(path.join(ROOT, 'tests/e2e/demo')).some((f) => f.endsWith('.spec.ts'))
      if (!scenes) return screensResult
      const demo = sh('pnpm test:e2e', { env: { E2E_DEMO: '1', E2E_OUTPUT_DIR: demoDir } })
      const scenesReport = readReport(demoReport)
      const demoResult = evaluatePlaywrightRun({ code: demo.code, out: demo.out, report: scenesReport })
      // One report for the traceability gate: the screens' tests and the scenes' tests of this run together
      if (screensReport && scenesReport) writeFileSync(e2eReport, JSON.stringify(mergePlaywrightReports([screensReport, scenesReport])))
      if (screensResult.status === 'FAIL') return screensResult
      if (demoResult.status === 'FAIL') return { ...demoResult, detail: `ฉาก demo (pnpm test:e2e --grep @demo): ${demoResult.detail}` }
      return { status: 'PASS', detail: `หน้าจอ: ${screensResult.detail} · ฉาก demo: ${demoResult.detail}` }
    },
  },
  {
    name: 'trace',
    run: () => {
      // docs/traceability/README.md "verify ใช้ไฟล์นี้อย่างไร": every AC owned by a ticked §16 item needs a passed test
      // tagged [FR-xxx-nnn/ACn]. Runs after the integration and e2e gates: it reads this run's Vitest reports from
      // BCS_VITEST_REPORTS (set by runVitest) and test-results/e2e-results.json only when newer than every test file.
      const r = sh('pnpm exec tsx scripts/check-traceability.ts --json')
      const crashed: GateResult = {
        status: 'FAIL',
        detail: `ด่าน traceability ล้มเอง (exit ${r.code}):\n      ${lastLines(r.out, 6)}`,
        impact: 'ตรวจไม่ได้ว่าข้อที่ติ๊กแล้วมีเทสต์ที่ผ่านของทุก AC ที่เป็นเจ้าของ (docs/traceability/README.md)',
        fix: 'รัน pnpm exec tsx scripts/check-traceability.ts แล้วแก้ตามข้อความ',
      }
      try {
        const result = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? '') as GateResult
        const known = result.status === 'PASS' || result.status === 'FAIL' || result.status === 'SKIP'
        // the checker exits 1 exactly when it reports FAIL; anything else means it did not finish
        return known && (r.code === 0) === (result.status !== 'FAIL') ? result : crashed
      } catch {
        return crashed
      }
    },
  },
]

// ---------- Run ----------
const parsed = parseVerifyArgs(
  process.argv.slice(2),
  gates.map((g) => g.name),
  GATE_REQUIRES,
)
if ('error' in parsed) {
  console.log(`FAIL  args         ${parsed.error}`)
  console.log('สรุป: 1 FAIL · 0 PASS · 0 SKIP → ห้าม merge (ไม่ได้รันด่านใด)')
  process.exit(1)
}
const { strict: STRICT, e2e: WITH_E2E, only: ONLY } = parsed.args

const sha = sh('git rev-parse --short HEAD').stdout.trim() || 'no-commit'
console.log(`BCS verify — commit ${sha}${STRICT ? ' (strict)' : ''}${ONLY ? ` · เฉพาะ ${ONLY.join(', ')}` : ''}`)
const results: Array<{ name: string } & GateResult> = []
try {
  for (const gate of gates) {
    if (ONLY && !ONLY.includes(gate.name)) continue
    let result: GateResult
    try {
      result = gate.run()
    } catch (error) {
      result = { status: 'FAIL', detail: `ด่านนี้ล้มเอง: ${(error as Error).message}`, impact: 'ตรวจด่านนี้ไม่ได้', fix: 'แก้ scripts/verify.ts หรือสิ่งที่ด่านนี้อ่าน' }
    }
    if (STRICT && result.status === 'SKIP') {
      const allowed = STRICT_SKIP_ALLOWED[gate.name]
      result = allowed
        ? { ...result, detail: `${result.detail} · อนุญาตใน strict: ${allowed}` }
        : { status: 'FAIL', detail: `SKIP ไม่ได้ในโหมด strict: ${result.detail}`, impact: 'ยังตรวจไม่ครบทุกด่านที่เส้นชัยต้องการ', fix: 'ทำสิ่งที่ด่านนี้ต้องตรวจให้มีอยู่จริง' }
    }
    results.push({ name: gate.name, ...result })
    console.log(`${result.status.padEnd(5)} ${gate.name.padEnd(12)} ${result.detail}`)
    if (result.status === 'FAIL') {
      if (result.impact) console.log(`      ผลกระทบ: ${result.impact}`)
      if (result.fix) console.log(`      วิธีแก้: ${result.fix}`)
    }
  }
} finally {
  rmSync(RUN_DIR, { recursive: true, force: true })
}
const n = (s: Status) => results.filter((r) => r.status === s).length
if (results.length === 0) console.log('FAIL  args         ไม่มีด่านที่ถูกเลือก')
const failed = n('FAIL') + (results.length === 0 ? 1 : 0)
const verdict = failed ? 'ห้าม merge' : 'ผ่าน'
console.log(`สรุป: ${failed} FAIL · ${n('PASS')} PASS · ${n('SKIP')} SKIP → ${verdict}`)
process.exit(failed ? 1 : 0)
