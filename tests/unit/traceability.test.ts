// Traceability gate (spec §15.7 · docs/traceability/README.md "verify ใช้ไฟล์นี้อย่างไร"): every rule of
// scripts/lib/traceability.ts with small inline fixtures — a fake spec, a fake ac-map and fake Vitest and
// Playwright reports. Fake FRs are FR-TST-00n, so no fixture here can count as evidence for a real FR.
import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import {
  checklistFromSpec,
  e2eEvidence,
  evaluateTraceability,
  mapProblems,
  namedAcs,
  playwrightRuns,
  traceGateResult,
  traceLines,
  vitestRuns,
  type E2eReportInput,
  type PlaywrightJson,
  type TraceInput,
} from '../../scripts/lib/traceability'
import type { VitestJson } from '../../scripts/lib/verify-gates'

const SPEC = `# spec

## 8. Functional requirements

#### FR-TST-001 — แรก
ขั้น S1 · Web
- AC1 — หนึ่ง
- AC2 — สอง

#### FR-TST-002 — สอง
ขั้น S1 · S2 · Web
- AC1 — หนึ่ง
- AC2 — สอง
- AC3 — สาม

## 16. แผนงาน

- [x] **S1-01** \`[demo]\` สร้างของ — เสร็จ 2026-10-02 · abc1234
  - เสร็จเมื่อ: เทสต์ AC ของ FR-TST-001 ผ่าน
  - แยกงาน: ทำเองได้
- [ ] **S1-02** \`[demo]\` ทำต่อ
  - เสร็จเมื่อ: เทสต์ AC1–AC2 ของ FR-TST-002 ผ่าน (AC3 อยู่ใน S2-02)
  - แยกงาน: ทำเองได้
- [ ] **S2-01** \`[go-live]\` ทำทีหลัง
  - เสร็จเมื่อ: ไม่มี FR
  - แยกงาน: ทำเองได้
- [x] **S2-02** \`[go-live]\` \`[คน]\` คนยืนยัน — เสร็จ 2026-10-02 · abc1234
  - เสร็จเมื่อ: ผู้ใช้ยืนยันเอง (FR-TST-002 AC3)

\`\`\`text
- [x] **NEW-99** \`[demo]\` ตัวอย่างใน code block ไม่ใช่ข้อจริง
\`\`\`

## 17. กติกา

- [x] **S9-01** \`[demo]\` อยู่นอก §16 จึงไม่ใช่ข้อ checklist
`

type Row = [key: string, owner: string | null, demo: boolean, basis: string, note?: string]
const ROWS: Row[] = [
  ['FR-TST-001/AC1', 'S1-01', true, 'named'],
  ['FR-TST-001/AC2', 'S1-01', true, 'named'],
  ['FR-TST-002/AC1', 'S1-02', true, 'named'],
  ['FR-TST-002/AC2', 'S1-02', true, 'named'],
  ['FR-TST-002/AC3', 'S2-02', false, 'named'],
]

/** A fake ac-map.yaml whose unowned, counts and basisCounts add up unless `over` replaces them. */
function mapYaml(rows: Row[] = ROWS, over: Record<string, unknown> = {}): string {
  const frs: Record<string, { title: string; acs: Record<string, unknown> }> = {}
  for (const [key, owner, demo, basis, note] of rows) {
    const [fr, ac] = key.split('/') as [string, string]
    frs[fr] ??= { title: fr, acs: {} }
    frs[fr].acs[ac] = { owner, demo, basis, text: `ข้อความของ ${key}`, ...(note ? { note } : {}) }
  }
  const n = (f: (r: Row) => boolean) => rows.filter(f).length
  const basis = (b: string) => n((r) => r[3] === b)
  return stringify({
    version: 1,
    frs,
    unowned: rows.filter((r) => r[1] === null).map((r) => r[0]),
    counts: { frs: Object.keys(frs).length, acs: rows.length, demo: n((r) => r[2]), goLive: n((r) => !r[2]), unowned: n((r) => r[1] === null) },
    basisCounts: { named: basis('named'), later: basis('later'), builder: basis('builder'), none: basis('none') },
    ...over,
  })
}

const vitestReport = (tests: Array<[fullName: string, status: string]>, file = '/repo/tests/unit/x.test.ts'): VitestJson => ({
  numTotalTests: tests.length,
  numPassedTests: tests.filter((t) => t[1] === 'passed').length,
  numFailedTests: tests.filter((t) => t[1] === 'failed').length,
  testResults: [{ name: file, status: 'passed', assertionResults: tests.map(([fullName, status]) => ({ fullName, status })) }],
})

const T0 = Date.parse('2026-10-03T08:00:00.000Z')
const HOUR = 3_600_000

interface PwSpec {
  title: string
  status: string
  expectedStatus?: string
  describe?: string
}
const pwReport = (specs: PwSpec[], startTime: string | undefined = '2026-10-03T09:00:00.000Z'): PlaywrightJson => ({
  suites: [
    {
      title: 'x.spec.ts',
      file: 'x.spec.ts',
      specs: specs.filter((s) => !s.describe).map((s) => ({ title: s.title, file: 'x.spec.ts', tests: [{ status: s.status, expectedStatus: s.expectedStatus ?? 'passed', projectName: 'desktop' }] })),
      suites: specs
        .filter((s) => s.describe)
        .map((s) => ({ title: s.describe, file: 'x.spec.ts', specs: [{ title: s.title, file: 'x.spec.ts', tests: [{ status: s.status, expectedStatus: s.expectedStatus ?? 'passed', projectName: 'mobile' }] }] })),
    },
  ],
  stats: startTime === undefined ? {} : { startTime },
})
const freshE2e = (report: PlaywrightJson): E2eReportInput => ({ kind: 'report', path: 'test-results/e2e-results.json', report, mtimeMs: T0 + 2 * HOUR })
const MISSING: E2eReportInput = { kind: 'missing', path: 'test-results/e2e-results.json' }

const sources = (vitest: Record<string, string[]> = {}, e2e: Record<string, string[]> = {}) => ({ vitest: new Map(Object.entries(vitest)), e2e: new Map(Object.entries(e2e)) })
const BOTH_PASS = vitestReport([
  ['[FR-TST-001/AC1] makes the thing', 'passed'],
  ['[FR-TST-001/AC2] keeps the thing', 'passed'],
])
const input = (over: Partial<TraceInput> = {}): TraceInput => ({
  specText: SPEC,
  mapText: mapYaml(),
  vitest: [BOTH_PASS],
  e2e: MISSING,
  newestTest: { file: 'tests/unit/x.test.ts', mtimeMs: T0 },
  sources: sources({ 'FR-TST-001/AC1': ['tests/unit/x.test.ts'], 'FR-TST-001/AC2': ['tests/unit/x.test.ts'] }),
  root: '/repo',
  ...over,
})
const checkOf = (report: ReturnType<typeof evaluateTraceability>, key: string) => report.checks.find((c) => c.key === key)

describe('traceability: reading spec §16 and the "เสร็จเมื่อ" lines', () => {
  it('[EG-7] reads ticked state, tags and the done-when line of every §16 item, and nothing outside §16 or in code blocks', () => {
    const { items, problems } = checklistFromSpec(SPEC)
    expect(problems).toEqual([])
    expect([...items.keys()]).toEqual(['S1-01', 'S1-02', 'S2-01', 'S2-02'])
    expect(items.get('S1-01')).toEqual({ id: 'S1-01', done: true, tags: ['demo'], doneWhen: 'เทสต์ AC ของ FR-TST-001 ผ่าน' })
    expect(items.get('S2-02')).toMatchObject({ done: true, tags: ['go-live', 'คน'] })
    expect(items.get('S1-02')?.done).toBe(false)
  })
  it('[EG-7] a spec without §16 or with a duplicated item id is a problem, never an empty pass', () => {
    expect(checklistFromSpec('## 8. FR\n').problems.join('\n')).toContain('## 16.')
    const dup = SPEC.replace('**S1-02**', '**S1-01**')
    expect(checklistFromSpec(dup).problems.join('\n')).toContain('S1-01 ซ้ำ')
  })
  it('[EG-7] an FR named without AC numbers names all its ACs', () => {
    const named = namedAcs('เทสต์ AC ของ FR-TST-001 และ FR-TST-002 ผ่าน')
    expect(named.get('FR-TST-001')).toBe('all')
    expect(named.get('FR-TST-002')).toBe('all')
  })
  it('[EG-7] ACs written right after the FR id or as "ACn … ของ FR-…" limit the FR to those ACs', () => {
    const after = namedAcs('เทสต์ AC ของ FR-TST-001 FR-TST-002 และ FR-TST-003 AC1–AC2 ผ่าน (AC3 อยู่ใน NEW-07)')
    expect(after.get('FR-TST-002')).toBe('all')
    expect(after.get('FR-TST-003')).toEqual(new Set(['AC1', 'AC2']))
    const list = namedAcs('เทสต์ FR-TST-004 AC1 AC3 และ FR-TST-005 AC1 ผ่าน · FR-TST-006 AC2 ถึง AC4')
    expect(list.get('FR-TST-004')).toEqual(new Set(['AC1', 'AC3']))
    expect(list.get('FR-TST-005')).toEqual(new Set(['AC1']))
    expect(list.get('FR-TST-006')).toEqual(new Set(['AC2', 'AC3', 'AC4']))
    const before = namedAcs('เทสต์ AC1 AC2 และ AC4 ของ FR-TST-009 ผ่าน (AC3 อยู่ใน S4-14) · เทสต์ AC2–AC3 ของ FR-TST-010 ผ่าน')
    expect(before.get('FR-TST-009')).toEqual(new Set(['AC1', 'AC2', 'AC4']))
    expect(before.get('FR-TST-010')).toEqual(new Set(['AC2', 'AC3']))
  })
  it('[EG-7] FR ids are read with a boundary: NFR-SEC-09 is not an FR and module codes may contain digits', () => {
    const named = namedAcs('รวมเทสต์ว่า log ไม่มีรหัสผ่าน (NFR-SEC-09) · ไฟล์นำเข้าได้ (FR-T2T-009 AC3)')
    expect([...named.keys()]).toEqual(['FR-T2T-009'])
    expect(named.get('FR-T2T-009')).toEqual(new Set(['AC3']))
  })
})

describe('traceability rule 1: ac-map.yaml matches the spec', () => {
  const { items } = checklistFromSpec(SPEC)
  const problems = (map: string | null, spec = SPEC) => mapProblems(spec, map, checklistFromSpec(spec).items).problems.join('\n')
  it('[EG-7] a map that matches the spec has no problems', () => {
    expect(mapProblems(SPEC, mapYaml(), items).problems).toEqual([])
  })
  it('[EG-7] FRs and ACs must equal the AC bullets of §8 in the same order', () => {
    expect(problems(mapYaml(ROWS.filter((r) => !r[0].startsWith('FR-TST-001'))))).toContain('FR-TST-001 อยู่ใน spec §8 แต่ไม่มีใน ac-map.yaml')
    expect(problems(mapYaml([...ROWS, ['FR-TST-077/AC1', 'S1-01', true, 'named']]))).toContain('FR-TST-077 อยู่ใน ac-map.yaml แต่ไม่มีหัวข้อ')
    expect(problems(mapYaml([...ROWS.slice(2), ...ROWS.slice(0, 2)]))).toContain('ลำดับ FR')
    expect(problems(mapYaml(ROWS.filter((r) => r[0] !== 'FR-TST-002/AC3')))).toContain('ขาด AC3')
    expect(problems(mapYaml([...ROWS, ['FR-TST-002/AC4', 'S1-02', true, 'named']]))).toContain('มีเกิน AC4')
    expect(problems(mapYaml([ROWS[1]!, ROWS[0]!, ...ROWS.slice(2)]))).toContain('ลำดับ AC ใน ac-map (AC2 AC1)')
  })
  it('[EG-7] an AC number restated in a later ขั้น block is the same AC, counted once like ac-map.yaml', () => {
    // FR-TST-002 restates AC1 in an S5 block before AC3: the ACs are AC1 AC2 AC3, not AC1 AC2 AC1 AC3
    const spec = SPEC.replace('- AC2 — สอง\n- AC3 — สาม', '- AC2 — สอง\nขั้น S5 · LIFF\n- AC1 — หนึ่ง (ส่วน LIFF)\n- AC3 — สาม')
    expect(spec).not.toBe(SPEC)
    expect(problems(mapYaml(), spec)).toBe('')
    expect(problems(mapYaml([...ROWS.slice(0, 4), ['FR-TST-002/AC1', 'S1-02', true, 'named']]), spec)).toContain('ขาด AC3')
  })
  it('[EG-7] every owner is a §16 item or null, and null goes with basis none and the unowned list', () => {
    expect(problems(mapYaml([...ROWS.slice(0, 4), ['FR-TST-002/AC3', 'S9-01', false, 'named']]))).toContain('owner S9-01 ไม่มีใน checklist §16')
    expect(problems(mapYaml([...ROWS.slice(0, 4), ['FR-TST-002/AC3', null, false, 'later', 'รอ']]))).toContain('owner: null ต้องมี basis: none')
    expect(problems(mapYaml([...ROWS.slice(0, 4), ['FR-TST-002/AC3', 'S2-02', false, 'none']]))).toContain('basis: none ต้องมี owner: null')
    const unowned: Row[] = [...ROWS.slice(0, 4), ['FR-TST-002/AC3', null, false, 'none']]
    expect(problems(mapYaml(unowned))).toBe('')
    expect(problems(mapYaml(unowned, { unowned: [] }))).toContain('unowned ขาด FR-TST-002/AC3')
    expect(problems(mapYaml(ROWS, { unowned: ['FR-TST-001/AC1'] }))).toContain('unowned มี FR-TST-001/AC1')
  })
  it('[EG-7] demo follows the owner tag: [demo] is true, [go-live] is false', () => {
    expect(problems(mapYaml([...ROWS.slice(0, 4), ['FR-TST-002/AC3', 'S2-02', true, 'named']]))).toContain('ไม่ตรงกับแท็ก [go-live] ของ S2-02')
    expect(problems(mapYaml([['FR-TST-001/AC1', 'S1-01', false, 'named'], ...ROWS.slice(1)]))).toContain('ไม่ตรงกับแท็ก [demo] ของ S1-01')
  })
  it('[EG-7] basis named needs the owner\'s "เสร็จเมื่อ" line to name the FR or that AC', () => {
    // S1-02 names only AC1–AC2 of FR-TST-002, and S2-01 names no FR at all
    expect(problems(mapYaml([...ROWS.slice(0, 4), ['FR-TST-002/AC3', 'S1-02', true, 'named']]))).toContain('ไม่ได้ระบุ FR-TST-002 หรือ AC3')
    expect(problems(mapYaml([...ROWS.slice(0, 4), ['FR-TST-002/AC3', 'S2-01', false, 'named']]))).toContain('ของ S2-01 ไม่ได้ระบุ')
    // the same owners are fine when the basis says the owner was chosen for another reason, with a note
    expect(problems(mapYaml([...ROWS.slice(0, 4), ['FR-TST-002/AC3', 'S2-01', false, 'later', 'รอของจาก S2-01']]))).toBe('')
    expect(problems(mapYaml([...ROWS.slice(0, 4), ['FR-TST-002/AC3', 'S2-01', false, 'builder']]))).toContain('basis builder ต้องมี note')
  })
  it('[EG-7] counts and basisCounts must equal what is counted', () => {
    expect(problems(mapYaml(ROWS, { counts: { frs: 2, acs: 6, demo: 4, goLive: 1, unowned: 0 } }))).toContain('counts.acs เป็น 6 แต่นับได้ 5')
    expect(problems(mapYaml(ROWS, { counts: { frs: 2, acs: 5, demo: 5, goLive: 0, unowned: 0 } }))).toContain('counts.demo เป็น 5 แต่นับได้ 4')
    expect(problems(mapYaml(ROWS, { basisCounts: { named: 4, later: 1, builder: 0, none: 0 } }))).toContain('basisCounts.named เป็น 4 แต่นับได้ 5')
    expect(problems(mapYaml(ROWS, { counts: null }))).toContain('ไม่มี counts')
  })
  it('[EG-7] a missing or unreadable map is a problem', () => {
    expect(problems(null)).toContain('ไม่พบไฟล์')
    expect(problems('frs: [unclosed\n')).toContain('อ่าน ac-map.yaml ไม่ได้')
    expect(problems('frs:\n  FR-TST-001: {}\n  FR-TST-001: {}\n')).toContain('อ่าน ac-map.yaml ไม่ได้')
  })
})

describe('traceability rule 2: a ticked item needs a passing tagged test for every AC it owns', () => {
  it('[EG-7] passes when every AC of every ticked item has a passed test whose name carries the tag', () => {
    const report = evaluateTraceability(input())
    expect(report.status).toBe('PASS')
    expect(report.ticked).toBe(2)
    expect(report.checks.map((c) => [c.item, c.key, c.status])).toEqual([
      ['S1-01', 'FR-TST-001/AC1', 'PASS'],
      ['S1-01', 'FR-TST-001/AC2', 'PASS'],
    ])
  })
  it('[EG-7] a skipped, todo or pending test is not a passed test', () => {
    for (const status of ['skipped', 'todo', 'pending']) {
      const vitest = [vitestReport([['[FR-TST-001/AC1] makes the thing', 'passed'], ['[FR-TST-001/AC2] keeps the thing', status]])]
      const report = evaluateTraceability(input({ vitest }))
      expect(report.status).toBe('FAIL')
      expect(checkOf(report, 'FR-TST-001/AC2')).toMatchObject({ status: 'FAIL', hasTests: true, detail: expect.stringContaining(`(${status})`) })
    }
  })
  it('[EG-7] a tag that appears only in the describe() of a failed test does not count', () => {
    // Vitest fullName = describe titles + test title, so the tag is in the name but the test failed
    const vitest = [
      vitestReport([
        ['[FR-TST-001/AC1] makes the thing', 'passed'],
        ['[FR-TST-001/AC2] keeping the thing it fails to keep', 'failed'],
        ['another group passes without the tag', 'passed'],
      ]),
    ]
    expect(checkOf(evaluateTraceability(input({ vitest })), 'FR-TST-001/AC2')).toMatchObject({ status: 'FAIL' })
    // the same tag on the describe() of a passed test counts
    const passing = [vitestReport([['[FR-TST-001/AC1] makes the thing', 'passed'], ['[FR-TST-001/AC2] keeping the thing it keeps', 'passed']])]
    expect(evaluateTraceability(input({ vitest: passing })).status).toBe('PASS')
  })
  it('[EG-7] only exact [FR-xxx-nnn/ACn] tags count: not lower case, spaced, other ACs or GC ids', () => {
    for (const name of ['[fr-tst-001/ac2] x', '[FR-TST-001 / AC2] x', 'FR-TST-001/AC2 x', '[FR-TST-001/AC20] x', '[GC-TST-01] x']) {
      const vitest = [vitestReport([['[FR-TST-001/AC1] makes the thing', 'passed'], [name, 'passed']])]
      expect(checkOf(evaluateTraceability(input({ vitest })), 'FR-TST-001/AC2')?.status, name).toBe('FAIL')
    }
  })
  it('[EG-7] a missing tagged test says so, and so does a tagged test that did not run in this run', () => {
    const vitest = [vitestReport([['[FR-TST-001/AC1] makes the thing', 'passed']])]
    const missing = evaluateTraceability(input({ vitest, sources: sources({ 'FR-TST-001/AC1': ['tests/unit/x.test.ts'] }) }))
    expect(checkOf(missing, 'FR-TST-001/AC2')).toMatchObject({ status: 'FAIL', hasTests: false, detail: 'ไม่มีเทสต์ที่ชื่อมีแท็ก [FR-TST-001/AC2]' })
    const notRun = evaluateTraceability(input({ vitest, sources: sources({ 'FR-TST-001/AC2': ['tests/integration/y.test.ts'] }) }))
    expect(checkOf(notRun, 'FR-TST-001/AC2')?.detail).toContain('tests/integration/y.test.ts แต่ไม่ได้รัน')
  })
  it('[EG-7] without any Vitest report the ACs of ticked items cannot be checked: one FAIL, not a PASS', () => {
    const report = evaluateTraceability(input({ vitest: null }))
    expect(report.status).toBe('FAIL')
    expect(report.checks.every((c) => c.status === 'FAIL' && c.noReports)).toBe(true)
    // one block for the missing reports (not one per AC), then the summary line
    const fails = traceLines(report).filter((l) => l.startsWith('FAIL'))
    expect(fails).toEqual([expect.stringContaining('ไม่มีรายงานผลเทสต์ Vitest ของรอบนี้ จึงตรวจ 2 AC'), expect.stringContaining('ข้อที่ติ๊ก 2 ข้อ')])
    expect(traceGateResult(report)).toMatchObject({ status: 'FAIL', impact: expect.stringContaining('ไม่รู้ว่า'), fix: expect.stringContaining('--reports=') })
  })
  it('[EG-7] unticked items never fail and only add to the coverage count', () => {
    // S1-02 owns FR-TST-002/AC1–AC2, is not ticked and has one passing test
    const vitest = [vitestReport([['[FR-TST-001/AC1] a', 'passed'], ['[FR-TST-001/AC2] b', 'passed'], ['[FR-TST-002/AC1] c', 'passed']])]
    const report = evaluateTraceability(input({ vitest }))
    expect(report.status).toBe('PASS')
    expect(report.checks.some((c) => c.item === 'S1-02')).toBe(false)
    expect(report.unticked).toEqual({ passed: 1, total: 2 })
  })
  it('[EG-7] a ticked [คน] item is reported as checked by people, never as a FAIL', () => {
    const report = evaluateTraceability(input())
    expect(report.human).toEqual([{ item: 'S2-02', keys: ['FR-TST-002/AC3'] }])
    expect(report.checks.some((c) => c.item === 'S2-02')).toBe(false)
    expect(traceLines(report).join('\n')).toContain('ตรวจโดยคน: S2-02 (FR-TST-002/AC3)')
  })
  it('[EG-7] map problems fail the gate even when every ticked AC has a passing test', () => {
    const report = evaluateTraceability(input({ mapText: mapYaml(ROWS, { counts: { frs: 2, acs: 9, demo: 4, goLive: 1, unowned: 0 } }) }))
    expect(report.checks.every((c) => c.status === 'PASS')).toBe(true)
    expect(report.status).toBe('FAIL')
    expect(traceGateResult(report)).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('ac-map: counts.acs'), impact: expect.stringContaining('แผนที่เจ้าของ AC') })
  })
  it('[EG-7] unreadable Vitest reports are a FAIL of their own', () => {
    const report = evaluateTraceability(input({ inputProblems: ['รายงาน Vitest .vitest/unit.json: Unexpected end of JSON input'] }))
    expect(report.status).toBe('FAIL')
    expect(traceLines(report)[0]).toMatch(/^FAIL {2}trace {8}อ่านผลเทสต์ไม่ได้ 1 รายการ$/)
  })
})

describe('traceability: e2e results', () => {
  // FR-TST-001/AC2 is tested only in tests/e2e/x.spec.ts
  const e2eOnly = (over: Partial<TraceInput> = {}) =>
    evaluateTraceability(
      input({
        vitest: [vitestReport([['[FR-TST-001/AC1] makes the thing', 'passed']])],
        sources: sources({ 'FR-TST-001/AC1': ['tests/unit/x.test.ts'] }, { 'FR-TST-001/AC2': ['tests/e2e/x.spec.ts'] }),
        ...over,
      }),
    )
  const passedInE2e = pwReport([{ title: '[FR-TST-001/AC2] keeps the thing on screen', status: 'expected' }])

  it('[EG-7] an e2e-only AC whose report is missing is a SKIP with the reason, never a PASS', () => {
    const report = e2eOnly()
    expect(checkOf(report, 'FR-TST-001/AC2')).toMatchObject({ status: 'SKIP', detail: expect.stringContaining('ไม่มีผล e2e (test-results/e2e-results.json)') })
    expect(report.status).toBe('SKIP')
    expect(traceGateResult(report).status).toBe('SKIP')
    expect(traceLines(report).join('\n')).toContain('pnpm verify --e2e')
  })
  it('[EG-7] a stale e2e report (older than the newest test file) is not used, even when the test passed in it', () => {
    // the run started at 07:00 and the newest test file was saved at 08:00
    const stale = e2eOnly({ e2e: freshE2e(pwReport([{ title: '[FR-TST-001/AC2] keeps the thing on screen', status: 'expected' }], '2026-10-03T07:00:00.000Z')) })
    expect(checkOf(stale, 'FR-TST-001/AC2')).toMatchObject({ status: 'SKIP', detail: expect.stringContaining('เก่ากว่าไฟล์เทสต์ tests/unit/x.test.ts') })
    // without a start time the file time decides
    const noStart: E2eReportInput = { kind: 'report', path: 'r.json', report: pwReport([], undefined), mtimeMs: T0 - HOUR }
    expect(e2eEvidence(noStart, { file: 'tests/e2e/x.spec.ts', mtimeMs: T0 })).toMatchObject({ usable: false })
    // a test edited while the run was going makes the report stale too (the run started before the edit)
    const during: E2eReportInput = { kind: 'report', path: 'r.json', report: pwReport([], '2026-10-03T07:30:00.000Z'), mtimeMs: T0 + HOUR }
    expect(e2eEvidence(during, { file: 'tests/e2e/x.spec.ts', mtimeMs: T0 })).toMatchObject({ usable: false })
  })
  it('[EG-7] a fresh e2e report with a passed test passes the e2e-only AC', () => {
    const report = e2eOnly({ e2e: freshE2e(passedInE2e) })
    expect(checkOf(report, 'FR-TST-001/AC2')).toMatchObject({ status: 'PASS', detail: expect.stringContaining('(e2e)') })
    expect(report.status).toBe('PASS')
  })
  it('[EG-7] in a fresh e2e report a failed, skipped, expected-to-fail or flaky test is not a pass', () => {
    for (const [status, expectedStatus] of [
      ['unexpected', 'passed'],
      ['skipped', 'skipped'],
      ['expected', 'failed'],
      ['flaky', 'passed'],
    ] as const) {
      const report = e2eOnly({ e2e: freshE2e(pwReport([{ title: '[FR-TST-001/AC2] keeps the thing on screen', status, expectedStatus }])) })
      expect(checkOf(report, 'FR-TST-001/AC2')?.status, `${status}/${expectedStatus}`).toBe('FAIL')
    }
  })
  it('[EG-7] in e2e too, a tag only in the describe() of a failed test does not count', () => {
    const report = e2eOnly({ e2e: freshE2e(pwReport([{ describe: '[FR-TST-001/AC2] the thing on screen', title: 'stays after reload', status: 'unexpected' }])) })
    expect(checkOf(report, 'FR-TST-001/AC2')).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('[FR-TST-001/AC2] the thing on screen › stays after reload (failed · mobile)') })
    const passing = e2eOnly({ e2e: freshE2e(pwReport([{ describe: '[FR-TST-001/AC2] the thing on screen', title: 'stays after reload', status: 'expected' }])) })
    expect(checkOf(passing, 'FR-TST-001/AC2')?.status).toBe('PASS')
  })
  it('[EG-7] an e2e-only AC missing from a fresh report, or an unreadable report, is a SKIP', () => {
    const notInReport = e2eOnly({ e2e: freshE2e(pwReport([{ title: '[FR-TST-001/AC1] other', status: 'expected' }])) })
    expect(checkOf(notInReport, 'FR-TST-001/AC2')).toMatchObject({ status: 'SKIP', detail: expect.stringContaining('ไม่อยู่ในผล e2e ล่าสุด') })
    const unreadable = e2eOnly({ e2e: { kind: 'unreadable', path: 'test-results/e2e-results.json', error: 'Unexpected token' } })
    expect(checkOf(unreadable, 'FR-TST-001/AC2')).toMatchObject({ status: 'SKIP', detail: expect.stringContaining('อ่านผล e2e') })
  })
  it('[EG-7] an AC that also has a Vitest test is not e2e-only: a failed Vitest test without e2e results is a FAIL', () => {
    const report = e2eOnly({
      vitest: [vitestReport([['[FR-TST-001/AC1] makes the thing', 'passed'], ['[FR-TST-001/AC2] keeps the thing', 'failed']])],
      sources: sources({ 'FR-TST-001/AC1': ['tests/unit/x.test.ts'], 'FR-TST-001/AC2': ['tests/unit/x.test.ts'] }, { 'FR-TST-001/AC2': ['tests/e2e/x.spec.ts'] }),
    })
    expect(checkOf(report, 'FR-TST-001/AC2')?.status).toBe('FAIL')
  })
  it('[EG-7] Playwright names are the describe titles and the test title; every project run is its own test', () => {
    const runs = playwrightRuns(pwReport([{ title: 'a', status: 'expected' }, { describe: '[FR-TST-001/AC2] group', title: 'b', status: 'skipped', expectedStatus: 'skipped' }]))
    expect(runs.map((r) => [r.name, r.passed, r.keys])).toEqual([
      ['a', true, []],
      ['[FR-TST-001/AC2] group › b', false, ['FR-TST-001/AC2']],
    ])
    expect(vitestRuns([BOTH_PASS], '/repo').map((r) => r.file)).toEqual(['tests/unit/x.test.ts', 'tests/unit/x.test.ts'])
  })
})

describe('traceability rule 3 and the report', () => {
  it('[EG-7] unowned ACs are reported without failing', () => {
    const rows: Row[] = [...ROWS.slice(0, 4), ['FR-TST-002/AC3', null, false, 'none']]
    const report = evaluateTraceability(input({ mapText: mapYaml(rows) }))
    expect(report.status).toBe('PASS')
    expect(report.unowned).toEqual(['FR-TST-002/AC3'])
    const gate = traceGateResult(report)
    expect(gate.status).toBe('PASS')
    expect(gate.detail).toContain('ยังไม่มีเจ้าของ (เพิ่มเป็นข้อ NEW ใน §16.11): FR-TST-002/AC3')
  })
  it('[EG-7] a FAIL prints the item, the AC, its impact and the fix in the format of the other gates', () => {
    const vitest = [vitestReport([['[FR-TST-001/AC1] makes the thing', 'passed']])]
    const report = evaluateTraceability(input({ vitest, sources: sources({ 'FR-TST-001/AC1': ['tests/unit/x.test.ts'] }) }))
    const lines = traceLines(report)
    expect(lines.slice(0, 4)).toEqual([
      'FAIL  trace        S1-01 ติ๊กแล้วแต่ไม่มีเทสต์ที่ผ่านของ FR-TST-001/AC2',
      '      ไม่มีเทสต์ที่ชื่อมีแท็ก [FR-TST-001/AC2]',
      '      ผลกระทบ: S1-01 ติ๊กโดยไม่มีหลักฐานว่า AC นี้ทำงาน: "ข้อความของ FR-TST-001/AC2"',
      '      วิธีแก้: เขียนเทสต์ที่ชื่อมีแท็ก [FR-TST-001/AC2] และผ่านจริง หรือเอาติ๊กของ S1-01 ออก',
    ])
    expect(lines.find((l) => /^(PASS|FAIL|SKIP) /.test(l) && l.includes('ข้อที่ติ๊ก'))).toMatch(/^FAIL {2}trace {8}ข้อที่ติ๊ก 2 ข้อ · AC ที่ต้องมีเทสต์ 1\/2 /)
    const gate = traceGateResult(report)
    expect(gate).toMatchObject({ status: 'FAIL', impact: expect.stringContaining('ข้อความของ FR-TST-001/AC2'), fix: expect.stringContaining('เอาติ๊กของ S1-01 ออก') })
    expect(gate.detail).toContain('S1-01 FR-TST-001/AC2: ไม่มีเทสต์ที่ชื่อมีแท็ก')
  })
  it('[EG-7] a PASS summary counts ticked items, owned ACs with a passing test and unowned ACs', () => {
    expect(traceGateResult(evaluateTraceability(input())).detail).toMatch(/^ข้อที่ติ๊ก 2 ข้อ · AC ที่ต้องมีเทสต์ 2\/2 · ตรวจโดยคน 1 ข้อ \(1 AC\) · ยังไม่มีเจ้าของ 0 /)
  })
})
