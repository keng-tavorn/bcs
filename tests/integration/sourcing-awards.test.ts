import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { portalCtx } from '@/server/portal/session'
import { awardCardCounts } from '@/server/queries/award-card'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import {
  awardWorkspace,
  cancelAward,
  closeRfxAt,
  createAward,
  createRfx,
  disqualifyBid,
  getAwardTaskView,
  inviteToRfx,
  openRfx,
  recordBidOnBehalf,
  registerSupplierRiskProvider,
  setScorecard,
  submitAward,
  submitBid,
  submitScores,
  updateAward,
} from '@/server/services/sourcing'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'
import { p2p } from '../support/p2p'
import { stepUpForTask } from '../support/pin'

// S10-10 (FR-SRC-204 AC2 AC3 AC5 · FR-INT-201 AC5 · BR-RFX-12 · BR-SOD-13 · GC-SRC-21 22 23 · GC-DOA-75 76) on real Postgres,
// with the phase-2 organization (DOA-P2: RA-01 to the procurement manager up to 500,000.00 with VAT, RA-02 the COO).
// Scene 9 from two approved requests of 8 and 5 tonnes at 23,800.00: three bids (23,150.00 · 23,500.00 · 25,000.00 with
// VAT) scored 95.38 · 95.11 · 89.57. The award to the first is 300,950.00 + VAT 21,066.50 = 322,016.50 and goes to
// dm_proc under RA-01; approved, the RFx is AWARDED (the POs are S10-11's). The reasons BR-RFX-12 asks for — not the
// first, split, foreign, expired, flagged or short of documents (read live at the send), above the requests, RISK —
// the SoD of BR-SOD-13 at routing and at deciding, the route's department, the capability, a return, a rejection and
// a cancel.

const MON = new Date('2026-11-02T02:00:00Z') // Monday 09:00 Bangkok
const CLOSES = '2026-11-05T10:00:00Z'
const AFTER = new Date('2026-11-05T10:00:00Z')
const SEND = new Date('2026-11-06T03:00:00Z') // Friday 10:00
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
let seq = 700
function taxId(): string {
  const body = `01055${String(seq++).padStart(7, '0')}`
  const sum = [...body].reduce((a, d, i) => a + Number(d) * (13 - i), 0)
  return body + String((11 - (sum % 11)) % 10)
}
const SCENE_9 = [
  { name: 'SP0023 ชลบุรีภัณฑ์', priceIncludesVat: false, unit: '23150.00', DELIVERY: [85, 90], QUALITY: [90, 90] },
  { name: 'SP0029 สหมิตร', priceIncludesVat: false, unit: '23500.00', DELIVERY: [90, 90], QUALITY: [90, 90] },
  { name: 'SP0024 เหล็กไทย', priceIncludesVat: true, unit: '25000.00', DELIVERY: [70, 75], QUALITY: [80, 80] },
] as const
const CRITERIA = [
  { code: 'PRICE', nameTh: 'ราคา', weightBp: 6000, kind: 'PRICE' as const },
  { code: 'DELIVERY', nameTh: 'การส่งมอบ', weightBp: 2500, kind: 'QUALITY' as const },
  { code: 'QUALITY', nameTh: 'คุณภาพ', weightBp: 1500, kind: 'QUALITY' as const },
]

let org: DoaOrg
let flow: ReturnType<typeof p2p>
let budgetLineId: string
beforeAll(async () => {
  org = await createP2Org()
  await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'SOURCING', enabled: true, enabledAt: new Date('2026-01-01T00:00:00Z'), contractRef: 'TEST-S10', reason: 'องค์กรทดสอบจัดหา' } })
  const at = new Date('2026-01-01T00:00:00Z')
  // the auditor reads prices (sourcing.view ORG); vp_ops and admin2 are procurement besides proc_officer
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: at } })
  for (const code of ['vp_ops', 'admin2']) await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member[code]!, role: 'PROCUREMENT', grantedAt: at } })
  const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).settings as Record<string, unknown>
  await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...settings, sourcing: { allowVatInclusiveBids: true } } } })
  flow = p2p(org, MON)
  budgetLineId = await flow.fundedLine(20_000_000n)
}, 180_000)

afterEach(async () => {
  // a test that switched RISK on leaves it off, with no provider answering
  await prisma.orgModule.deleteMany({ where: { organizationId: org.organizationId, module: 'RISK' } })
  registerSupplierRiskProvider(async () => null)
})

const as = (code: string, now = SEND) => org.ctxOf(code, now)
const proc = (now = SEND) => as('proc_officer', now)
const version = async (id: string) => (await prisma.rfxEvent.findUniqueOrThrow({ where: { id } })).version
const awardOf = (id: string) => prisma.awardDecision.findUniqueOrThrow({ where: { id }, include: { lines: { include: { rfxLine: true }, orderBy: { rfxLine: { lineNo: 'asc' } } } } })
const openTaskOf = (awardId: string) => prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectType: 'AWARD_DECISION', subjectId: awardId } } } })
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]

async function decide(awardId: string, decision: 'APPROVE' | 'RETURN' | 'REJECT', reason?: string) {
  const task = (await openTaskOf(awardId))!
  await stepUpForTask(task.id, task.assigneeMemberId)
  return decideTask(as(codeOf(task.assigneeMemberId)), { taskId: task.id, decision, ...(reason ? { reason } : {}) }, key())
}

/** Lines of approved requests in the pool, in category STEEL, each request on a site of its own and charged as given */
async function poolLines(lines: ReadonlyArray<{ quantity: string; unitPrice: string; department?: string }>): Promise<string[]> {
  const ids: string[] = []
  for (const l of lines) {
    const request = await flow.approvedRequest(budgetLineId, [{ quantity: l.quantity, unitPrice: l.unitPrice }])
    const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 6)}`, nameTh: 'ไซต์', address: 'ถนนทดสอบ' } })
    await prisma.request.update({ where: { id: request.id }, data: { deliverySiteId: site.id, ...(l.department ? { chargedDepartmentId: org.department[l.department]! } : {}) } })
    await prisma.requestLine.updateMany({ where: { requestId: request.id }, data: { categoryCode: 'STEEL' } })
    ids.push(request.lines[0]!.id)
  }
  return ids
}

async function party(name: string) {
  const s = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: name, taxId: taxId(), isVatRegistered: true, branchCode: '00000', portalEnabled: true } })
  const contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: s.id, nameTh: `ติดต่อ ${name}`, email: `s-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true } })
  return { supplier: s, ctx: () => portalCtx(org.organizationId, contact, MON) }
}

interface SceneOptions {
  readonly evaluators?: readonly string[]
  /** The requests' unit prices before VAT of the 8 and the 5 tonnes */
  readonly requestPrices?: readonly [string, string]
  readonly departments?: readonly [string | undefined, string | undefined]
  /** Who records the third bid (with VAT) on its supplier's behalf; by default its supplier sends it */
  readonly onBehalf?: string
  /** false: closed but not scored */
  readonly scored?: boolean
}

/** Scene 9: an RFQ from two request lines, three bids, closed and scored by two evaluators (dm_it and vp_sup by default) */
async function scene(o: SceneOptions = {}) {
  const prices = o.requestPrices ?? ['23800.00', '23800.00']
  const requestLineIds = await poolLines([
    { quantity: '8', unitPrice: prices[0], ...(o.departments?.[0] ? { department: o.departments[0] } : {}) },
    { quantity: '5', unitPrice: prices[1], ...(o.departments?.[1] ? { department: o.departments[1] } : {}) },
  ])
  const { rfxEventId } = ok(await createRfx(proc(MON), { kind: 'RFQ', title: 'เหล็กข้ออ้อย DB12', description: 'ขอราคา 13 ตัน', allowVatInclusiveBids: true, source: { kind: 'REQUEST_LINES', requestLineIds } }, key()))
  const parties = []
  for (const s of SCENE_9) parties.push({ ...s, ...(await party(s.name)) })
  for (const p of parties) ok(await inviteToRfx(proc(MON), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: p.supplier.id }, key()))
  const evaluators = o.evaluators ?? ['dm_it', 'vp_sup']
  ok(await setScorecard(proc(MON), { rfxEventId, expectedVersion: await version(rfxEventId), criteria: CRITERIA, evaluatorMemberIds: evaluators.map((c) => org.member[c]!) }, key()))
  ok(await openRfx(proc(MON), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: CLOSES }, key()))
  const lines = (await prisma.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' } })).map((l) => l.id)
  const bids: string[] = []
  for (const [i, p] of parties.entries()) {
    const priced = lines.map((rfxLineId) => ({ rfxLineId, offered: true, unitPrice: p.unit }))
    if (o.onBehalf && i === 2) {
      const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'quote.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member[o.onBehalf]! } })
      bids.push(ok(await recordBidOnBehalf(as(o.onBehalf, MON), { rfxEventId, supplierId: p.supplier.id, fileId: file.id, priceIncludesVat: p.priceIncludesVat, lines: priced }, key())).bidId)
    } else bids.push(ok(await submitBid(p.ctx(), { rfxEventId, priceIncludesVat: p.priceIncludesVat, lines: priced }, key())).bidId)
  }
  await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
  if (o.scored !== false) {
    for (const [i, code] of evaluators.entries()) {
      const entries = bids.flatMap((bidId, b) => (['DELIVERY', 'QUALITY'] as const).map((criterionCode) => ({ bidId, criterionCode, score: SCENE_9[b]![criterionCode][i as 0 | 1] })))
      ok(await submitScores(as(code, AFTER), { rfxEventId, entries }, key()))
    }
  }
  return { rfxEventId, bids, parties, lines, requestLineIds }
}

/** Every line to one bid */
const allTo = (lines: readonly string[], bidId: string) => lines.map((rfxLineId) => ({ rfxLineId, bidId }))

describe('[FR-SRC-204/AC2] [GC-SRC-21] [GC-DOA-75] scene 9 awarded to the first ranked: 322,016.50 to the procurement manager', () => {
  it('made without a reason, numbered at the send, routed under RA-01 to dm_proc with the ranking frozen; approved, the RFx is AWARDED', async () => {
    const { rfxEventId, bids, lines } = await scene()
    const made = ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!) }, key()))
    expect(made.reasonCodes).toEqual([])
    const draft = await awardOf(made.awardDecisionId)
    expect(draft).toMatchObject({ status: 'DRAFT', number: null, netSatang: 30_095_000n, vatSatang: 2_106_650n, grossSatang: 32_201_650n, isSplit: false, topScoreBidId: bids[0], lowestBidId: bids[0], sourceApprovedNetSatang: 30_940_000n })
    expect(draft.lines.map((l) => [l.rfxLine.lineNo, l.bidId, l.unitPriceSatang, l.lineNetSatang, l.vatRateBp])).toEqual([
      [1, bids[0], 2_315_000n, 18_520_000n, 700],
      [2, bids[0], 2_315_000n, 11_575_000n, 700],
    ])
    // one open award per RFx
    expect(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[1]!), reason: 'อีกผล' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'AWARD_OPEN' } } })

    // dm_proc holds no ORG role here: the prices are not theirs to read until the award's task is (review 1)
    expect(await awardWorkspace(as('dm_proc'), rfxEventId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const sent = ok(await submitAward(proc(), { awardDecisionId: made.awardDecisionId, version: draft.version }, key()))
    expect(sent.number).toMatch(/^AWD-2569-\d{5}$/)
    expect(ok(await awardWorkspace(as('dm_proc'), rfxEventId))).toMatchObject({ canAward: false, award: { id: made.awardDecisionId, status: 'PENDING_APPROVAL' } })
    const award = await awardOf(made.awardDecisionId)
    expect(award).toMatchObject({ status: 'PENDING_APPROVAL', number: sent.number, submittedById: org.member.proc_officer, submittedAt: SEND, amountBasis: 'GROSS', poStatus: 'NOT_APPLICABLE', currentRouteId: sent.routeId })
    expect(award.rankingSnapshot).toMatchObject({ topScoreBidId: bids[0], lowestBidId: bids[0], invited: 3, submitted: 3, bids: [{ bidId: bids[0], rank: 1, totalBp: 9538 }, { bidId: bids[1], rank: 2, totalBp: 9511 }, { bidId: bids[2], rank: 3, totalBp: 8957 }] })
    const route = await prisma.approvalRoute.findUniqueOrThrow({ where: { id: sent.routeId } })
    expect(route).toMatchObject({ subjectType: 'AWARD_DECISION', ruleCode: 'RA-01', amountSatang: 32_201_650n })
    expect((await openTaskOf(award.id))!.assigneeMemberId).toBe(org.member.dm_proc)
    const submitted = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: award.id, type: 'award.submitted' } })
    expect(submitted.data).toMatchObject({ rfxEventId, number: sent.number, netSatang: '30095000', vatSatang: '2106650', isSplit: false, reasonCodes: [], requestingDepartmentId: org.department.CON, poStatus: 'NOT_APPLICABLE' })
    // a bid is not disqualified while the award is open (BR-RFX-10)
    expect(await disqualifyBid(proc(), { bidId: bids[2]!, reason: 'เอกสารไม่ครบ' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'AWARD_OPEN' } } })

    // what the approver sees: the comparison in short, the winner, the counts; the LINE card counts only
    const facts = (await getAwardTaskView(as('dm_proc'), award.id))!
    expect(facts).toMatchObject({ number: sent.number, net: '300950.00', vat: '21066.50', gross: '322016.50', reasonCodes: [], invited: 3, submitted: 3, sourceApprovedNet: '309400.00', aboveRequestBy: null })
    expect(facts.bids.map((b) => [b.rank, b.net, b.winner])).toEqual([
      [1, '300950.00', true],
      [2, '305500.00', false],
      [3, '303738.32', false],
    ])
    expect(facts.winners).toMatchObject([{ net: '300950.00', vat: '21066.50', lineCount: 2, foreign: false, requiredDocumentsOk: true, bidExpired: false }])
    expect(await awardCardCounts(org.organizationId, award.id)).toEqual({ bids: 3, winners: 1, notLowest: false })

    expect(ok(await decide(award.id, 'APPROVE'))).toMatchObject({ documentStatus: 'APPROVED' })
    expect(await awardOf(award.id)).toMatchObject({ status: 'APPROVED', decidedAt: SEND, poStatus: 'NOT_APPLICABLE' })
    expect(await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).toMatchObject({ status: 'AWARDED', awardDecisionId: award.id })
    const approved = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: award.id, type: 'award.approved' } })
    expect(approved.data).toMatchObject({ rfxEventId, number: sent.number, onBehalfOf: org.member.dm_proc, purchaseOrderIds: [] })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, aggregateId: rfxEventId, type: 'rfx.awarded' } })).toBe(1)
  })
})

describe('[FR-SRC-204/AC2] [BR-RFX-12] the reasons an award needs', () => {
  it('[GC-SRC-23] split to the first and the second: not the first on line 2, split, VAT per supplier — refused without a reason, kept with one', async () => {
    const { rfxEventId, bids, lines } = await scene()
    const split = [
      { rfxLineId: lines[0]!, bidId: bids[0]! },
      { rfxLineId: lines[1]!, bidId: bids[1]! },
    ]
    expect(await createAward(proc(), { rfxEventId, lines: split }, key())).toMatchObject({ ok: false, error: { code: 'AWARD_REASON_REQUIRED', details: { reason: 'NOT_TOP_SCORE', reasonCodes: ['NOT_TOP_SCORE', 'SPLIT'] } } })
    expect(await prisma.awardDecision.count({ where: { rfxEventId } })).toBe(0)
    const made = ok(await createAward(proc(), { rfxEventId, lines: split, reason: 'แบ่งมอบเพื่อให้ส่งทันทั้งสองไซต์' }, key()))
    expect(made.reasonCodes).toEqual(['NOT_TOP_SCORE', 'SPLIT'])
    // 185,200 → 12,964.00 and 117,500 → 8,225.00: 302,700.00 + 21,189.00 = 323,889.00 (GC-SRC-23)
    expect(await awardOf(made.awardDecisionId)).toMatchObject({ isSplit: true, netSatang: 30_270_000n, vatSatang: 2_118_900n, grossSatang: 32_388_900n, reasonCodes: ['NOT_TOP_SCORE', 'SPLIT'], reason: 'แบ่งมอบเพื่อให้ส่งทันทั้งสองไซต์' })
    // a reason taken away is refused again; the same reason again changes nothing
    const award = await awardOf(made.awardDecisionId)
    expect(await updateAward(proc(), { awardDecisionId: award.id, version: award.version, reason: null }, key())).toMatchObject({ ok: false, error: { code: 'AWARD_REASON_REQUIRED' } })
    expect(await updateAward(proc(), { awardDecisionId: award.id, version: award.version, lines: split, reason: 'แบ่งมอบเพื่อให้ส่งทันทั้งสองไซต์' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'UNCHANGED' } } })
    // line 2 went to 117,500.00 where 115,750.00 was offered: not the lowest line by line, whatever the totals (review 5)
    ok(await submitAward(proc(), { awardDecisionId: award.id, version: award.version }, key()))
    expect((await awardOf(award.id)).rankingSnapshot).toMatchObject({ lowestLinesNet: '300950.00' })
    expect(await awardCardCounts(org.organizationId, award.id)).toEqual({ bids: 3, winners: 2, notLowest: true })
  })

  it('the winner flagged CEASED and a required document missing after the invite: the send reads them live and asks the reason (SUPPLIER_FLAGGED · DOCS_INCOMPLETE)', async () => {
    const { rfxEventId, bids, lines, parties } = await scene()
    const made = ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!) }, key()))
    await prisma.supplier.update({ where: { id: parties[0]!.supplier.id }, data: { registryFlag: 'CEASED', registryFlaggedAt: AFTER } })
    const type = await prisma.supplierDocumentType.create({ data: { organizationId: org.organizationId, code: `CERT-${randomUUID().slice(0, 6)}`, nameTh: 'หนังสือรับรองบริษัท', nameEn: 'Company certificate', appliesTo: ['JURISTIC'], required: true } })
    try {
      let award = await awardOf(made.awardDecisionId)
      expect(await submitAward(proc(), { awardDecisionId: award.id, version: award.version }, key())).toMatchObject({ ok: false, error: { code: 'AWARD_REASON_REQUIRED', details: { reason: 'SUPPLIER_FLAGGED', reasonCodes: ['SUPPLIER_FLAGGED', 'DOCS_INCOMPLETE'] } } })
      expect(await prisma.awardDecision.findUniqueOrThrow({ where: { id: award.id } })).toMatchObject({ status: 'DRAFT', number: null })
      ok(await updateAward(proc(), { awardDecisionId: award.id, version: award.version, reason: 'ผู้ขายรายเดียวที่ส่งทันกำหนด ตรวจสถานะกับกรมพัฒน์แล้ว' }, key()))
      award = await awardOf(made.awardDecisionId)
      ok(await submitAward(proc(), { awardDecisionId: award.id, version: award.version }, key()))
      expect(await awardOf(award.id)).toMatchObject({ status: 'PENDING_APPROVAL', reasonCodes: ['SUPPLIER_FLAGGED', 'DOCS_INCOMPLETE'] })
      const facts = (await getAwardTaskView(as('dm_proc'), award.id))!
      expect(facts.winners).toMatchObject([{ registryFlag: 'CEASED', requiredDocumentsOk: false }])
    } finally {
      await prisma.supplierDocumentType.update({ where: { id: type.id }, data: { active: false } })
    }
  })

  it('a flag that arises after the reason was given is answered before the send: the reason is given again (review 2 · BR-RFX-12 จ)', async () => {
    const { rfxEventId, bids, lines, parties } = await scene()
    const made = ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[1]!), reason: 'รายที่สองส่งของได้เร็วกว่า' }, key()))
    expect(made.reasonCodes).toEqual(['NOT_TOP_SCORE'])
    await prisma.supplier.update({ where: { id: parties[1]!.supplier.id }, data: { registryFlag: 'VAT_CANCELLED', registryFlaggedAt: AFTER } })
    let award = await awardOf(made.awardDecisionId)
    expect(await submitAward(proc(), { awardDecisionId: award.id, version: award.version }, key())).toMatchObject({ ok: false, error: { code: 'AWARD_REASON_REQUIRED', details: { reason: 'SUPPLIER_FLAGGED', arisen: ['SUPPLIER_FLAGGED'], reasonCodes: ['NOT_TOP_SCORE', 'SUPPLIER_FLAGGED'] } } })
    ok(await updateAward(proc(), { awardDecisionId: award.id, version: award.version, reason: 'รายที่สองส่งของได้เร็วกว่า ตรวจแล้วว่าทะเบียน VAT ถูกยกเลิก ราคาไม่รวม VAT' }, key()))
    award = await awardOf(made.awardDecisionId)
    expect(award.reasonCodes).toEqual(['NOT_TOP_SCORE', 'SUPPLIER_FLAGGED'])
    ok(await submitAward(proc(), { awardDecisionId: award.id, version: award.version }, key()))
  })

  it('above what the requests approved (20,000.00 a tonne → 260,000.00): ABOVE_REQUEST with the difference in the facts', async () => {
    const { rfxEventId, bids, lines } = await scene({ requestPrices: ['20000.00', '20000.00'] })
    expect(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!) }, key())).toMatchObject({ ok: false, error: { code: 'AWARD_REASON_REQUIRED', details: { reasonCodes: ['ABOVE_REQUEST'] } } })
    const made = ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!), reason: 'ราคาเหล็กขึ้นหลังขออนุมัติ' }, key()))
    expect(await awardOf(made.awardDecisionId)).toMatchObject({ sourceApprovedNetSatang: 26_000_000n, reasonCodes: ['ABOVE_REQUEST'] })
    expect((await getAwardTaskView(as('proc_officer'), made.awardDecisionId))!).toMatchObject({ sourceApprovedNet: '260000.00', aboveRequestBy: '40950.00' })
  })

  it('[FR-INT-201/AC5] a foreign winner needs a reason; a winner who quoted with VAT keeps its amount before VAT and waits for its prices (PENDING_PRICE · OQ-212)', async () => {
    const { rfxEventId, bids, lines, parties } = await scene()
    await prisma.supplier.update({ where: { id: parties[1]!.supplier.id }, data: { isForeign: true } })
    expect(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[1]!) }, key())).toMatchObject({ ok: false, error: { details: { reasonCodes: ['NOT_TOP_SCORE', 'FOREIGN'] } } })
    await prisma.supplier.update({ where: { id: parties[1]!.supplier.id }, data: { isForeign: false } })
    // the third quoted 325,000.00 with VAT: 303,738.32 before VAT, shared over the lines as the comparison holds it
    const made = ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[2]!), reason: 'ส่งของได้เร็วที่สุด' }, key()))
    const award = await awardOf(made.awardDecisionId)
    expect(award.lines.reduce((s, l) => s + l.lineNetSatang, 0n)).toBe(30_373_832n)
    // until the winner confirms, a line holds the highest price before VAT it may confirm: ⌊2,500,000 × 10000 ÷ 10700⌋
    expect(award.lines.map((l) => l.unitPriceSatang)).toEqual([2_336_448n, 2_336_448n])
    expect(award).toMatchObject({ netSatang: 30_373_832n, vatSatang: 2_126_168n, grossSatang: 32_500_000n, reasonCodes: ['NOT_TOP_SCORE'] })
    ok(await submitAward(proc(), { awardDecisionId: award.id, version: award.version }, key()))
    // the send says it (its event, the approver's facts); the column follows the approval (award_decision_shape)
    expect(await awardOf(award.id)).toMatchObject({ status: 'PENDING_APPROVAL', poStatus: 'NOT_APPLICABLE' })
    expect((await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: award.id, type: 'award.submitted' } })).data).toMatchObject({ poStatus: 'PENDING_PRICE', reasonCodes: ['NOT_TOP_SCORE'] })
    expect((await getAwardTaskView(as('dm_proc'), award.id))!).toMatchObject({ poStatus: 'PENDING_PRICE', winners: [{ priceIncludesVat: true }] })
    expect(await awardCardCounts(org.organizationId, award.id)).toEqual({ bids: 3, winners: 1, notLowest: true })
    ok(await decide(award.id, 'APPROVE'))
    expect(await awardOf(award.id)).toMatchObject({ status: 'APPROVED', poStatus: 'PENDING_PRICE' })
  })

  it('a bid past its validity (30 days from 2 Nov: 2 Dec) is BID_EXPIRED on 3 Dec', async () => {
    const { rfxEventId, bids, lines } = await scene()
    expect(await createAward(proc(new Date('2026-12-03T03:00:00Z')), { rfxEventId, lines: allTo(lines, bids[0]!) }, key())).toMatchObject({ ok: false, error: { details: { reasonCodes: ['BID_EXPIRED'] } } })
    expect(ok(await createAward(proc(new Date('2026-12-02T03:00:00Z')), { rfxEventId, lines: allTo(lines, bids[0]!) }, key())).reasonCodes).toEqual([])
  })

  it('before the scores are revealed no award is made (NOT_REVEALED); a line twice or a bid not of the RFx is refused', async () => {
    const { rfxEventId, bids, lines } = await scene({ scored: false })
    expect(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!) }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'NOT_REVEALED' } } })
    const other = await scene()
    expect(await createAward(proc(), { rfxEventId: other.rfxEventId, lines: [...allTo(other.lines, other.bids[0]!), { rfxLineId: other.lines[0]!, bidId: other.bids[1]! }] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'DUPLICATE_LINE' } } })
    expect(await createAward(proc(), { rfxEventId: other.rfxEventId, lines: allTo(other.lines, bids[0]!) }, key())).toMatchObject({ ok: false, error: { details: { reason: 'BID' } } })
  })
})

describe('[FR-SRC-204/AC2] [BR-RFX-12 จ] RISK switched on: the winner read through the provider', () => {
  async function riskOn() {
    await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'RISK', enabled: true, enabledAt: new Date('2026-01-01T00:00:00Z'), contractRef: 'TEST-S10', reason: 'ทดสอบด่านความเสี่ยง' } })
  }

  it('a HIGH winner not assessed is RISK_NOT_CLEARED; an open override or CURRENT clears it; with RISK off nothing is asked', async () => {
    const { rfxEventId, bids, lines, parties } = await scene()
    const winner = parties[0]!.supplier.id
    let status: { tier: string; status: string; openOverrideId: string | null } = { tier: 'HIGH', status: 'OVERDUE', openOverrideId: null }
    registerSupplierRiskProvider(async (_tx, _org, supplierId) => (supplierId === winner ? { blocked: true, ...status } : { tier: 'LOW', blocked: false, status: 'CURRENT' }))
    // RISK off: the provider is not asked
    expect(ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!) }, key())).reasonCodes).toEqual([])
    const draft = await prisma.awardDecision.findFirstOrThrow({ where: { rfxEventId, status: 'DRAFT' } })
    ok(await cancelAward(proc(), { awardDecisionId: draft.id, version: draft.version, reason: 'ทดสอบใหม่' }, key()))
    await riskOn()
    expect(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!) }, key())).toMatchObject({ ok: false, error: { code: 'AWARD_REASON_REQUIRED', details: { reasonCodes: ['RISK_NOT_CLEARED'] } } })
    status = { tier: 'HIGH', status: 'OVERDUE', openOverrideId: randomUUID() }
    expect(ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!) }, key())).reasonCodes).toEqual([])
    const second = await prisma.awardDecision.findFirstOrThrow({ where: { rfxEventId, status: 'DRAFT' } })
    // the send reads it again: the override closed meanwhile
    status = { tier: 'HIGH', status: 'OVERDUE', openOverrideId: null }
    expect(await submitAward(proc(), { awardDecisionId: second.id, version: second.version }, key())).toMatchObject({ ok: false, error: { details: { reasonCodes: ['RISK_NOT_CLEARED'] } } })
    status = { tier: 'HIGH', status: 'CURRENT', openOverrideId: null }
    ok(await submitAward(proc(), { awardDecisionId: second.id, version: second.version }, key()))
  })

  it('a CEASED winner with RISK on is refused SUPPLIER_FLAGGED REGISTRY_CEASED even with a reason; a policy that lets registry flags through asks the reason instead', async () => {
    const { rfxEventId, bids, lines, parties } = await scene()
    await prisma.supplier.update({ where: { id: parties[0]!.supplier.id }, data: { registryFlag: 'CEASED', registryFlaggedAt: AFTER } })
    const policy: { blocks?: boolean } = {}
    registerSupplierRiskProvider(async () => ({ tier: 'LOW', blocked: false, status: 'CURRENT', ...(policy.blocks === undefined ? {} : { registryFlagBlocks: policy.blocks }) }))
    // RISK off: CEASED asks the reason only
    expect(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!) }, key())).toMatchObject({ ok: false, error: { code: 'AWARD_REASON_REQUIRED', details: { reasonCodes: ['SUPPLIER_FLAGGED'] } } })
    await riskOn()
    expect(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!), reason: 'ยืนยันมอบ' }, key())).toMatchObject({ ok: false, error: { code: 'SUPPLIER_FLAGGED', details: { reason: 'REGISTRY_CEASED', flag: 'CEASED' } } })
    policy.blocks = false
    expect(ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!), reason: 'นโยบายให้มอบได้พร้อมเหตุผล' }, key())).reasonCodes).toEqual(['SUPPLIER_FLAGGED'])
  })
})

describe('[FR-SRC-204/AC5] [BR-SOD-13] [GC-DOA-76] who may not approve an award', () => {
  it('kept off the route and refused at deciding: the RFx creator, an evaluator, a requester of a source line, who recorded a bid for a supplier (BR-SOD-13) and the submitter (BR-SOD-01)', async () => {
    // the RFx made by proc_officer, the third bid recorded by admin2, the award made and sent by vp_ops
    const { rfxEventId, bids, lines } = await scene({ onBehalf: 'admin2' })
    const made = ok(await createAward(as('vp_ops'), { rfxEventId, lines: allTo(lines, bids[0]!) }, key()))
    const draft = await awardOf(made.awardDecisionId)
    ok(await submitAward(as('vp_ops'), { awardDecisionId: draft.id, version: draft.version }, key()))
    const task = (await openTaskOf(draft.id))!
    expect(task.assigneeMemberId).toBe(org.member.dm_proc)
    for (const [code, rule] of [
      ['proc_officer', 'BR-SOD-13'],
      ['dm_it', 'BR-SOD-13'],
      ['req_con', 'BR-SOD-13'],
      ['admin2', 'BR-SOD-13'],
      ['vp_ops', 'BR-SOD-01'],
    ] as const) {
      await prisma.approvalTask.update({ where: { id: task.id }, data: { assigneeMemberId: org.member[code]! } })
      expect(await decideTask(as(code), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule } } })
      const blocked = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'security.sod_blocked', aggregateId: draft.id, actorMemberId: org.member[code]! } })
      expect(blocked.data).toMatchObject({ rule, subjectType: 'AWARD_DECISION', subjectId: draft.id })
    }
    expect(await prisma.awardDecision.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: 'PENDING_APPROVAL' })
    await prisma.approvalTask.update({ where: { id: task.id }, data: { assigneeMemberId: org.member.dm_proc! } })
  })

  it('the procurement manager who scored the bids is skipped to the COO under RA-02 (escalated from RA-01)', async () => {
    const { rfxEventId, bids, lines } = await scene({ evaluators: ['dm_proc', 'dm_it'] })
    const made = ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!) }, key()))
    const sent = ok(await submitAward(proc(), { awardDecisionId: made.awardDecisionId, version: (await awardOf(made.awardDecisionId)).version }, key()))
    expect(await prisma.approvalRoute.findUniqueOrThrow({ where: { id: sent.routeId } })).toMatchObject({ ruleCode: 'RA-02', escalatedFromRuleCode: 'RA-01' })
    expect((await openTaskOf(made.awardDecisionId))!.assigneeMemberId).toBe(org.member.coo)
  })
})

describe('[FR-SRC-204/AC2] [BR-RFX-12] the department of the route', () => {
  it('source lines of CON and IT route in the creator\'s department PROC: a rule by the department\'s DM reaches dm_proc, not dm_con or dm_it', async () => {
    const rules = await prisma.doaRule.findMany({ where: { organizationId: org.organizationId, documentType: 'RFX_AWARD' } })
    const ra01 = rules.find((r) => r.code === 'RA-01')!
    const steps = ra01.steps as Array<Record<string, unknown>>
    await prisma.doaRule.update({ where: { id: ra01.id }, data: { steps: steps.map((s) => ({ ...s, approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' } })) } })
    try {
      const { rfxEventId, bids, lines } = await scene({ departments: ['CON', 'IT'] })
      expect(await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).toMatchObject({ requestingDepartmentId: org.department.PROC })
      const made = ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!) }, key()))
      ok(await submitAward(proc(), { awardDecisionId: made.awardDecisionId, version: (await awardOf(made.awardDecisionId)).version }, key()))
      expect((await openTaskOf(made.awardDecisionId))!.assigneeMemberId).toBe(org.member.dm_proc)
      const facts = (await getAwardTaskView(as('dm_proc'), made.awardDecisionId))!
      expect(facts.requestingDepartment?.code).toBe('PROC')
      expect(facts.sourceDepartments.map((d) => d.code).sort()).toEqual(['CON', 'IT'])
    } finally {
      await prisma.doaRule.update({ where: { id: ra01.id }, data: { steps: steps as object[] } })
    }
  })

  it('a DOA version without the RA rules refuses the send DOA_NOT_CONFIGURED and writes nothing', async () => {
    const { rfxEventId, bids, lines } = await scene()
    const made = ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!) }, key()))
    const rules = await prisma.doaRule.findMany({ where: { organizationId: org.organizationId, documentType: 'RFX_AWARD' } })
    await prisma.doaRule.deleteMany({ where: { id: { in: rules.map((r) => r.id) } } })
    try {
      expect(await submitAward(proc(), { awardDecisionId: made.awardDecisionId, version: (await awardOf(made.awardDecisionId)).version }, key())).toMatchObject({ ok: false, error: { code: 'DOA_NOT_CONFIGURED' } })
      expect(await prisma.awardDecision.findUniqueOrThrow({ where: { id: made.awardDecisionId } })).toMatchObject({ status: 'DRAFT', number: null })
      expect(await prisma.approvalRoute.count({ where: { subjectType: 'AWARD_DECISION', subjectId: made.awardDecisionId } })).toBe(0)
    } finally {
      for (const r of rules) await prisma.doaRule.create({ data: { id: r.id, organizationId: r.organizationId, doaVersionId: r.doaVersionId, code: r.code, documentType: r.documentType, priority: r.priority, when: r.when as object, steps: r.steps as object[] } })
    }
  })
})

describe('[sourcing.award] [FR-SRC-204/AC3] who makes an award, and its return, rejection and cancel', () => {
  it('finance, an evaluator, an auditor and a requester may not make an award; a requester reads none of it; a question to the submitter is refused (VALIDATION_FAILED SUBJECT)', async () => {
    const { rfxEventId, bids, lines } = await scene()
    for (const code of ['fin_officer', 'dm_it', 'auditor', 'req_con']) {
      expect(await createAward(as(code), { rfxEventId, lines: allTo(lines, bids[0]!) }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await awardWorkspace(as('req_con'), rfxEventId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(ok(await awardWorkspace(as('auditor'), rfxEventId))).toMatchObject({ canAward: false, award: null })
    const made = ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!) }, key()))
    const workspace = ok(await awardWorkspace(proc(), rfxEventId))
    expect(workspace).toMatchObject({ canAward: true, award: { id: made.awardDecisionId, status: 'DRAFT' }, route: { kind: 'ROUTE', ruleCode: 'RA-01', approvers: [{ id: org.member.dm_proc }] } })
    ok(await submitAward(proc(), { awardDecisionId: made.awardDecisionId, version: (await awardOf(made.awardDecisionId)).version }, key()))
    const task = (await openTaskOf(made.awardDecisionId))!
    expect(await requestInfo(as('dm_proc'), { taskId: task.id, question: 'ขอใบเสนอราคาฉบับเต็ม' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SUBJECT' } } })
  })

  it('returned: the submitter hears of it, changes it and sends it again with the same number on a new route; rejected: the RFx stays and a new award is made; cancelled while pending: its route is cancelled', async () => {
    const { rfxEventId, bids, lines } = await scene()
    const made = ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!) }, key()))
    const first = ok(await submitAward(proc(), { awardDecisionId: made.awardDecisionId, version: (await awardOf(made.awardDecisionId)).version }, key()))
    ok(await decide(made.awardDecisionId, 'RETURN', 'ขอแนบใบเสนอราคาของรายที่สอง'))
    expect(await awardOf(made.awardDecisionId)).toMatchObject({ status: 'RETURNED', currentRouteId: null })
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, recipientMemberId: org.member.proc_officer!, templateKey: 'award.decided' } })).toBeGreaterThan(0)
    const returned = await awardOf(made.awardDecisionId)
    ok(await updateAward(proc(), { awardDecisionId: returned.id, version: returned.version, lines: allTo(lines, bids[1]!), reason: 'ผู้อนุมัติขอให้พิจารณารายที่สอง', contractRef: 'CT-2569-021' }, key()))
    // a returned award shows its changed lines live, not what was sent before
    expect((await getAwardTaskView(proc(), returned.id))!).toMatchObject({ status: 'RETURNED', net: '305500.00', reasonCodes: ['NOT_TOP_SCORE'] })
    const again = ok(await submitAward(proc(), { awardDecisionId: returned.id, version: (await awardOf(returned.id)).version }, key()))
    expect(again.number).toBe(first.number)
    expect(again.routeId).not.toBe(first.routeId)
    expect((await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: returned.id, type: 'award.submitted' }, orderBy: { seq: 'desc' } })).data).toMatchObject({ resubmitted: true })

    ok(await decide(returned.id, 'REJECT', 'ราคาสูงกว่าตลาด'))
    expect(await awardOf(returned.id)).toMatchObject({ status: 'REJECTED' })
    expect((await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).status).toBe('EVALUATING')
    // the award page offers a new award: no current one, procurement may make it
    expect(ok(await awardWorkspace(proc(), rfxEventId))).toMatchObject({ award: null, facts: null, canAward: true })
    const next = ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[1]!), reason: 'ผู้อนุมัติให้เลือกรายที่สอง' }, key()))
    ok(await submitAward(proc(), { awardDecisionId: next.awardDecisionId, version: (await awardOf(next.awardDecisionId)).version }, key()))
    const pending = await awardOf(next.awardDecisionId)
    const cancelled = ok(await cancelAward(proc(), { awardDecisionId: pending.id, version: pending.version, reason: 'เปลี่ยนแผนการซื้อ' }, key()))
    expect(cancelled.awardDecisionId).toBe(pending.id)
    expect(await awardOf(pending.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'เปลี่ยนแผนการซื้อ', currentRouteId: null })
    expect(await openTaskOf(pending.id)).toBeNull()
    expect(await prisma.approvalRoute.findFirstOrThrow({ where: { subjectType: 'AWARD_DECISION', subjectId: pending.id } })).toMatchObject({ status: 'CANCELLED' })
  })

  it('two sends of one version at once: one goes, the other is refused, and one route stands', async () => {
    const { rfxEventId, bids, lines } = await scene()
    const made = ok(await createAward(proc(), { rfxEventId, lines: allTo(lines, bids[0]!) }, key()))
    const v = (await awardOf(made.awardDecisionId)).version
    const both = await Promise.all([submitAward(proc(), { awardDecisionId: made.awardDecisionId, version: v }, key()), submitAward(as('vp_ops'), { awardDecisionId: made.awardDecisionId, version: v }, key())])
    expect(both.filter((r) => r.ok)).toHaveLength(1)
    expect(await prisma.approvalRoute.count({ where: { subjectType: 'AWARD_DECISION', subjectId: made.awardDecisionId } })).toBe(1)
  })
})
