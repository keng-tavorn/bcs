// Rules for docs/feature-status.yaml (spec §0.5, §15.5 gate 10, §15.6), free of I/O so they have unit tests.

export const STATUSES = ['planned', 'in_progress', 'done', 'verified', 'live'] as const
const SHIPPED = new Set(['done', 'verified', 'live'])

export interface Feature {
  status?: string
  step?: string
  evidence?: unknown
  verifiedBy?: unknown
  notes?: string
}
export interface FeatureDoc {
  updatedAt?: unknown
  features?: Record<string, Feature>
}

export interface FrSpec {
  /** every `Sn` named on the FR's "ขั้น" line, e.g. FR-ADM-006 → S1, S5 */
  steps: string[]
  acs: string[]
}

/** FR headings, their "ขั้น" line and AC bullets from spec §8 (code blocks skipped). */
export function frsFromSpec(specText: string): Map<string, FrSpec> {
  const frs = new Map<string, FrSpec>()
  let inCode = false
  let current: FrSpec | null = null
  for (const line of specText.split(/\r?\n/)) {
    if (line.trim().startsWith('```')) {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    const heading = /^#{2,5} (FR-[A-Z0-9]+-\d{3})\b/.exec(line)
    if (heading) {
      current = { steps: [], acs: [] }
      frs.set(heading[1]!, current)
      continue
    }
    if (/^#{1,5} /.test(line)) {
      current = null
      continue
    }
    if (!current) continue
    if (line.startsWith('ขั้น ') && current.steps.length === 0) current.steps = [...new Set([...line.matchAll(/\bS(\d{1,2})\b/g)].map((m) => `S${m[1]}`))]
    const ac = /^- (AC\d+) —/.exec(line)
    if (ac) current.acs.push(ac[1]!)
  }
  return frs
}

export const isTier1 = (id: string) => /^FR-[A-Z0-9]+-0\d\d$/.test(id)

const TAG = /\[(FR-[A-Z0-9]+-\d{3})\/(AC\d+)\]/g
/** `FR-PLT-012/AC1` keys of every `[FR-xxx-nnn/ACn]` tag in a text (a test name). */
export function acTags(text: string): string[] {
  return [...text.matchAll(TAG)].map((m) => `${m[1]}/${m[2]}`)
}

// `it(`, `test.describe(`, `it.each(rows)(` … and the title string that opens the call, on the same line
const TEST_TITLE = /\b(?:it|test|describe|suite|specify)(?:\.\w+)*(?:\([^()]*\))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
/** AC tags written in the titles of a test file's it/test/describe calls (not in comments or other strings on the line). */
export function testTitleTags(source: string): string[] {
  return source.split(/\r?\n/).flatMap((line) => [...line.matchAll(TEST_TITLE)].flatMap((m) => acTags(m[2]!)))
}

export interface TestIndex {
  /** AC key → test files whose source carries the tag (static scan of tests/) */
  files: Map<string, string[]>
  /** AC keys of passed tests in this run's Vitest reports; null when no report was given */
  passed: Set<string> | null
}

export interface FileProbe {
  kind: (file: string) => 'file' | 'dir' | 'missing'
  text: (file: string) => string
}

const isE2e = (file: string) => file.startsWith('tests/e2e/')

export function featureStatusProblems(input: { frs: Map<string, FrSpec>; doc: FeatureDoc; tests: TestIndex; fs: FileProbe }): string[] {
  const { frs, doc, tests, fs } = input
  const problems: string[] = []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(doc.updatedAt ?? ''))) problems.push('updatedAt ต้องเป็นวันที่ YYYY-MM-DD')
  const features = doc.features ?? {}
  for (const id of frs.keys()) if (isTier1(id) && !features[id]) problems.push(`${id} ไม่มีใน feature-status`)

  for (const [id, f] of Object.entries(features)) {
    const spec = frs.get(id)
    if (!spec) {
      problems.push(`${id} ไม่มีใน spec.md`)
      continue
    }
    const status = f.status ?? ''
    if (!(STATUSES as readonly string[]).includes(status)) problems.push(`${id}: status "${f.status}" ไม่ถูกต้อง`)
    if (!/^S([1-9]|1[0-7])$/.test(f.step ?? '')) problems.push(`${id}: step "${f.step}" ไม่ถูกต้อง`)
    else if (spec.steps.length && !spec.steps.includes(f.step!)) problems.push(`${id}: step ${f.step} ไม่ตรงกับบรรทัด "ขั้น" ใน spec (${spec.steps.join(', ')})`)

    // Evidence: test files that exist (not folders), under tests/, and at least one carries a tag of this FR
    const evidence = Array.isArray(f.evidence) ? f.evidence : f.evidence == null ? [] : null
    if (evidence === null) problems.push(`${id}: evidence ต้องเป็นรายการ path`)
    const paths = (evidence ?? []).map(String)
    for (const e of paths) {
      const kind = fs.kind(e)
      if (!e.startsWith('tests/')) problems.push(`${id}: evidence ${e} ต้องเป็นไฟล์เทสต์ใน tests/`)
      else if (kind === 'missing') problems.push(`${id}: evidence ${e} ไม่มีอยู่จริง`)
      else if (kind === 'dir') problems.push(`${id}: evidence ${e} เป็นโฟลเดอร์ ต้องระบุไฟล์`)
    }
    const tagged = paths.filter((e) => e.startsWith('tests/') && fs.kind(e) === 'file' && testTitleTags(fs.text(e)).some((k) => k.startsWith(`${id}/`)))

    const testedAcs = spec.acs.filter((ac) => (tests.files.get(`${id}/${ac}`) ?? []).length > 0)
    if (SHIPPED.has(status)) {
      if (paths.length === 0) problems.push(`${id}: status ${status} ต้องมี evidence`)
      else if (tagged.length === 0) problems.push(`${id}: evidence ต้องมีไฟล์เทสต์ที่มีแท็ก [${id}/ACn] อย่างน้อย 1 ไฟล์`)
      for (const ac of spec.acs) {
        const key = `${id}/${ac}`
        const files = tests.files.get(key) ?? []
        if (files.length === 0) problems.push(`${id}: status ${status} แต่ ${ac} ยังไม่มีเทสต์ที่มีแท็ก [${key}]`)
        else if (tests.passed && !tests.passed.has(key) && !files.every(isE2e)) {
          problems.push(`${id}: status ${status} แต่เทสต์ [${key}] ไม่ผ่านในรอบนี้ (${files.join(', ')})`)
        }
      }
    } else if (status === 'planned' && testedAcs.length) {
      problems.push(`${id}: ยังเป็น planned ทั้งที่มีเทสต์ของ ${testedAcs.join(' ')} แล้ว — อัปเดตเป็น in_progress หรือ done`)
    }

    if (status === 'verified' || status === 'live') {
      const names = Array.isArray(f.verifiedBy) ? f.verifiedBy : f.verifiedBy == null ? [] : [f.verifiedBy]
      const valid = names.filter((n) => typeof n === 'string' && n.trim().length >= 2 && /\p{L}/u.test(n))
      if (valid.length === 0 || valid.length !== names.length) problems.push(`${id}: status ${status} ต้องระบุ verifiedBy เป็นชื่อผู้ใช้จริงที่ลองแล้ว (§16.2 ข้อ 5)`)
    }
  }
  return problems
}
