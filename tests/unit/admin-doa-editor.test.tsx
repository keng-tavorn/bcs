import { NextIntlClientProvider, createTranslator } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AuthorityList, BoundaryCompare } from '@/app/(workspace)/admin/doa/_parts/sections'
import { doaWords, type DoaT } from '@/app/(workspace)/admin/doa/_parts/words'
import type { CompareView } from '@/server/services/doa/view'
import { amountToSatang } from '@/core/money/dto'
import { amountBasisChange, authorityChanges, boundaryComparison } from '@/server/services/doa/compare'
import { effectiveDates, thaiDateStart } from '@/server/services/doa/dates'
import { boundaryRefusalAt, boundaryTickMissing, boundaryTickValue } from '@/ui/admin-doa/boundary-tick'
import { DoaEditor, type DoaEditorProps } from '@/ui/admin-doa/editor'
import {
  applyDraft,
  changedParts,
  changedPolicies,
  draftInput,
  draftOf,
  emptyDraft,
  hoursText,
  removeRule,
  restoreRule,
  satangFromText,
  textFromSatang,
  type PolicyState,
  type RuleState,
} from '@/ui/admin-doa/editor-model'
import { SubmitDoaPanel, type SubmitDoaPanelProps } from '@/ui/admin-doa/submit-panel'
import th from '../../messages/th.json'
import { loadYaml, versionSnapshots } from '../golden/doa-fixtures'

// S3-09 · the DOA editor's table logic (FR-DOA-001 AC1): money typed in baht and kept as satang text, one row edited at
// a time, bands that joined keep joining when an edge moves, and what the server action receives; the pure comparison
// behind FR-DOA-009 AC1 and AC3 on the §7.4 fixture versions (who gains or loses authority, both boundary tables, which
// for version 1 is GC-DOA-22); and the first step of the editor as a list of rules with one edit button each (§9.9: no
// page of more than 8 fields). Interactions run in tests/e2e/admin-doa-editor.spec.ts; the service in tests/integration.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

const baht = (text: string) => amountToSatang(text).toString()
const DM = { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' } as const
const VP = { kind: 'POSITION_OF_DEPARTMENT', position: 'VP' } as const
const CEO = { kind: 'POSITION_OF_ORG', position: 'CEO' } as const
const HOURS_8 = 480

/** Purchase-request bands of version 1 of the fixture, and its governance rule */
const table = (): RuleState[] => [
  { key: 0, code: 'PR-01', documentType: 'PURCHASE_REQUEST', band: { lowerKind: 'gt', lower: '0', upper: baht('20000.00') }, steps: [{ approver: DM, slaMinutes: HOURS_8 }], isNew: false },
  { key: 1, code: 'PR-02', documentType: 'PURCHASE_REQUEST', band: { lowerKind: 'gt', lower: baht('20000.00'), upper: baht('100000.00') }, steps: [{ approver: VP, slaMinutes: HOURS_8 }], isNew: false },
  { key: 2, code: 'PR-03', documentType: 'PURCHASE_REQUEST', band: { lowerKind: 'gt', lower: baht('100000.00'), upper: null }, steps: [{ approver: CEO, slaMinutes: HOURS_8 * 2 }], isNew: false },
  { key: 3, code: 'DOA-CHG-01', documentType: 'DOA_CHANGE', band: null, steps: [{ approver: CEO, slaMinutes: HOURS_8 * 2 }], isNew: false },
]

describe('[FR-DOA-001/AC1] the editor table keeps money exact and bands joined', () => {
  it('reads baht as typed and shows satang with separators and two decimals', () => {
    expect(satangFromText('30,000')).toBe('3000000')
    expect(satangFromText(' 20000.5 ')).toBe('2000050')
    expect(satangFromText('')).toBeNull()
    for (const bad of ['1.234', '-5', 'abc', '1e5']) expect(satangFromText(bad), bad).toBeUndefined()
    expect(textFromSatang('3000001')).toBe('30,000.01')
    expect(textFromSatang(null)).toBe('')
    expect(hoursText(HOURS_8)).toBe('8')
    expect(hoursText(90)).toBe('1.50')
  })

  it('moving the DM band to 30,000 moves the start of the VP band with it, and says so', () => {
    const rules = table()
    const result = applyDraft(rules, { key: 0, documentType: 'PURCHASE_REQUEST', newKey: 9 }, { ...draftOf(rules[0]!), upper: '30,000' })
    if (!result.ok) throw new Error(JSON.stringify(result.errors))
    expect(result.rules[0]!.band).toEqual({ lowerKind: 'gt', lower: '0', upper: baht('30000.00') })
    expect(result.rules[1]!.band).toEqual({ lowerKind: 'gt', lower: baht('30000.00'), upper: baht('100000.00') })
    expect(result.followed).toEqual([{ code: 'PR-02', end: 'lower', to: baht('30000.00') }])
    expect(result.notFollowed).toEqual([])
    // The source table is not changed in place
    expect(rules[1]!.band!.lower).toBe(baht('20000.00'))
  })

  it('moving the start of a band moves the end of the band before it; a neighbour that would turn round stays', () => {
    const rules = table()
    const later = applyDraft(rules, { key: 1, documentType: 'PURCHASE_REQUEST', newKey: 9 }, { ...draftOf(rules[1]!), lower: '25000' })
    if (!later.ok) throw new Error('expected ok')
    expect(later.rules[0]!.band!.upper).toBe(baht('25000.00'))
    expect(later.followed).toEqual([{ code: 'PR-01', end: 'upper', to: baht('25000.00') }])
    // PR-01's end moved past the end of PR-02: PR-02 would start after it ends, so it is left for the user
    const past = applyDraft(rules, { key: 0, documentType: 'PURCHASE_REQUEST', newKey: 9 }, { ...draftOf(rules[0]!), upper: '150000' })
    if (!past.ok) throw new Error('expected ok')
    expect(past.notFollowed).toEqual(['PR-02'])
    expect(past.rules[1]!.band!.lower).toBe(baht('20000.00'))
  })

  it('says what is wrong with each field of the row', () => {
    const rules = table()
    expect(applyDraft(rules, { key: 0, documentType: 'PURCHASE_REQUEST', newKey: 9 }, { ...draftOf(rules[0]!), upper: '30,000.001', approver: '', slaHours: '0' })).toEqual({
      ok: false,
      errors: { upper: 'MONEY', approver: 'APPROVER', slaHours: 'SLA' },
    })
    expect(applyDraft(rules, { key: 1, documentType: 'PURCHASE_REQUEST', newKey: 9 }, { ...draftOf(rules[1]!), upper: '20000' })).toEqual({ ok: false, errors: { upper: 'BAND_ORDER' } })
    expect(applyDraft(rules, { key: 'new', documentType: 'PURCHASE_REQUEST', newKey: 9 }, { ...emptyDraft(rules, 'PURCHASE_REQUEST'), code: 'pr 4', approver: 'POSITION_OF_ORG:CEO', slaHours: '8' })).toEqual({ ok: false, errors: { code: 'CODE' } })
    expect(applyDraft(rules, { key: 'new', documentType: 'PURCHASE_REQUEST', newKey: 9 }, { ...emptyDraft(rules, 'PURCHASE_REQUEST'), code: 'pr-02', approver: 'POSITION_OF_ORG:CEO', slaHours: '8' })).toEqual({ ok: false, errors: { code: 'CODE_TAKEN' } })
  })

  it('a new rule starts where the last band of its type ends, goes after it, and a policy rule has no band', () => {
    const rules = table()
    const draft = emptyDraft(rules, 'PURCHASE_REQUEST')
    expect(draft).toEqual({ code: '', lower: '100,000.00', upper: '', approver: '', slaHours: '8' })
    const added = applyDraft(rules, { key: 'new', documentType: 'DOA_CHANGE', newKey: 9 }, { ...emptyDraft(rules, 'DOA_CHANGE'), code: 'doa-chg-02', lower: '5', approver: 'POSITION_OF_ORG:COO', slaHours: '16' })
    if (!added.ok) throw new Error(JSON.stringify(added.errors))
    expect(added.rules.map((r) => r.code)).toEqual(['PR-01', 'PR-02', 'PR-03', 'DOA-CHG-01', 'DOA-CHG-02'])
    expect(added.rules[4]).toEqual({ key: 9, code: 'DOA-CHG-02', documentType: 'DOA_CHANGE', band: null, steps: [{ approver: { kind: 'POSITION_OF_ORG', position: 'COO' }, slaMinutes: 960 }], isNew: true })
    expect(removeRule(added.rules, 9).map((r) => r.code)).toEqual(['PR-01', 'PR-02', 'PR-03', 'DOA-CHG-01'])
  })

  it('a removed rule comes back where it stood, as it was, with one press; never twice', () => {
    const rules = table()
    const gone = removeRule(rules, 1)
    expect(gone.map((r) => r.code)).toEqual(['PR-01', 'PR-03', 'DOA-CHG-01'])
    const back = restoreRule(gone, rules[1]!, 1)
    expect(back).toEqual(rules)
    // Already there again (by key or by code): the table stays as it is
    expect(restoreRule(back, rules[1]!, 1)).toEqual(rules)
    // An index past the end puts it last
    expect(restoreRule(removeRule(rules, 3), rules[3]!, 99).map((r) => r.code)).toEqual(['PR-01', 'PR-02', 'PR-03', 'DOA-CHG-01'])
  })

  it('names what changed against the source, and sends the server exactly the table', () => {
    const rules = table()
    const edited = applyDraft(rules, { key: 0, documentType: 'PURCHASE_REQUEST', newKey: 9 }, { ...draftOf(rules[0]!), upper: '30000', approver: 'POSITION_OF_DEPARTMENT:VP', slaHours: '4' })
    if (!edited.ok) throw new Error('expected ok')
    expect(changedParts(rules[0], edited.rules[0]!)).toEqual(['band', 'approver', 'sla'])
    expect(changedParts(rules[2], edited.rules[2]!)).toEqual([])
    const policy: PolicyState = { amountBasis: 'GROSS', selfApprovalPolicy: 'ESCALATE_NEXT_BAND', collapseDuplicateApprovers: true, stepUpThreshold: '100,000.00', approverMayReceive: false, requesterMayReceive: true }
    expect(changedPolicies(policy, { ...policy, stepUpThreshold: '100000' })).toEqual([])
    expect(changedPolicies(policy, { ...policy, stepUpThreshold: '', amountBasis: 'NET' })).toEqual(['amountBasis', 'stepUpThreshold'])
    expect(draftInput('v1', edited.rules, { ...policy, stepUpThreshold: '50,000' }, '2026-11-01', '  ขยายวงเงิน  ')).toEqual({
      sourceVersionId: 'v1',
      effectiveDate: '2026-11-01',
      changeReason: 'ขยายวงเงิน',
      policy: { amountBasis: 'GROSS', selfApprovalPolicy: 'ESCALATE_NEXT_BAND', collapseDuplicateApprovers: true, stepUpThreshold: baht('50000.00'), approverMayReceive: false, requesterMayReceive: true },
      rules: edited.rules.map((r) => ({ code: r.code, documentType: r.documentType, band: r.band, steps: r.steps })),
    })
    expect(draftInput('v1', rules, { ...policy, stepUpThreshold: 'lots' }, '2026-11-01', 'x')).toEqual({ error: 'STEP_UP' })
  })

  it('offers the first day of next month, never before tomorrow nor before a version approved for later', () => {
    expect(effectiveDates(new Date('2026-10-04T10:00:00Z'), null)).toEqual({ defaultDate: '2026-11-01', minDate: '2026-10-05' })
    // 23:30 on 31 December Thai time: tomorrow is in the next year
    expect(effectiveDates(new Date('2026-12-31T16:30:00Z'), null)).toEqual({ defaultDate: '2027-01-01', minDate: '2027-01-01' })
    expect(effectiveDates(new Date('2026-10-04T10:00:00Z'), new Date('2026-10-31T17:00:00Z'))).toEqual({ defaultDate: '2026-12-01', minDate: '2026-11-02' })
    expect(thaiDateStart('2026-11-01')?.toISOString()).toBe('2026-10-31T17:00:00.000Z')
    for (const bad of ['2026-02-30', '2026-13-01', '2026-11-1', '']) expect(thaiDateStart(bad), bad).toBeNull()
  })
})

describe('[FR-DOA-009/AC1] who gains or loses authority between two versions', () => {
  const [v1, v2] = versionSnapshots()

  it('version 2 of the fixture: the DM gains purchase requests above 20,000 up to 30,000 and the VP loses them', () => {
    expect(authorityChanges(v1!, v2!)).toEqual([
      { change: 'GAIN', approver: DM, documentType: 'PURCHASE_REQUEST', band: { gt: baht('20000.00'), lte: baht('30000.00') } },
      { change: 'LOSE', approver: VP, documentType: 'PURCHASE_REQUEST', band: { gt: baht('20000.00'), lte: baht('30000.00') } },
    ])
    expect(authorityChanges(v1!, v1!)).toEqual([])
  })

  it('a named person replacing a position, and a new top band, are said per document type and band', () => {
    const named = { kind: 'MEMBER', memberId: 'dm_con' } as const
    const after = {
      rules: [
        ...v1!.rules.filter((r) => r.code !== 'GRV-01' && r.code !== 'PR-03' && r.code !== 'DOA-CHG-01'),
        { ...v1!.rules.find((r) => r.code === 'GRV-01')!, steps: [{ approver: named, slaBusinessMinutes: HOURS_8, mode: 'SEQUENTIAL' as const }] },
        { ...v1!.rules.find((r) => r.code === 'PR-03')!, when: { amount: { gt: 10_000_000n, lte: 50_000_000n } } },
        { ...v1!.rules.find((r) => r.code === 'PR-03')!, code: 'PR-04', when: { amount: { gt: 50_000_000n } }, steps: [{ approver: { kind: 'POSITION_OF_ORG', position: 'COO' } as const, slaBusinessMinutes: HOURS_8, mode: 'SEQUENTIAL' as const }] },
        { ...v1!.rules.find((r) => r.code === 'DOA-CHG-01')!, steps: [{ approver: { kind: 'POSITION_OF_ORG', position: 'COO' } as const, slaBusinessMinutes: HOURS_8, mode: 'SEQUENTIAL' as const }] },
      ],
    }
    expect(authorityChanges(v1!, after)).toEqual([
      { change: 'GAIN', approver: { kind: 'POSITION_OF_ORG', position: 'COO' }, documentType: 'PURCHASE_REQUEST', band: { gt: baht('500000.00'), lte: null } },
      { change: 'LOSE', approver: CEO, documentType: 'PURCHASE_REQUEST', band: { gt: baht('500000.00'), lte: null } },
      { change: 'GAIN', approver: named, documentType: 'GR_VARIANCE', band: { gt: '0', lte: null } },
      { change: 'LOSE', approver: DM, documentType: 'GR_VARIANCE', band: { gt: '0', lte: null } },
      { change: 'GAIN', approver: { kind: 'POSITION_OF_ORG', position: 'COO' }, documentType: 'DOA_CHANGE', band: null },
      { change: 'LOSE', approver: CEO, documentType: 'DOA_CHANGE', band: null },
    ])
  })
})

// FR-DOA-009 AC3 has two halves: the drafter's tick (here, the integration tests and the e2e) and the approver's, on the
// decision page of DOA_VERSION tasks, which is not built yet — so these titles do not carry that AC's tag
describe('the boundary table beside the version in effect (FR-DOA-009 AC3, drafter side)', () => {
  const [v1, v2] = versionSnapshots()

  it('[GC-DOA-22] alone, the table of version 1 is the golden case', () => {
    const golden = loadYaml<{ cases: Array<{ id: string; expect: { rows: Array<{ amount: string; rule: string }> } }> }>('doa-lint.yaml').cases.find((c) => c.id === 'GC-DOA-22')!
    const pr = boundaryComparison(null, v1!).find((t) => t.documentType === 'PURCHASE_REQUEST')!
    expect(pr.rows.map((r) => ({ amount: r.amount, rule: r.after.ruleCode }))).toEqual(golden.expect.rows.map((r) => ({ amount: baht(r.amount), rule: r.rule })))
    expect(pr.rows.every((r) => r.before === null && !r.changed)).toBe(true)
  })

  it('beside version 1, version 2 shows every edge of both and marks the amounts whose approver changes', () => {
    const pr = boundaryComparison(v1!, v2!).find((t) => t.documentType === 'PURCHASE_REQUEST')!
    expect(pr.rows.map((r) => [r.amount, r.before?.ruleCode, r.after.ruleCode, r.changed])).toEqual([
      [baht('20000.00'), 'PR-01', 'PR-01', false],
      [baht('20000.01'), 'PR-02', 'PR-01', true],
      [baht('30000.00'), 'PR-02', 'PR-01', true],
      [baht('30000.01'), 'PR-02', 'PR-02', false],
      [baht('100000.00'), 'PR-02', 'PR-02', false],
      [baht('100000.01'), 'PR-03', 'PR-03', false],
    ])
    expect(boundaryComparison(v1!, v2!).map((t) => t.documentType)).toEqual(['PURCHASE_REQUEST', 'PURCHASE_ORDER'])
  })

  it('a version whose bands have no upper end, beside another such version, has no table to tick', () => {
    const flat = (approver: typeof DM | typeof VP) => ({
      rules: [
        { code: 'PR-01', documentType: 'PURCHASE_REQUEST' as const, priority: 100, when: { amount: { gt: 0n } }, steps: [{ approver, slaBusinessMinutes: HOURS_8, mode: 'SEQUENTIAL' as const }] },
        { code: 'DOA-CHG-01', documentType: 'DOA_CHANGE' as const, priority: 100, when: {}, steps: [{ approver: CEO, slaBusinessMinutes: HOURS_8, mode: 'SEQUENTIAL' as const }] },
      ],
    })
    expect(boundaryComparison(flat(DM), flat(VP))).toEqual([])
    expect(boundaryComparison(null, flat(VP))).toEqual([])
    // Beside a version with edges, the edges of that version are still checked
    expect(boundaryComparison(v1!, flat(VP)).map((t) => t.documentType)).toEqual(['PURCHASE_REQUEST', 'PURCHASE_ORDER'])
    // Authority is compared all the same: the VP gains every purchase request, the DM loses them
    expect(authorityChanges(flat(DM), flat(VP))).toEqual([
      { change: 'GAIN', approver: VP, documentType: 'PURCHASE_REQUEST', band: { gt: '0', lte: null } },
      { change: 'LOSE', approver: DM, documentType: 'PURCHASE_REQUEST', band: { gt: '0', lte: null } },
    ])
  })
})

describe('[FR-DOA-009/AC1] a change of amount basis is named, since the same amount is then another document', () => {
  it('names both bases when they differ, and nothing when they are the same', () => {
    expect(amountBasisChange({ amountBasis: 'GROSS' }, { amountBasis: 'NET' })).toEqual({ before: 'GROSS', after: 'NET' })
    expect(amountBasisChange({ amountBasis: 'NET' }, { amountBasis: 'GROSS' })).toEqual({ before: 'NET', after: 'GROSS' })
    expect(amountBasisChange({ amountBasis: 'GROSS' }, { amountBasis: 'GROSS' })).toBeNull()
    // The reason it matters: version 1's bands read on another basis name the same approvers at the same numbers, so
    // the comparison alone would say nothing changed
    const [v1] = versionSnapshots()
    const net = { ...v1!, amountBasis: 'NET' as const }
    expect(amountBasisChange(v1!, net)).toEqual({ before: 'GROSS', after: 'NET' })
    expect(authorityChanges(v1!, net)).toEqual([])
  })

  it('the page says so beside both comparisons, and no boundary row claims the same approver', () => {
    const t = createTranslator({ locale: 'th', messages: th, namespace: 'adminDoa' }) as unknown as DoaT
    const words = doaWords(t, 'th')
    const dm = { kind: 'POSITION_OF_DEPARTMENT' as const, position: 'DM', positionNameTh: 'ผู้จัดการฝ่าย', positionNameEn: null }
    const side = { ruleCode: 'PR-01', approvers: [dm] }
    const compare: CompareView = {
      baseline: { id: 'v1', code: 'DOA-DEMO', versionNo: 1, inEffectNow: true, effectiveFrom: '2025-12-31T17:00:00.000Z', policy: { amountBasis: 'GROSS', selfApprovalPolicy: 'ESCALATE_NEXT_BAND', collapseDuplicateApprovers: true, stepUpThreshold: null, approverMayReceive: false, requesterMayReceive: true }, rules: [] },
      diff: { policy: [{ field: 'amountBasis', before: 'GROSS', after: 'NET' }], added: [], removed: [], changed: [] },
      authority: [],
      boundaries: [{ documentType: 'PURCHASE_REQUEST', rows: [{ amount: baht('20000.00'), before: side, after: side, changed: false }] }],
      basis: { before: 'GROSS', after: 'NET' },
    }
    const baseline = { name: 'DOA-DEMO ฉบับ 1', next: false }
    const html = renderToStaticMarkup(
      <>
        <AuthorityList compare={compare} baseline={baseline} simulateHref="/admin/doa/v2/simulate" t={t} words={words} />
        <BoundaryCompare tables={compare.boundaries} baseline={baseline} basis={compare.basis} simulateHref="/admin/doa/v2/simulate" t={t} words={words} />
      </>,
    )
    expect(html).toContain('ฉบับนี้เปลี่ยนฐานวงเงินจากรวม VAT เป็นก่อน VAT')
    expect(html).toContain('ลองเอกสารจริงในหน้าทดลองส่ง')
    expect(html).toContain('ตามตัวเลขของช่วงวงเงิน ไม่มีตำแหน่งใดได้หรือเสียอำนาจ แต่ฐานวงเงินเปลี่ยน')
    expect(html).not.toContain('ทุกยอดของทุกประเภทเอกสารยังไปหาผู้อนุมัติเดิม')
    expect(html).toContain('ฐานวงเงินต่างกัน')
    expect(html).not.toContain('ผู้อนุมัติเดิม')
  })

  it('without a version to compare with, the table shows the rule and approver at each edge of this version alone', () => {
    const t = createTranslator({ locale: 'th', messages: th, namespace: 'adminDoa' }) as unknown as DoaT
    const dm = { kind: 'POSITION_OF_DEPARTMENT' as const, position: 'DM', positionNameTh: 'ผู้จัดการฝ่าย', positionNameEn: null }
    const html = renderToStaticMarkup(
      <BoundaryCompare
        tables={[{ documentType: 'PURCHASE_REQUEST', rows: [{ amount: baht('20000.00'), before: null, after: { ruleCode: 'PR-01', approvers: [dm] }, changed: false }] }]}
        baseline={null}
        basis={null}
        simulateHref="/admin/doa/v1/simulate"
        t={t}
        words={doaWords(t, 'th')}
      />,
    )
    expect(html).toContain('ข้อที่ใช้และผู้อนุมัติ')
    expect(html).toContain('ใช้ข้อ PR-01')
    expect(html).toContain('ผู้จัดการฝ่าย (DM)')
    expect(html).not.toContain('ฉบับที่มีผล')
    expect(html).not.toContain('ผู้อนุมัติเดิม')
  })
})

describe('the send forms tick the boundary table only when the page shows one (FR-DOA-009 AC3, drafter side)', () => {
  it('a page without a table sends no tick, never stops for one, and a refusal for it is said in the form', () => {
    expect(boundaryTickValue(null, false)).toBeNull()
    expect(boundaryTickMissing(null, false)).toBe(false)
    expect(boundaryRefusalAt(null)).toBe('FORM')
    expect(boundaryTickValue('boundaries', false)).toBe(false)
    expect(boundaryTickValue('boundaries', true)).toBe(true)
    expect(boundaryTickMissing('boundaries', false)).toBe(true)
    expect(boundaryTickMissing('boundaries', true)).toBe(false)
    expect(boundaryRefusalAt('boundaries')).toBe('TICK')
  })

  const panel = (props: Partial<SubmitDoaPanelProps>) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="th" messages={th} timeZone="Asia/Bangkok">
        <SubmitDoaPanel versionId="v2" warnings={[]} approvers={[]} boundaryTableId="boundaries" submit={async () => ({ ok: true, assigneeMemberId: 'm' })} {...props} />
      </NextIntlClientProvider>,
    )

  it('the normal send shows the tick and the link to the table only when the page has one', () => {
    const withTable = panel({})
    expect(withTable).toContain('ฉันตรวจตารางผลที่ขอบแล้ว ทุกยอดที่ขอบของช่วงไปหาผู้อนุมัติตามที่ตั้งใจ')
    expect(withTable).toContain('href="#boundaries"')
    const without = panel({ boundaryTableId: null })
    expect(without).not.toContain('ฉันตรวจตารางผลที่ขอบแล้ว')
    expect(without).not.toContain('type="checkbox"')
    expect(without).toContain('ส่งขออนุมัติเผยแพร่')
  })
})

const props: DoaEditorProps = {
  sourceVersionId: '0199a1b2-0000-7000-8000-0000000000f1',
  code: 'DOA-DEMO',
  sourceVersionNo: 1,
  nextVersionNo: 2,
  defaultEffectiveDate: '2026-11-01',
  minEffectiveDate: '2026-10-05',
  policy: { amountBasis: 'GROSS', selfApprovalPolicy: 'ESCALATE_NEXT_BAND', collapseDuplicateApprovers: true, stepUpThreshold: baht('100000.00'), approverMayReceive: false, requesterMayReceive: true },
  rules: table().map(({ code, documentType, band, steps }) => ({ code, documentType, band, steps })),
  positions: [
    { code: 'CEO', nameTh: 'ประธานเจ้าหน้าที่บริหาร', nameEn: null, scope: 'ORG' },
    { code: 'DM', nameTh: 'ผู้จัดการฝ่าย', nameEn: null, scope: 'DEPARTMENT' },
    { code: 'VP', nameTh: 'รองประธานสายงาน', nameEn: null, scope: 'DEPARTMENT' },
  ],
  members: [],
  save: async () => ({ ok: true, versionId: 'v2', code: 'DOA-DEMO', versionNo: 2 }),
}

describe('[FR-DOA-001/AC1] the editor opens on its first step: the rules of each document type as a table', () => {
  it('one line and one edit button per rule, money with two decimals, no page of fields', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="th" messages={th} timeZone="Asia/Bangkok">
        <DoaEditor {...props} />
      </NextIntlClientProvider>,
    )
    expect(html).toMatch(/<li aria-current="step"[^>]*>ขั้นที่ 1 ข้อและผู้อนุมัติ<\/li>/)
    expect(html).toContain('ขั้นที่ 2 นโยบายของฉบับ')
    expect(html).toContain('ขั้นที่ 3 วันมีผลและบันทึก')
    expect(html).toContain('คำขอซื้อ (PR)')
    expect(html).toContain('20,000.00')
    expect(html).toContain('ผู้จัดการฝ่าย (DM) ของแผนกที่ตั้งเบิก')
    expect(html).toContain('ประธานเจ้าหน้าที่บริหาร (CEO) ระดับองค์กร')
    expect(html).toContain('aria-label="แก้ข้อ PR-01"')
    expect(html).toContain('เพิ่มข้อของคำขอซื้อ (PR)')
    // Rows are edited one at a time: nothing to type on the first screen
    expect(html).not.toContain('<select')
    expect(html).not.toContain('<input')
  })

  it('a policy change has no amount: its table has no amount columns', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="th" messages={th} timeZone="Asia/Bangkok">
        <DoaEditor {...props} />
      </NextIntlClientProvider>,
    )
    // One <section> per document type, in DOC_TYPES order
    const section = (name: string) => html.split('<section').find((s) => s.includes(`>${name}</h3>`))!
    expect(section('คำขอซื้อ (PR)')).toContain('มากกว่า (บาท)')
    expect(section('คำขอซื้อ (PR)')).toContain('ไม่เกิน (บาท)')
    const doaChange = section('การเปลี่ยน DOA')
    expect(doaChange).toContain('aria-label="แก้ข้อ DOA-CHG-01"')
    expect(doaChange).not.toContain('มากกว่า (บาท)')
    expect(doaChange).not.toContain('ไม่เกิน (บาท)')
    expect(doaChange).not.toContain('ไม่ขึ้นกับยอด')
  })
})
