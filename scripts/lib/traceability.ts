// Traceability gate (spec §15.7 · docs/traceability/README.md "verify ใช้ไฟล์นี้อย่างไร"): docs/traceability/ac-map.yaml
// names one §16 checklist item as the owner of every AC of a tier-1 FR. Free of I/O so every rule has unit tests
// (tests/unit/traceability.test.ts); scripts/check-traceability.ts loads the files and prints the result.
//   1. the map matches the spec: the FRs and ACs of §8 in the same order, owners are §16 items, demo follows the
//      owner's tag, basis "named" is backed by the owner's "เสร็จเมื่อ" line, unowned/counts/basisCounts add up
//   2. every AC owned by a ticked item has a PASSED test whose full name carries [FR-xxx-nnn/ACn]: Vitest reports
//      of this run, plus the Playwright report only when it is newer than every test file. An AC tested only in
//      e2e whose result is not available is a SKIP, never a PASS. Items tagged [คน] are "ตรวจโดยคน", never FAIL.
//   3. unowned ACs and the coverage of unticked items are reported without failing.
// AC numbering: the ACs of an FR are its distinct `- ACn —` bullets in order of first appearance. A number that
// appears again under the same FR (a later "ขั้น" block restating it) is the same AC with the same tag and owner,
// which is how ac-map.yaml counts them: each AC is one YAML key, and YAML keys are unique.
import path from 'node:path'
import { parse } from 'yaml'
import { acTags, frsFromSpec, isTier1 } from './feature-status'
import type { GateResult, Status, VitestJson } from './verify-gates'

export const BASES = ['named', 'later', 'builder', 'none'] as const
export type Basis = (typeof BASES)[number]

// ---------- §16 checklist ----------
export interface ChecklistItem {
  id: string
  done: boolean
  /** `[demo]` `[go-live]` `[คน]` written on the item line, without brackets */
  tags: string[]
  /** text of the "เสร็จเมื่อ:" sub-line */
  doneWhen: string
}

// Same item pattern as scripts/spec_check.py, so both tools agree on which items exist and which are ticked
const ITEM = /^- \[([ x])\] \*\*((?:S\d{1,2}|P0|P1|D)-\d{2}|NEW-\d{2,3})\*\*(.*)$/
const TAG = /`\[(demo|go-live|คน)\]`/g

/** Checklist items of spec §16 (code blocks skipped, so the NEW-nn template is not an item). */
export function checklistFromSpec(specText: string): { items: Map<string, ChecklistItem>; problems: string[] } {
  const lines = specText.split(/\r?\n/)
  const items = new Map<string, ChecklistItem>()
  const problems: string[] = []
  let inCode = false
  let section = false
  let found = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim().startsWith('```')) {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    if (/^## /.test(line)) {
      section = /^## 16\.\s/.test(line)
      found ||= section
      continue
    }
    if (!section) continue
    const m = ITEM.exec(line)
    if (!m) continue
    const subs: string[] = []
    for (let j = i + 1; j < lines.length && lines[j]!.startsWith('  - '); j++) subs.push(lines[j]!.trim().slice(2))
    const id = m[2]!
    if (items.has(id)) problems.push(`รหัสข้อ ${id} ซ้ำใน §16 จึงบอกไม่ได้ว่าข้อไหนเป็นเจ้าของ`)
    items.set(id, {
      id,
      done: m[1] === 'x',
      tags: [...m[3]!.matchAll(TAG)].map((t) => t[1]!),
      doneWhen: subs
        .filter((s) => s.startsWith('เสร็จเมื่อ:'))
        .map((s) => s.slice('เสร็จเมื่อ:'.length).trim())
        .join(' · '),
    })
  }
  if (!found) problems.push('ไม่พบหัวข้อ "## 16." ใน spec.md จึงไม่รู้ว่าข้อใดใน checklist มีอยู่และติ๊กแล้ว')
  else if (items.size === 0) problems.push('§16 ไม่มีข้อ checklist ในรูป "- [ ] **S1-01** …"')
  return { items, problems }
}

// ---------- "เสร็จเมื่อ" names which ACs ----------
// FR ids with a boundary: "NFR-SEC-09" is not FR-SEC-09, and module codes may hold digits (FR-P2P-001)
const FR_ID = /(?<![A-Za-z0-9])FR-[A-Z][A-Z0-9]*-\d{3}(?![0-9])/g
const AC_ONE = String.raw`AC\d+(?:\s*(?:–|-|ถึง)\s*AC\d+)?`
const AC_LIST = String.raw`${AC_ONE}(?:(?:\s*,\s*|\s+และ\s+|\s+)${AC_ONE})*`
// "FR-DOA-001 AC2–AC3" · "FR-VIS-002 AC1 AC3": ACs right after the FR id
const AFTER_FR = new RegExp(String.raw`^\s+(${AC_LIST})(?![A-Za-z0-9])`)
// "AC1 AC2 และ AC4 ของ FR-P2P-009": ACs right before "ของ <FR id>"
const BEFORE_FR = new RegExp(String.raw`(?<![A-Za-z0-9])(${AC_LIST})\s+ของ\s+$`)

function expandAcs(list: string): string[] {
  const out: string[] = []
  for (const m of list.matchAll(/AC(\d+)(?:\s*(?:–|-|ถึง)\s*AC(\d+))?/g)) {
    const from = Number(m[1])
    const to = m[2] === undefined ? from : Number(m[2])
    if (to >= from && to - from <= 50) for (let n = from; n <= to; n++) out.push(`AC${n}`)
    else out.push(`AC${from}`, `AC${to}`)
  }
  return out
}

/** FR id → the ACs a "เสร็จเมื่อ" line names, or 'all' when it names the FR without AC numbers. */
export function namedAcs(doneWhen: string): Map<string, Set<string> | 'all'> {
  const named = new Map<string, Set<string> | 'all'>()
  for (const m of doneWhen.matchAll(FR_ID)) {
    const fr = m[0]
    const start = m.index
    const after = AFTER_FR.exec(doneWhen.slice(start + fr.length))
    const before = BEFORE_FR.exec(doneWhen.slice(0, start))
    const acs = [...(after ? expandAcs(after[1]!) : []), ...(before ? expandAcs(before[1]!) : [])]
    const prev = named.get(fr)
    if (acs.length === 0 || prev === 'all') named.set(fr, 'all')
    else named.set(fr, new Set([...(prev ?? []), ...acs]))
  }
  return named
}

// ---------- ac-map.yaml against the spec ----------
export interface AcRow {
  fr: string
  ac: string
  /** `FR-PLT-001/AC1`, the key inside a test tag */
  key: string
  /** a §16 item id, or null when no item owns the AC (only rows whose owner is valid are kept) */
  owner: string | null
  demo: boolean | null
  basis: string | null
  text: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Rule 1: problems of the map (each one a FAIL), plus the rows of every AC whose owner is usable. */
export function mapProblems(specText: string, mapText: string | null, items: Map<string, ChecklistItem>): { problems: string[]; rows: AcRow[] } {
  const problems: string[] = []
  if (mapText === null) return { problems: ['ไม่พบไฟล์ docs/traceability/ac-map.yaml (ลบหรือย้ายไฟล์นี้ไม่ได้ ด่านนี้ต้องใช้)'], rows: [] }
  let doc: unknown
  try {
    doc = parse(mapText)
  } catch (error) {
    return { problems: [`อ่าน ac-map.yaml ไม่ได้: ${(error as Error).message.split('\n')[0]}`], rows: [] }
  }
  if (!isRecord(doc) || !isRecord(doc.frs)) return { problems: ['ac-map.yaml ไม่มี frs ในรูป FR-xxx-nnn → acs'], rows: [] }

  // FRs and ACs of §8, each AC once in order of first appearance (see the note at the top of this file)
  const specFrs = new Map([...frsFromSpec(specText)].filter(([id]) => isTier1(id)).map(([id, fr]) => [id, [...new Set(fr.acs)]]))
  const mapFrs = Object.keys(doc.frs)
  for (const id of specFrs.keys()) if (!(id in doc.frs)) problems.push(`${id} อยู่ใน spec §8 แต่ไม่มีใน ac-map.yaml`)
  for (const id of mapFrs) if (!specFrs.has(id)) problems.push(`${id} อยู่ใน ac-map.yaml แต่ไม่มีหัวข้อ FR ชั้น 1 นี้ใน spec §8`)
  const specOrder = [...specFrs.keys()].filter((id) => mapFrs.includes(id))
  const mapOrder = mapFrs.filter((id) => specFrs.has(id))
  const at = specOrder.findIndex((id, i) => mapOrder[i] !== id)
  if (at >= 0) problems.push(`ลำดับ FR ใน ac-map.yaml ไม่ตรงกับ spec §8: ลำดับที่ ${at + 1} ac-map มี ${mapOrder[at]} แต่ spec มี ${specOrder[at]}`)

  const rows: AcRow[] = []
  const counted = { frs: 0, acs: 0, demo: 0, goLive: 0, unowned: 0 }
  const basisCounted: Record<Basis, number> = { named: 0, later: 0, builder: 0, none: 0 }
  const ownerless: string[] = []
  const namedCache = new Map<string, Map<string, Set<string> | 'all'>>()
  for (const [fr, entry] of Object.entries(doc.frs)) {
    counted.frs++
    if (!isRecord(entry) || !isRecord(entry.acs)) {
      problems.push(`${fr}: ไม่มี acs`)
      continue
    }
    const acs = Object.keys(entry.acs)
    const specAcs = specFrs.get(fr)
    if (specAcs) {
      const missing = specAcs.filter((ac) => !acs.includes(ac))
      const extra = acs.filter((ac) => !specAcs.includes(ac))
      if (missing.length || extra.length) {
        const parts = [missing.length ? `ขาด ${missing.join(' ')}` : '', extra.length ? `มีเกิน ${extra.join(' ')}` : ''].filter(Boolean)
        problems.push(`${fr}: AC ใน ac-map ${parts.join(' · ')} (spec §8 มี ${specAcs.join(' ') || 'ไม่มี AC'})`)
      } else if (acs.length !== specAcs.length || acs.some((ac, i) => specAcs[i] !== ac)) {
        problems.push(`${fr}: ลำดับ AC ใน ac-map (${acs.join(' ')}) ไม่ตรงกับ spec §8 (${specAcs.join(' ')})`)
      }
    }
    for (const [ac, raw] of Object.entries(entry.acs)) {
      counted.acs++
      const key = `${fr}/${ac}`
      if (!isRecord(raw)) {
        problems.push(`${key}: ต้องเป็น { owner, demo, basis, text }`)
        continue
      }
      const { owner, demo, basis, note } = raw
      if (demo === true) counted.demo++
      else if (demo === false) counted.goLive++
      else problems.push(`${key}: demo ต้องเป็น true หรือ false`)
      if (typeof basis === 'string' && (BASES as readonly string[]).includes(basis)) basisCounted[basis as Basis]++
      else problems.push(`${key}: basis ต้องเป็น named later builder หรือ none (ได้ ${JSON.stringify(basis ?? null)})`)
      if ((basis === 'later' || basis === 'builder') && !(typeof note === 'string' && note.trim())) problems.push(`${key}: basis ${basis} ต้องมี note บอกเหตุผล`)

      let row: AcRow | null = null
      const text = typeof raw.text === 'string' ? raw.text : ''
      if (owner === null) {
        counted.unowned++
        ownerless.push(key)
        if (basis !== 'none') problems.push(`${key}: owner: null ต้องมี basis: none`)
        row = { fr, ac, key, owner: null, demo: typeof demo === 'boolean' ? demo : null, basis: typeof basis === 'string' ? basis : null, text }
      } else if (typeof owner !== 'string') {
        problems.push(`${key}: owner ต้องเป็นรหัสข้อใน §16 หรือ null (ได้ ${JSON.stringify(owner ?? null)})`)
      } else if (!items.has(owner)) {
        problems.push(`${key}: owner ${owner} ไม่มีใน checklist §16`)
      } else {
        const item = items.get(owner)!
        if (basis === 'none') problems.push(`${key}: basis: none ต้องมี owner: null`)
        // README rule 3 before rule 4: [go-live] → demo false, otherwise [demo] → demo true
        const expected = item.tags.includes('go-live') ? false : item.tags.includes('demo') ? true : null
        if (expected === null) problems.push(`${key}: เจ้าของ ${owner} ไม่มีแท็ก [demo] หรือ [go-live]`)
        else if (typeof demo === 'boolean' && demo !== expected) {
          problems.push(`${key}: demo: ${demo} ไม่ตรงกับแท็ก [${expected ? 'demo' : 'go-live'}] ของ ${owner} (ต้องเป็น ${expected})`)
        }
        if (basis === 'named') {
          if (!namedCache.has(owner)) namedCache.set(owner, namedAcs(item.doneWhen))
          const named = namedCache.get(owner)!.get(fr)
          if (named !== 'all' && !named?.has(ac)) problems.push(`${key}: basis named แต่บรรทัด "เสร็จเมื่อ" ของ ${owner} ไม่ได้ระบุ ${fr} หรือ ${ac} ของ FR นี้`)
        }
        row = { fr, ac, key, owner, demo: typeof demo === 'boolean' ? demo : null, basis: typeof basis === 'string' ? basis : null, text }
      }
      if (row) rows.push(row)
    }
  }

  // unowned lists exactly the ACs with owner: null
  const unowned = doc.unowned
  if (!Array.isArray(unowned) || unowned.some((k) => typeof k !== 'string')) problems.push('unowned ต้องเป็นรายการ "FR-xxx-nnn/ACn" (ว่างได้ [])')
  else {
    const seen = new Set<string>()
    for (const k of unowned as string[]) {
      if (seen.has(k)) problems.push(`unowned มี ${k} ซ้ำ`)
      seen.add(k)
      if (!ownerless.includes(k)) problems.push(`unowned มี ${k} แต่ใน frs ไม่ใช่ AC ที่ owner: null`)
    }
    for (const k of ownerless) if (!seen.has(k)) problems.push(`unowned ขาด ${k} ซึ่ง owner: null`)
  }
  for (const [field, expected] of [
    ['counts', counted],
    ['basisCounts', basisCounted],
  ] as const) {
    const got = doc[field]
    if (!isRecord(got)) {
      problems.push(`ไม่มี ${field} ใน ac-map.yaml`)
      continue
    }
    for (const [k, n] of Object.entries(expected)) if (got[k] !== n) problems.push(`${field}.${k} เป็น ${JSON.stringify(got[k] ?? null)} แต่นับได้ ${n}`)
  }
  return { problems, rows }
}

// ---------- Test results ----------
export interface TestRun {
  /** full name: describe titles + test title (Vitest fullName · Playwright describe › title) */
  name: string
  file: string
  status: string
  passed: boolean
  keys: string[]
}

const rel = (root: string, file: string) => (root && path.isAbsolute(file) ? path.relative(root, file) : file).split(path.sep).join('/')

/** Every test of this run's Vitest reports. Only `passed` counts: skipped, todo, pending and failed do not. */
export function vitestRuns(reports: readonly VitestJson[], root = ''): TestRun[] {
  return reports.flatMap((report) =>
    (report.testResults ?? []).flatMap((f) =>
      (f.assertionResults ?? []).map((a) => ({ name: a.fullName, file: rel(root, f.name), status: a.status, passed: a.status === 'passed', keys: acTags(a.fullName) })),
    ),
  )
}

export interface PlaywrightTest {
  status?: string
  expectedStatus?: string
  projectName?: string
}
export interface PlaywrightSpec {
  title?: string
  file?: string
  tests?: PlaywrightTest[]
}
export interface PlaywrightSuite {
  title?: string
  file?: string
  specs?: PlaywrightSpec[]
  suites?: PlaywrightSuite[]
}
export interface PlaywrightJson {
  suites?: PlaywrightSuite[]
  stats?: { startTime?: string }
}

/**
 * One run per test and project of a Playwright JSON report. Passed means it ran and passed as expected: not
 * skipped, not failed, not "expected to fail" (test.fail) and not flaky.
 */
export function playwrightRuns(report: PlaywrightJson): TestRun[] {
  const runs: TestRun[] = []
  // `titles` are the describe() titles above a test; the top-level suite of each file is titled with the file name
  const walk = (suite: PlaywrightSuite, titles: string[]) => {
    for (const spec of suite.specs ?? []) {
      const name = [...titles, spec.title ?? ''].join(' › ')
      for (const t of spec.tests ?? []) {
        const passed = t.status === 'expected' && t.expectedStatus === 'passed'
        const status = passed ? 'passed' : t.status === 'unexpected' ? 'failed' : t.status === 'expected' ? `expected ${t.expectedStatus}` : (t.status ?? 'unknown')
        runs.push({ name, file: `tests/e2e/${spec.file ?? suite.file ?? ''}`, status: t.projectName ? `${status} · ${t.projectName}` : status, passed, keys: acTags(name) })
      }
    }
    for (const child of suite.suites ?? []) walk(child, child.title ? [...titles, child.title] : titles)
  }
  for (const suite of report.suites ?? []) walk(suite, [])
  return runs
}

export type E2eReportInput =
  | { kind: 'missing'; path: string }
  | { kind: 'unreadable'; path: string; error: string }
  | { kind: 'report'; path: string; report: PlaywrightJson; mtimeMs: number }

export interface NewestTest {
  file: string
  mtimeMs: number
}

export type E2eEvidence = { usable: true; runs: TestRun[]; note: string } | { usable: false; reason: string; note: string }

const stamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16)

/**
 * The Playwright report counts only when it exists and is newer than the newest test file. Its age is the run's
 * start (stats.startTime) when given, so a test edited while the run was going makes it stale.
 */
export function e2eEvidence(input: E2eReportInput, newestTest: NewestTest | null): E2eEvidence {
  if (input.kind === 'missing') return { usable: false, reason: `ไม่มีผล e2e (${input.path})`, note: 'ไม่มีผล e2e' }
  if (input.kind === 'unreadable') return { usable: false, reason: `อ่านผล e2e ${input.path} ไม่ได้: ${input.error}`, note: 'ผล e2e อ่านไม่ได้' }
  const started = Date.parse(input.report.stats?.startTime ?? '')
  const at = Number.isNaN(started) ? input.mtimeMs : Math.min(started, input.mtimeMs)
  if (newestTest && newestTest.mtimeMs > at) {
    return {
      usable: false,
      reason: `ผล e2e ใน ${input.path} (รันเมื่อ ${stamp(at)} UTC) เก่ากว่าไฟล์เทสต์ ${newestTest.file} ที่แก้เมื่อ ${stamp(newestTest.mtimeMs)} UTC`,
      note: 'ผล e2e เก่ากว่าไฟล์เทสต์',
    }
  }
  return { usable: true, runs: playwrightRuns(input.report), note: `ใช้ผล e2e ที่รันเมื่อ ${stamp(at)} UTC` }
}

// ---------- The gate ----------
export interface TraceInput {
  specText: string
  /** docs/traceability/ac-map.yaml, null when the file does not exist */
  mapText: string | null
  /** this run's Vitest reports (BCS_VITEST_REPORTS or --reports=); null when none were given */
  vitest: VitestJson[] | null
  e2e: E2eReportInput
  /** newest file of test code, for the age of the Playwright report */
  newestTest: NewestTest | null
  /** AC keys in test titles of the test sources (static scan): key → files, split by runner */
  sources: { vitest: Map<string, string[]>; e2e: Map<string, string[]> }
  /** problems found while loading the inputs (an unreadable report …), each one a FAIL */
  inputProblems?: string[]
  root?: string
}

export interface AcCheck {
  item: string
  key: string
  text: string
  status: Status
  /** the passing test, or why there is none */
  detail: string
  /** FAIL only because no Vitest report was given */
  noReports: boolean
  /** some test (a report entry or a test file) carries the tag; false means one has to be written */
  hasTests: boolean
}

export interface TraceReport {
  status: Status
  inputProblems: string[]
  specProblems: string[]
  mapProblems: string[]
  ticked: number
  checks: AcCheck[]
  human: Array<{ item: string; keys: string[] }>
  unowned: string[]
  unticked: { passed: number; total: number }
  e2eNote: string
}

const MAX_LISTED = 3
const listRuns = (runs: TestRun[]) =>
  runs
    .slice(0, MAX_LISTED)
    .map((r) => `${r.file} › ${r.name} (${r.status})`)
    .join(' · ') + (runs.length > MAX_LISTED ? ` · และอีก ${runs.length - MAX_LISTED}` : '')

export function evaluateTraceability(input: TraceInput): TraceReport {
  const { items, problems: specProblems } = checklistFromSpec(input.specText)
  const { problems: mapIssues, rows } = mapProblems(input.specText, input.mapText, items)
  const vRuns = vitestRuns(input.vitest ?? [], input.root)
  const e2e = e2eEvidence(input.e2e, input.newestTest)
  const eRuns = e2e.usable ? e2e.runs : []
  const withKey = (runs: TestRun[], key: string) => runs.filter((r) => r.keys.includes(key))

  const check = (item: string, row: AcRow): AcCheck => {
    const base = { item, key: row.key, text: row.text, noReports: false, hasTests: true }
    const vitest = withKey(vRuns, row.key)
    const e2eRuns = withKey(eRuns, row.key)
    const vPass = vitest.find((r) => r.passed)
    if (vPass) return { ...base, status: 'PASS', detail: `${vPass.file} › ${vPass.name}` }
    const ePass = e2eRuns.find((r) => r.passed)
    if (ePass) return { ...base, status: 'PASS', detail: `${ePass.file} › ${ePass.name} (e2e)` }
    const vitestFiles = input.sources.vitest.get(row.key) ?? []
    const e2eFiles = input.sources.e2e.get(row.key) ?? []
    // e2e-only: the tag is in e2e tests and in no Vitest test, so only the Playwright report can show it passing
    if ((e2eFiles.length || e2eRuns.length) && !vitestFiles.length && !vitest.length) {
      if (!e2e.usable) return { ...base, status: 'SKIP', detail: `มีแต่เทสต์ e2e (${e2eFiles.join(', ')}) และ${e2e.reason}` }
      if (!e2eRuns.length) return { ...base, status: 'SKIP', detail: `มีแต่เทสต์ e2e (${e2eFiles.join(', ')}) ซึ่งไม่อยู่ในผล e2e ล่าสุด` }
      return { ...base, status: 'FAIL', detail: `เทสต์ที่มีแท็กแต่ไม่ผ่าน: ${listRuns(e2eRuns)}` }
    }
    const notPassed = [...vitest, ...e2eRuns]
    if (notPassed.length) return { ...base, status: 'FAIL', detail: `เทสต์ที่มีแท็กแต่ไม่ผ่าน: ${listRuns(notPassed)}` }
    if (vitestFiles.length && input.vitest === null) return { ...base, status: 'FAIL', noReports: true, detail: `ไม่มีรายงาน Vitest ของรอบนี้ (เทสต์อยู่ใน ${vitestFiles.join(', ')})` }
    if (vitestFiles.length) return { ...base, status: 'FAIL', detail: `มีเทสต์ใน ${vitestFiles.join(', ')} แต่ไม่ได้รันในรายงานของรอบนี้` }
    return { ...base, status: 'FAIL', hasTests: false, detail: `ไม่มีเทสต์ที่ชื่อมีแท็ก [${row.key}]` }
  }

  const checks: AcCheck[] = []
  const human: TraceReport['human'] = []
  let ticked = 0
  const unticked = { passed: 0, total: 0 }
  for (const item of items.values()) {
    const owned = rows.filter((r) => r.owner === item.id)
    if (!item.done) {
      unticked.total += owned.length
      unticked.passed += owned.filter((r) => check(item.id, r).status === 'PASS').length
      continue
    }
    ticked++
    if (item.tags.includes('คน')) {
      // The user ticks [คน] items after checking by hand; there is no automated test to look for
      if (owned.length) human.push({ item: item.id, keys: owned.map((r) => r.key) })
      continue
    }
    for (const row of owned) checks.push(check(item.id, row))
  }

  const inputProblems = input.inputProblems ?? []
  const failed = inputProblems.length + specProblems.length + mapIssues.length + checks.filter((c) => c.status === 'FAIL').length
  const status: Status = failed ? 'FAIL' : checks.some((c) => c.status === 'SKIP') ? 'SKIP' : 'PASS'
  return {
    status,
    inputProblems,
    specProblems,
    mapProblems: mapIssues,
    ticked,
    checks,
    human,
    unowned: rows.filter((r) => r.owner === null).map((r) => r.key),
    unticked,
    e2eNote: e2e.note,
  }
}

// ---------- Output ----------
const GATE = 'trace'
const head = (status: Status, text: string) => `${status.padEnd(5)} ${GATE.padEnd(12)} ${text}`
const sub = (text: string) => `      ${text}`

const MAP_IMPACT = 'แผนที่เจ้าของ AC ไม่ตรงกับ spec ด่านนี้จึงอาจบังคับเทสต์ผิดข้อหรือไม่บังคับเลย ข้อที่ติ๊กอาจไม่มีหลักฐานของ AC ที่ควรมี'
const MAP_FIX =
  'แก้ docs/traceability/ac-map.yaml ให้ตรงกับ spec §8 และ §16 ตามกฎใน docs/traceability/README.md แล้วนับ counts และ basisCounts ใหม่ (ห้ามย้ายเจ้าของเพื่อหลบด่าน)'
const REPORTS_FIX = 'รันผ่าน pnpm verify (ด่าน unit golden property integration ส่งรายงานให้ด่านนี้) หรือส่ง --reports=<ไฟล์ JSON ของ vitest>'
const E2E_FIX = 'รัน pnpm verify --e2e (หรือ pnpm test:e2e แล้วรันด่านนี้อีกครั้งโดยไม่แก้ไฟล์เทสต์ระหว่างนั้น)'

const acImpact = (c: AcCheck) => `${c.item} ติ๊กโดยไม่มีหลักฐานว่า AC นี้ทำงาน: "${c.text}"`
const acFix = (c: AcCheck) =>
  c.hasTests ? `แก้ให้เทสต์ที่มีแท็ก [${c.key}] ผ่านจริง (ห้ามข้ามหรือกลับผล) หรือเอาติ๊กของ ${c.item} ออก` : `เขียนเทสต์ที่ชื่อมีแท็ก [${c.key}] และผ่านจริง หรือเอาติ๊กของ ${c.item} ออก`

/** The one-line summary: ticked items, owned ACs with a passing test, unowned ACs and coverage of the rest. */
export function traceSummary(r: TraceReport): string {
  const passed = r.checks.filter((c) => c.status === 'PASS').length
  const skipped = r.checks.filter((c) => c.status === 'SKIP').length
  const humanAcs = r.human.reduce((n, h) => n + h.keys.length, 0)
  return [
    `ข้อที่ติ๊ก ${r.ticked} ข้อ`,
    `AC ที่ต้องมีเทสต์ ${passed}/${r.checks.length}`,
    skipped ? `รอผล e2e ${skipped}` : '',
    r.human.length ? `ตรวจโดยคน ${r.human.length} ข้อ (${humanAcs} AC)` : '',
    `ยังไม่มีเจ้าของ ${r.unowned.length}`,
    `ข้อที่ยังไม่ติ๊กมีเทสต์ที่ผ่านแล้ว ${r.unticked.passed}/${r.unticked.total} AC`,
    r.e2eNote,
  ]
    .filter(Boolean)
    .join(' · ')
}

const infoLines = (r: TraceReport) => [
  ...r.human.map((h) => `ตรวจโดยคน: ${h.item} (${h.keys.join(', ')}) ผู้ใช้ติ๊กเองหลังตรวจ ด่านนี้ไม่หาเทสต์`),
  ...(r.unowned.length ? [`ยังไม่มีเจ้าของ (เพิ่มเป็นข้อ NEW ใน §16.11): ${r.unowned.join(', ')}`] : []),
]

/** Human report in the format of the other gates: FAIL and SKIP blocks with impact and fix, then the summary. */
export function traceLines(r: TraceReport): string[] {
  const out: string[] = []
  if (r.inputProblems.length) {
    out.push(head('FAIL', `อ่านผลเทสต์ไม่ได้ ${r.inputProblems.length} รายการ`), ...r.inputProblems.map(sub))
    out.push(sub('ผลกระทบ: ไม่รู้ว่าข้อที่ติ๊กแล้วมีเทสต์ที่ผ่านจริงหรือไม่'), sub(`วิธีแก้: ${REPORTS_FIX}`))
  }
  const docProblems = [...r.specProblems, ...r.mapProblems]
  if (docProblems.length) {
    out.push(head('FAIL', `ac-map.yaml ไม่ตรงกับ spec (${docProblems.length} ปัญหา)`), ...docProblems.map(sub))
    out.push(sub(`ผลกระทบ: ${MAP_IMPACT}`), sub(`วิธีแก้: ${MAP_FIX}`))
  }
  const noReports = r.checks.filter((c) => c.status === 'FAIL' && c.noReports)
  if (noReports.length) {
    out.push(head('FAIL', `ไม่มีรายงานผลเทสต์ Vitest ของรอบนี้ จึงตรวจ ${noReports.length} AC ของข้อที่ติ๊กไม่ได้: ${noReports.map((c) => `${c.item} ${c.key}`).join(', ')}`))
    out.push(sub('ผลกระทบ: ไม่รู้ว่าข้อที่ติ๊กแล้วมีเทสต์ที่ผ่านจริงหรือไม่'), sub(`วิธีแก้: ${REPORTS_FIX}`))
  }
  for (const c of r.checks) {
    if (c.status === 'FAIL' && !c.noReports) {
      out.push(head('FAIL', `${c.item} ติ๊กแล้วแต่ไม่มีเทสต์ที่ผ่านของ ${c.key}`), sub(c.detail), sub(`ผลกระทบ: ${acImpact(c)}`), sub(`วิธีแก้: ${acFix(c)}`))
    } else if (c.status === 'SKIP') {
      out.push(head('SKIP', `${c.item} ติ๊กแล้ว แต่ยังไม่รู้ผลของ ${c.key}: ${c.detail}`), sub(`วิธีแก้: ${E2E_FIX}`))
    }
  }
  out.push(head(r.status, traceSummary(r)), ...infoLines(r).map(sub))
  return out
}

/** The same result as one verify gate (scripts/verify.ts prints status, detail, impact and fix). */
export function traceGateResult(r: TraceReport): GateResult {
  const summary = traceSummary(r)
  const info = infoLines(r)
  if (r.status !== 'FAIL') {
    const skips = r.checks.filter((c) => c.status === 'SKIP').map((c) => `SKIP ${c.item} ${c.key}: ${c.detail}`)
    return { status: r.status, detail: [summary, ...skips, ...info].join('\n      ') }
  }
  const noReports = r.checks.filter((c) => c.status === 'FAIL' && c.noReports)
  const acFails = r.checks.filter((c) => c.status === 'FAIL' && !c.noReports)
  const lines = [
    ...r.inputProblems,
    ...[...r.specProblems, ...r.mapProblems].map((p) => `ac-map: ${p}`),
    ...(noReports.length ? [`ไม่มีรายงาน Vitest ของรอบนี้: ตรวจ ${noReports.length} AC ไม่ได้ (${noReports.map((c) => `${c.item} ${c.key}`).join(', ')})`] : []),
    ...acFails.map((c) => `${c.item} ${c.key}: ${c.detail}`),
  ]
  const shown = lines.slice(0, 10)
  const more = lines.length > shown.length ? [`… และอีก ${lines.length - shown.length} รายการ (ดูทั้งหมดด้วย pnpm exec tsx scripts/check-traceability.ts)`] : []
  const mapBroken = r.specProblems.length + r.mapProblems.length > 0
  const impact = mapBroken
    ? MAP_IMPACT
    : acFails.length === 0
      ? 'ไม่รู้ว่าข้อที่ติ๊กแล้วมีเทสต์ที่ผ่านจริงหรือไม่ เพราะไม่มีหรืออ่านรายงานผลเทสต์ของรอบนี้ไม่ได้'
      : acFails.length === 1 && !noReports.length && !r.inputProblems.length
        ? acImpact(acFails[0]!)
        : 'ข้อที่ติ๊กแล้วไม่มีหลักฐานว่า AC ที่เป็นเจ้าของทำงานจริง (README ด่าน traceability ข้อ 3)'
  const fixes = [
    mapBroken ? MAP_FIX : '',
    noReports.length || r.inputProblems.length ? REPORTS_FIX : '',
    acFails.length === 1 ? acFix(acFails[0]!) : acFails.length ? 'เขียนหรือแก้เทสต์ให้ชื่อมีแท็ก [FR-…/ACn] ของ AC ที่ขาดและผ่านจริง หรือเอาติ๊กของข้อนั้นออก' : '',
  ].filter(Boolean)
  return { status: 'FAIL', detail: [`${lines.length} ปัญหา · ${summary}`, ...shown, ...more].join('\n      '), impact, fix: fixes.join(' · ') }
}
