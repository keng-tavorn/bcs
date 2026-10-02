// pnpm verify — every quality gate of spec §15.5, reported PASS/FAIL/SKIP one by one.
// A FAIL prints its real-world impact and a concrete fix, and the process exits non-zero.
// A gate may SKIP only when the thing it checks does not exist in the repo yet (never because Docker or the
// database is down). `--strict` (finish line A) turns every SKIP into FAIL except the documented allowlist.
// Flags: --strict  --e2e (run the Playwright gate)  --only=<gate,gate>
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

type Status = 'PASS' | 'FAIL' | 'SKIP'
interface GateResult {
  status: Status
  detail: string
  impact?: string
  fix?: string
}
interface Gate {
  name: string
  run: () => GateResult
}

const ROOT = path.resolve(import.meta.dirname, '..')
const args = new Set(process.argv.slice(2))
const STRICT = args.has('--strict')
const WITH_E2E = args.has('--e2e')
const ONLY = [...args].find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',')
// SKIPs that are acceptable even in --strict mode, with the reason printed
const STRICT_SKIP_ALLOWED: Record<string, string> = {}

const exists = (p: string) => existsSync(path.join(ROOT, p))
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

function sh(command: string, opts: { env?: Record<string, string> } = {}) {
  const r = spawnSync(command, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const lastLines = (text: string, n = 6) =>
  text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-n)
    .join('\n      ')

function filesUnder(dir: string, pattern: RegExp): string[] {
  const abs = path.join(ROOT, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs, { recursive: true, encoding: 'utf8' })
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => pattern.test(f))
}

// ---------- Vitest helpers ----------
interface VitestJson {
  numTotalTests: number
  numPassedTests: number
  numFailedTests: number
  numTotalTestSuites: number
  testResults: Array<{ name: string; status: string; message?: string; assertionResults: Array<{ fullName: string; status: string }> }>
}

function runVitest(project: string): { ok: boolean; report: VitestJson | null; out: string } {
  mkdirSync(path.join(ROOT, '.vitest'), { recursive: true })
  const outFile = `.vitest/${project}.json`
  const r = sh(`pnpm exec vitest run --project ${project} --reporter=json --outputFile=${outFile} --passWithNoTests`)
  const report = exists(outFile) ? (JSON.parse(read(outFile)) as VitestJson) : null
  return { ok: r.code === 0, report, out: r.out }
}

function vitestGate(project: string, dir: string, label: string, impact: string): GateResult {
  const files = filesUnder(dir, /\.test\.ts$/)
  if (files.length === 0) return { status: 'SKIP', detail: `ยังไม่มีเทสต์${label}ใน ${dir}/` }
  const { ok, report, out } = runVitest(project)
  if (!report) return { status: 'FAIL', detail: `vitest ไม่สร้างรายงาน: ${lastLines(out)}`, impact, fix: `รัน pnpm exec vitest run --project ${project} แล้วแก้ตามข้อความ` }
  const failed = report.testResults.flatMap((f) =>
    f.assertionResults.filter((a) => a.status === 'failed').map((a) => `${path.relative(ROOT, f.name)} › ${a.fullName}`),
  )
  const brokenFiles = report.testResults.filter((f) => f.status === 'failed' && f.assertionResults.length === 0)
  if (!ok || failed.length || brokenFiles.length) {
    const list = [...failed, ...brokenFiles.map((f) => `${path.relative(ROOT, f.name)}: ${(f.message ?? '').split('\n')[0]}`)]
    return {
      status: 'FAIL',
      detail: `${report.numFailedTests}/${report.numTotalTests} เคสไม่ผ่าน\n      ${list.slice(0, 8).join('\n      ')}`,
      impact,
      fix: `แก้โค้ดให้เทสต์ผ่าน (ห้ามแก้ expect ของ golden หรือข้ามเทสต์) แล้วรัน pnpm exec vitest run --project ${project}`,
    }
  }
  return { status: 'PASS', detail: `${report.testResults.length} ไฟล์ · ${report.numTotalTests} เคส` }
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
      mkdirSync(path.join(ROOT, '.vitest'), { recursive: true })
      const r = sh('pnpm exec eslint . --format json --output-file .vitest/eslint.json')
      if (!exists('.vitest/eslint.json')) return { status: 'FAIL', detail: lastLines(r.out), impact: 'ตรวจกฎโค้ดไม่ได้', fix: 'รัน pnpm lint แล้วแก้ตามข้อความ' }
      const results = JSON.parse(read('.vitest/eslint.json')) as Array<{ filePath: string; messages: Array<{ ruleId: string | null; severity: number; line: number; message: string }> }>
      const errors = results.flatMap((f) => f.messages.filter((m) => m.severity === 2).map((m) => ({ ...m, file: path.relative(ROOT, f.filePath).split(path.sep).join('/') })))
      if (errors.length === 0) return { status: 'PASS', detail: `${results.length} ไฟล์ · 0 errors (รวม boundaries, bcs/no-money-literal, bcs/no-org-code)` }
      const first = errors[0]!
      const impactByRule: Record<string, string> = {
        'bcs/no-money-literal': 'วงเงินฝังในโค้ด ถ้า DOA เปลี่ยน ระบบจะส่งไปผู้อนุมัติผิดข้อ (ขัด P-2)',
        'bcs/no-org-code': 'มีโค้ดเฉพาะลูกค้า ขายให้ลูกค้ารายอื่นไม่ได้ (ขัด NG-7)',
        'boundaries/dependencies': 'ชั้นของโค้ดปนกัน ตรรกะธุรกิจหลุดออกจาก service/core (ขัด P-1 §4.10)',
        'bcs/core-imports': 'core มี I/O หรือ dependency นอก allowlist ผลคำนวณเงินอาจไม่ deterministic (§4.10)',
      }
      return {
        status: 'FAIL',
        detail: `${errors.length} errors · ${first.file}:${first.line} ${first.ruleId}: ${first.message}`,
        impact: impactByRule[first.ruleId ?? ''] ?? 'โค้ดผิดกฎของโปรเจกต์ (§17.3)',
        fix: 'รัน pnpm lint แล้วแก้ตามไฟล์และบรรทัดที่แสดง',
      }
    },
  },
  {
    name: 'prisma',
    run: () => {
      if (!exists('prisma/schema.prisma')) return { status: 'SKIP', detail: 'ยังไม่มี prisma/schema.prisma (สร้างใน S1-03)' }
      const r = sh('pnpm exec tsx scripts/verify-db.ts schema')
      return r.code === 0
        ? { status: 'PASS', detail: lastLines(r.out, 1) }
        : { status: 'FAIL', detail: lastLines(r.out), impact: 'schema กับ migration ไม่ตรงกัน ฐานข้อมูลจริงจะต่างจากที่โค้ดคาด', fix: 'สร้าง migration ใหม่ด้วย prisma migrate dev --name <ชื่อ> (ห้ามแก้ migration ที่ apply แล้ว)' }
    },
  },
  {
    name: 'db',
    run: () => {
      if (!exists('prisma/migrations')) return { status: 'SKIP', detail: 'ยังไม่มี migration (สร้างใน S1-03)' }
      const r = sh('pnpm exec tsx scripts/verify-db.ts db')
      return r.code === 0
        ? { status: 'PASS', detail: lastLines(r.out, 1) }
        : { status: 'FAIL', detail: lastLines(r.out), impact: 'audit trail หรือ ledger อาจถูกแก้ย้อนหลังได้ หรือ DOA ที่ใช้ผิดกฎ (INV-EVT-01, BR-DOA-08)', fix: 'ดูรายละเอียดด้านบน แล้วเพิ่ม SQL ที่ขาดใน migration ใหม่ (§6.3)' }
    },
  },
  {
    name: 'unit',
    run: () => vitestGate('unit', 'tests/unit', ' unit ', 'กฎในโค้ดทำงานผิดจากที่ออกแบบ'),
  },
  {
    name: 'golden',
    run: () => {
      const yamlFiles = filesUnder('tests/golden', /^[^/]+\.yaml$/)
      if (yamlFiles.length === 0) return { status: 'SKIP', detail: 'ยังไม่มีไฟล์ golden (ไฟล์เข้าพร้อม engine ของมัน)' }
      const drift = sh('pnpm exec tsx scripts/golden-drift.ts')
      if (drift.code !== 0) {
        return { status: 'FAIL', detail: lastLines(drift.out), impact: 'golden case ไม่ตรงกับ spec อาจมีการแก้ค่า expect เพื่อให้เทสต์ผ่าน (§17.3)', fix: 'คืนไฟล์ใน tests/golden ให้ตรงกับบล็อกใน spec.md คำต่อคำ' }
      }
      let cases = 0
      for (const f of yamlFiles) cases += ((parseYaml(read(`tests/golden/${f}`)) as { cases?: unknown[] }).cases ?? []).length
      const g = vitestGate('golden', 'tests/golden', ' golden ', 'ผลคำนวณเงิน งบ หรือ DOA ไม่ตรงกับ golden case')
      if (g.status !== 'PASS') return g
      return { status: 'PASS', detail: `${yamlFiles.length} ไฟล์ · ${cases} เคส · ${g.detail} · ตรงกับ spec ทุกไบต์` }
    },
  },
  {
    name: 'property',
    run: () => vitestGate('property', 'tests/property', ' property ', 'invariant ของงบหรือเงินอาจพังในบางลำดับการทำงาน'),
  },
  {
    name: 'integration',
    run: () => {
      const a = vitestGate('int', 'tests/integration', ' integration ', 'ธุรกรรมกับฐานข้อมูลจริงทำงานผิด')
      const b = vitestGate('generated', 'tests/generated', ' generated ', 'สิทธิ์ tenant หรือ state machine ผิดจากตาราง')
      if (a.status === 'FAIL') return a
      if (b.status === 'FAIL') return b
      if (a.status === 'SKIP' && b.status === 'SKIP') return { status: 'SKIP', detail: `${a.detail} · ${b.detail}` }
      return { status: 'PASS', detail: `integration: ${a.detail} · generated: ${b.detail}` }
    },
  },
  {
    name: 'spec',
    run: () => {
      const r = sh('pnpm spec:check')
      const progress = r.out.split(/\r?\n/).find((l) => l.includes('ความคืบหน้าสู่เส้นชัย A')) ?? ''
      const summary = r.out.split(/\r?\n/).find((l) => l.startsWith('สรุป:')) ?? ''
      if (r.code === 0) return { status: 'PASS', detail: `${summary}\n      ${progress.replace(/^PASS\s+/, '')}` }
      const fails = r.out.split(/\r?\n/).filter((l) => l.startsWith('FAIL'))
      return { status: 'FAIL', detail: fails.slice(0, 6).join('\n      ') || lastLines(r.out), impact: 'spec ผิดรูปแบบ agent จะอ่าน checklist หรือกฎผิด', fix: 'แก้ spec.md ตามรายการ FAIL (ดู pnpm spec:check)' }
    },
  },
  {
    name: 'inputs',
    run: () => {
      const r = sh('pnpm inputs:check')
      const summary = r.out.split(/\r?\n/).find((l) => l.startsWith('สรุป:')) ?? ''
      return r.code === 0
        ? { status: 'PASS', detail: summary }
        : { status: 'FAIL', detail: r.out.split(/\r?\n/).filter((l) => l.startsWith('FAIL')).slice(0, 6).join('\n      '), impact: 'seed จะสร้างข้อมูล demo ผิดจากไฟล์ input', fix: 'แก้ไฟล์ docs/inputs/BCS_inputs_v1_demo.xlsx ใน Excel ตามรายการ FAIL' }
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
      const managed = text.includes('nextjs-agent-rules') || exists('AGENTS.md') && read('AGENTS.md').includes('nextjs-agent-rules')
      return managed
        ? { status: 'FAIL', detail: 'Next.js เขียน block agent-rules ลง CLAUDE.md หรือ AGENTS.md', impact: 'กติกาของผู้ใช้ใน CLAUDE.md ถูกแก้โดยเครื่องมือ (S1-01)', fix: 'คืน CLAUDE.md จาก git และตรวจว่า next.config.ts ตั้ง agentRules: false' }
        : { status: 'PASS', detail: 'CLAUDE.md ไม่ถูกเครื่องมือแก้ (agentRules: false)' }
    },
  },
  {
    name: 'features',
    run: () => {
      if (!exists('docs/feature-status.yaml')) return { status: 'SKIP', detail: 'ยังไม่มี docs/feature-status.yaml' }
      const r = sh('pnpm exec tsx scripts/check-feature-status.ts')
      return r.code === 0
        ? { status: 'PASS', detail: lastLines(r.out, 1) }
        : { status: 'FAIL', detail: lastLines(r.out), impact: 'เอกสารขายอาจอ้างความสามารถที่ยังไม่มีจริง (§0.5, ADR-016)', fix: 'แก้ docs/feature-status.yaml ตามรายการด้านบน' }
    },
  },
  {
    name: 'e2e',
    run: () => {
      if (!WITH_E2E) return { status: 'SKIP', detail: 'รันเมื่อสั่ง pnpm verify --e2e (เฉพาะก่อน merge เข้า main และที่เส้นชัย)' }
      const r = sh('pnpm test:e2e')
      return r.code === 0
        ? { status: 'PASS', detail: lastLines(r.out, 1) }
        : { status: 'FAIL', detail: lastLines(r.out, 8), impact: 'ฉาก demo ใช้งานจริงไม่ได้', fix: 'รัน pnpm test:e2e แล้วดูรายงานใน playwright-report' }
    },
  },
]

// ---------- Run ----------
const sha = sh('git rev-parse --short HEAD').out.trim() || 'no-commit'
console.log(`BCS verify — commit ${sha}${STRICT ? ' (strict)' : ''}`)
const results: Array<{ name: string } & GateResult> = []
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
const n = (s: Status) => results.filter((r) => r.status === s).length
const verdict = n('FAIL') ? 'ห้าม merge' : 'ผ่าน'
console.log(`สรุป: ${n('FAIL')} FAIL · ${n('PASS')} PASS · ${n('SKIP')} SKIP → ${verdict}`)
process.exit(n('FAIL') ? 1 : 0)
