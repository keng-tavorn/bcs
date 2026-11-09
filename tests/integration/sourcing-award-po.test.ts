import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { awardTotals } from '@/core/sourcing'
import { prisma } from '@/server/db/client'
import { portalRfx } from '@/server/portal/queries-rfx'
import { portalCtx } from '@/server/portal/session'
import { getPurchaseOrderView } from '@/server/queries/purchase-orders'
import { decideTask } from '@/server/services/approvals/decide'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { editDraftPo, submitPo } from '@/server/services/purchase-orders'
import { awardWorkspace, closeRfxAt, confirmNetPrices, createAward, createRfx, inviteToRfx, openRfx, releaseAwardPo, setScorecard, submitAward, submitBid, submitScores } from '@/server/services/sourcing'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'
import { p2p } from '../support/p2p'
import { stepUpForTask } from '../support/pin'

// S10-11 (FR-SRC-204 AC3 AC4 AC9 AC10 · BR-RFX-13 BR-RFX-14 · INV-RFX-04 INV-RFX-05 · GC-SRC-22 41 · ADR-206 · OQ-203 OQ-205
// OQ-212) on real Postgres, with the phase-2 organization: what an approved award makes. Scene 9 (8 and 5 tonnes from two
// requests on two sites, awarded to 23,150.00): two draft POs of 185,200.00 and 115,750.00 at the awarded price, made by
// the submitter through the pool's own consolidateInTx, sent under DOA PURCHASE_ORDER like any PO (PO-01 to the COO even
// when the COO approved the award). A winner without VAT keeps VAT 0 on its PO. A sibling line waits in the pool; two
// approvals at once make one set; an award above the requests still makes its POs, which the budget then stops. A winner
// who bid with VAT makes nothing until it confirms its prices before VAT (each line and the total within its bid) and
// procurement releases the award. A need makes agreed prices instead, ending the overlapping one the day before.

const MON = new Date('2026-11-02T02:00:00Z') // Monday 09:00 Bangkok
const CLOSES = '2026-11-05T10:00:00Z'
const AFTER = new Date('2026-11-05T10:00:00Z')
const SEND = new Date('2026-11-06T03:00:00Z') // Friday 10:00
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
let seq = 400
function taxId(): string {
  const body = `01057${String(seq++).padStart(7, '0')}`
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
const PRICE_ONLY = [{ code: 'PRICE', nameTh: 'ราคา', weightBp: 10000, kind: 'PRICE' as const }]

let org: DoaOrg
let flow: ReturnType<typeof p2p>
let budgetLineId: string
beforeAll(async () => {
  org = await createP2Org()
  await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'SOURCING', enabled: true, enabledAt: new Date('2026-01-01T00:00:00Z'), contractRef: 'TEST-S10', reason: 'องค์กรทดสอบจัดหา' } })
  const at = new Date('2026-01-01T00:00:00Z')
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin2!, role: 'PROCUREMENT', grantedAt: at } })
  const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).settings as Record<string, unknown>
  await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...settings, sourcing: { allowVatInclusiveBids: true } } } })
  flow = p2p(org, MON)
  budgetLineId = await flow.fundedLine(20_000_000n)
}, 180_000)

const as = (code: string, now = SEND) => org.ctxOf(code, now)
const proc = (now = SEND) => as('proc_officer', now)
const version = async (id: string) => (await prisma.rfxEvent.findUniqueOrThrow({ where: { id } })).version
const awardOf = (id: string) => prisma.awardDecision.findUniqueOrThrow({ where: { id }, include: { lines: { include: { rfxLine: true }, orderBy: { rfxLine: { lineNo: 'asc' } } } } })
const openTaskOf = (awardId: string) => prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectType: 'AWARD_DECISION', subjectId: awardId } } } })
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]
const posOf = (awardDecisionId: string) => prisma.purchaseOrder.findMany({ where: { awardDecisionId }, orderBy: { netSatang: 'desc' }, include: { lines: { include: { sources: true } } } })

async function approve(awardId: string) {
  const task = (await openTaskOf(awardId))!
  await stepUpForTask(task.id, task.assigneeMemberId)
  return decideTask(as(codeOf(task.assigneeMemberId)), { taskId: task.id, decision: 'APPROVE' }, key())
}

/** Made and sent by proc_officer, with a reason when one is asked */
async function sendAward(rfxEventId: string, lines: ReadonlyArray<{ rfxLineId: string; bidId: string }>, reason?: string) {
  const made = ok(await createAward(proc(), { rfxEventId, lines: [...lines], ...(reason ? { reason } : {}) }, key()))
  ok(await submitAward(proc(), { awardDecisionId: made.awardDecisionId, version: (await awardOf(made.awardDecisionId)).version }, key()))
  return made.awardDecisionId
}

/** Lines of approved requests in the pool, category STEEL, each request on a site of its own */
async function poolLines(lines: ReadonlyArray<{ quantity: string; unitPrice: string }>, budget = budgetLineId): Promise<string[]> {
  const ids: string[] = []
  for (const l of lines) {
    const request = await flow.approvedRequest(budget, [{ quantity: l.quantity, unitPrice: l.unitPrice }])
    const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 6)}`, nameTh: 'ไซต์', address: 'ถนนทดสอบ' } })
    await prisma.request.update({ where: { id: request.id }, data: { deliverySiteId: site.id } })
    await prisma.requestLine.updateMany({ where: { requestId: request.id }, data: { categoryCode: 'STEEL' } })
    ids.push(request.lines[0]!.id)
  }
  return ids
}

async function party(name: string, opts: { vatRegistered?: boolean } = {}) {
  const s = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: name, taxId: taxId(), isVatRegistered: opts.vatRegistered ?? true, branchCode: '00000', portalEnabled: true } })
  const contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: s.id, nameTh: `ติดต่อ ${name}`, email: `s-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true } })
  return { supplier: s, contact, ctx: (now = SEND) => portalCtx(org.organizationId, contact, now) }
}

interface SceneOptions {
  readonly evaluators?: readonly string[]
  readonly requestPrices?: readonly [string, string]
  readonly budget?: string
  /** The second supplier (SP0029) is not registered for VAT */
  readonly secondWithoutVat?: boolean
}

/** Scene 9: an RFQ from two request lines, three bids, closed and scored by two evaluators */
async function scene(o: SceneOptions = {}) {
  const prices = o.requestPrices ?? ['23800.00', '23800.00']
  const requestLineIds = await poolLines(
    [
      { quantity: '8', unitPrice: prices[0] },
      { quantity: '5', unitPrice: prices[1] },
    ],
    o.budget,
  )
  const { rfxEventId } = ok(await createRfx(proc(MON), { kind: 'RFQ', title: 'เหล็กข้ออ้อย DB12', description: 'ขอราคา 13 ตัน', allowVatInclusiveBids: true, source: { kind: 'REQUEST_LINES', requestLineIds } }, key()))
  const parties = []
  for (const [i, s] of SCENE_9.entries()) parties.push({ ...s, ...(await party(s.name, { vatRegistered: !(o.secondWithoutVat && i === 1) })) })
  for (const p of parties) ok(await inviteToRfx(proc(MON), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: p.supplier.id }, key()))
  const evaluators = o.evaluators ?? ['dm_it', 'vp_sup']
  ok(await setScorecard(proc(MON), { rfxEventId, expectedVersion: await version(rfxEventId), criteria: CRITERIA, evaluatorMemberIds: evaluators.map((c) => org.member[c]!) }, key()))
  ok(await openRfx(proc(MON), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: CLOSES }, key()))
  const lines = (await prisma.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' } })).map((l) => l.id)
  const bids: string[] = []
  for (const p of parties) bids.push(ok(await submitBid(p.ctx(MON), { rfxEventId, priceIncludesVat: p.priceIncludesVat, lines: lines.map((rfxLineId) => ({ rfxLineId, offered: true, unitPrice: p.unit })) }, key())).bidId)
  await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
  for (const [i, code] of evaluators.entries()) {
    const entries = bids.flatMap((bidId, b) => (['DELIVERY', 'QUALITY'] as const).map((criterionCode) => ({ bidId, criterionCode, score: SCENE_9[b]![criterionCode][i as 0 | 1] })))
    ok(await submitScores(as(code, AFTER), { rfxEventId, entries }, key()))
  }
  return { rfxEventId, bids, parties, lines, requestLineIds }
}

const allTo = (lines: readonly string[], bidId: string) => lines.map((rfxLineId) => ({ rfxLineId, bidId }))

/** A price-only RFQ (revealed at the close) of the given source, one invite per party, each party's prices bid */
async function priceOnly(source: Parameters<typeof createRfx>[1]['source'], bidders: ReadonlyArray<{ p: Awaited<ReturnType<typeof party>>; vat?: boolean; units: readonly string[] }>) {
  const { rfxEventId } = ok(await createRfx(proc(MON), { kind: 'RFQ', title: 'จัดหาทดสอบ', description: 'ขอราคา', allowVatInclusiveBids: true, source }, key()))
  for (const b of bidders) ok(await inviteToRfx(proc(MON), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: b.p.supplier.id }, key()))
  ok(await setScorecard(proc(MON), { rfxEventId, expectedVersion: await version(rfxEventId), criteria: PRICE_ONLY, evaluatorMemberIds: [] }, key()))
  ok(await openRfx(proc(MON), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: CLOSES, fewerInvitesReason: 'ผู้ขายในตลาดมีน้อยราย' }, key()))
  const lines = (await prisma.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' } })).map((l) => l.id)
  const bids: string[] = []
  for (const b of bidders) bids.push(ok(await submitBid(b.p.ctx(MON), { rfxEventId, priceIncludesVat: b.vat ?? false, lines: lines.map((rfxLineId, i) => ({ rfxLineId, offered: true, unitPrice: b.units[i]! })) }, key())).bidId)
  await closeRfxAt(org.organizationId, rfxEventId, CLOSES, AFTER)
  return { rfxEventId, lines, bids }
}

describe('[FR-SRC-204/AC3] [INV-RFX-04] [BR-RFX-13] scene 9 approved: two draft POs at the awarded price, made by the submitter', () => {
  it('185,200.00 and 115,750.00 at 23,150.00 a tonne with VAT 7%, stamped with the award; the request lines leave the RFx; the winner preferred; the suppliers told', async () => {
    const { rfxEventId, bids, lines, parties, requestLineIds } = await scene()
    const awardId = await sendAward(rfxEventId, allTo(lines, bids[0]!))
    ok(await approve(awardId))
    const award = await awardOf(awardId)
    expect(award).toMatchObject({ status: 'APPROVED', poStatus: 'CREATED' })
    const pos = await posOf(awardId)
    expect(pos.map((p) => [p.status, p.netSatang, p.vatSatang, p.grossSatang, p.vatRateBp, p.createdById, p.rfxEventId, p.supplierId])).toEqual([
      ['DRAFT', 18_520_000n, 1_296_400n, 19_816_400n, 700, org.member.proc_officer, rfxEventId, parties[0]!.supplier.id],
      ['DRAFT', 11_575_000n, 810_250n, 12_385_250n, 700, org.member.proc_officer, rfxEventId, parties[0]!.supplier.id],
    ])
    expect([...(award.purchaseOrderIds as string[])].sort()).toEqual(pos.map((p) => p.id).sort())
    // INV-RFX-04: every PO line at the awarded price and the PO at the winner's rate; together the award's amount
    for (const po of pos) for (const l of po.lines) expect(l.unitPriceSatang).toBe(award.lines[0]!.unitPriceSatang)
    expect(pos.every((p) => p.vatRateBp === award.lines[0]!.vatRateBp)).toBe(true)
    expect(pos.reduce((s, p) => s + p.grossSatang, 0n)).toBe(award.grossSatang)
    expect(pos.flatMap((p) => p.lines.flatMap((l) => l.sources.map((s) => s.requestLineId))).sort()).toEqual([...requestLineIds].sort())
    // the round is the submitter's (ctx derived from the award · BR-RFX-13)
    const run = await prisma.consolidationRun.findUniqueOrThrow({ where: { id: pos[0]!.consolidationRunId! } })
    expect(run).toMatchObject({ trigger: 'MANUAL', triggeredById: org.member.proc_officer })
    // the RFx's request lines are its own no more, with the winner as supplier
    expect(await prisma.requestLine.findMany({ where: { id: { in: requestLineIds } }, select: { rfxEventId: true, supplierId: true } })).toEqual(requestLineIds.map(() => ({ rfxEventId: null, supplierId: parties[0]!.supplier.id })))
    expect(await prisma.rfxLineSource.count({ where: { requestLineId: { in: requestLineIds }, active: true } })).toBe(0)
    const assigned = await prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'request.supplier_assigned', data: { path: ['awardDecisionId'], equals: awardId } } })
    expect(assigned).toHaveLength(2)
    // the effects' events are the submitter's, on behalf of the approver (BR-RFX-13)
    expect(assigned.every((e) => e.actorMemberId === org.member.proc_officer && e.onBehalfOfMemberId === org.member.dm_proc && e.schemaVersion === 2)).toBe(true)
    expect(await prisma.event.findMany({ where: { organizationId: org.organizationId, type: { in: ['po.drafted', 'consolidation_run.completed', 'preferred_supplier.created'] }, correlationId: assigned[0]!.correlationId }, select: { actorMemberId: true } })).toEqual(Array(4).fill({ actorMemberId: org.member.proc_officer }))
    expect(assigned[0]!.data).toMatchObject({ via: 'AWARD', onBehalfOfMemberId: org.member.dm_proc, supplierId: parties[0]!.supplier.id })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'po.drafted', aggregateId: { in: pos.map((p) => p.id) }, data: { path: ['awardDecisionId'], equals: awardId } } })).toBe(2)
    const approved = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: awardId, type: 'award.approved' } })
    expect(approved.data).toMatchObject({ onBehalfOf: org.member.dm_proc, poStatus: 'CREATED', priceAgreementIds: [] })
    // BR-RFX-14: the winner preferred in STEEL for 365 days from the Thai day of the approval
    const preferred = await prisma.preferredSupplier.findMany({ where: { awardDecisionId: awardId } })
    expect(preferred.map((p) => [p.categoryCode, p.supplierId, p.validFrom.toISOString().slice(0, 10), p.validTo.toISOString().slice(0, 10), p.source, p.createdById])).toEqual([['STEEL', parties[0]!.supplier.id, '2026-11-06', '2027-11-06', 'SOURCING', org.member.proc_officer]])
    expect((approved.data as { preferredSupplierIds: string[] }).preferredSupplierIds).toEqual([preferred[0]!.id])
    // the winner hears its lines and prices; the others a thank-you without them
    const notices = await prisma.supplierNotice.findMany({ where: { organizationId: org.organizationId, subjectType: 'RfxEvent', subjectId: rfxEventId, templateKey: { in: ['rfx.awarded', 'rfx.not_awarded', 'rfx.net_price_confirm_requested'] } } })
    expect(notices.map((n) => [n.templateKey, n.supplierId]).sort()).toEqual(
      [
        ['rfx.awarded', parties[0]!.supplier.id],
        ['rfx.not_awarded', parties[1]!.supplier.id],
        ['rfx.not_awarded', parties[2]!.supplier.id],
      ].sort(),
    )
    expect(notices.find((n) => n.templateKey === 'rfx.awarded')!.data).toMatchObject({ lines: [{ lineNo: 1, unitPrice: '23150.00', lineNet: '185200.00' }, { lineNo: 2, unitPrice: '23150.00', lineNet: '115750.00' }], pendingPrice: false })
    expect(JSON.stringify(notices.filter((n) => n.templateKey === 'rfx.not_awarded').map((n) => n.data))).not.toContain('23150')
    // inside: the requester at once, the creator and evaluators in the digest
    const inside = await prisma.notification.findMany({ where: { organizationId: org.organizationId, templateKey: 'rfx.awarded_internal', subjectId: rfxEventId } })
    expect(inside.map((n) => [codeOf(n.recipientMemberId), n.urgency]).sort()).toEqual(
      [
        ['dm_it', 'DIGEST'],
        ['proc_officer', 'DIGEST'],
        ['req_con', 'IMMEDIATE'],
        ['vp_sup', 'DIGEST'],
      ].sort(),
    )

    // the screens: the PO page links back to the award; the award page lists its POs
    const big = pos[0]!
    expect(await getPurchaseOrderView(proc(), big.id)).toMatchObject({ fromAward: { awardDecisionId: awardId, number: award.number, rfxEventId, rfxNumber: expect.any(String) }, supplier: { foreign: false } })
    const workspace = ok(await awardWorkspace(proc(), rfxEventId))
    expect(workspace.after).toMatchObject({ poStatus: 'CREATED', priceAgreements: 0, winnersToConfirm: [] })
    expect(workspace.after!.purchaseOrders.map((p) => [p.id, p.gross, p.status])).toEqual([
      [big.id, '198164.00', 'DRAFT'],
      [pos[1]!.id, '123852.50', 'DRAFT'],
    ])
    // the drafts keep the awarded price (INV-RFX-04) and go to DOA PURCHASE_ORDER like any PO (OQ-203): PO-01, the COO
    expect(await editDraftPo(proc(), { poId: big.id, expectedVersion: big.version, lines: [{ poLineId: big.lines[0]!.id, unitPrice: '23000.00' }] }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'AWARD_PRICE' } } })
    ok(await submitPo(proc(), { poId: big.id }, key()))
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectType: 'PURCHASE_ORDER', subjectId: big.id } })
    expect(route).toMatchObject({ ruleCode: 'PO-01', escalatedFromRuleCode: null, amountSatang: 19_816_400n })
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: big.id } })).vatRateBp).toBe(700)
  })
})

describe('[FR-SRC-204/AC4] [BR-RFX-13] an award the COO approved (RA-02): the POs are the submitter\'s', () => {
  it('createdById is proc_officer, not the COO, so PO-01 still reaches the COO without escalating', async () => {
    const { rfxEventId, bids, lines } = await scene({ evaluators: ['dm_proc', 'dm_it'] })
    const awardId = await sendAward(rfxEventId, allTo(lines, bids[0]!))
    expect((await openTaskOf(awardId))!.assigneeMemberId).toBe(org.member.coo)
    ok(await approve(awardId))
    const pos = await posOf(awardId)
    expect(pos).toHaveLength(2)
    expect(pos.every((p) => p.createdById === org.member.proc_officer)).toBe(true)
    ok(await submitPo(proc(), { poId: pos[1]!.id }, key()))
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectType: 'PURCHASE_ORDER', subjectId: pos[1]!.id } })
    expect(route).toMatchObject({ ruleCode: 'PO-01', escalatedFromRuleCode: null })
    expect((await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { routeId: route.id } } })).assigneeMemberId).toBe(org.member.coo)
  })
})

describe('[INV-RFX-04] [GC-SRC-22] [BR-VAT-04] a winner not registered for VAT', () => {
  it('its POs have VAT 0 and gross = the award; sent for approval they keep the rate 0', async () => {
    const { rfxEventId, bids, lines } = await scene({ secondWithoutVat: true })
    const awardId = await sendAward(rfxEventId, allTo(lines, bids[1]!), 'ผู้ขายรายนี้ส่งของได้ทันทั้งสองไซต์')
    const award = await awardOf(awardId)
    expect(award).toMatchObject({ netSatang: 30_550_000n, vatSatang: 0n, grossSatang: 30_550_000n })
    expect(award.lines.every((l) => l.vatRateBp === 0)).toBe(true)
    ok(await approve(awardId))
    const pos = await posOf(awardId)
    expect(pos.map((p) => [p.netSatang, p.vatSatang, p.grossSatang, p.vatRateBp])).toEqual([
      [18_800_000n, 0n, 18_800_000n, 0],
      [11_750_000n, 0n, 11_750_000n, 0],
    ])
    expect(pos.reduce((s, p) => s + p.grossSatang, 0n)).toBe(award.grossSatang)
    expect((await getPurchaseOrderView(proc(), pos[1]!.id))!.totals).toMatchObject({ basis: 'TODAY', vatRateBp: 0, vatSatang: 0n, grossSatang: 11_750_000n })
    ok(await submitPo(proc(), { poId: pos[0]!.id }, key()))
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: pos[0]!.id } })).toMatchObject({ status: 'PENDING_APPROVAL', vatRateBp: 0, vatSatang: 0n, grossSatang: 18_800_000n })
    expect((await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: pos[0]!.id, type: 'po.submitted' } })).data).toMatchObject({ vatRateBp: 0, vatSatang: '0' })
  })
})

describe('[INV-RFX-04] only the award\'s lines', () => {
  it('a sibling line of the same request with a supplier waiting for the round stays in the pool, and the next round drafts it without the award', async () => {
    const request = await flow.approvedRequest(budgetLineId, [
      { quantity: '2', unitPrice: '10000.00', description: 'เหล็กแผ่น' },
      { quantity: '3', unitPrice: '1000.00', description: 'ลวดผูกเหล็ก' },
    ])
    await prisma.requestLine.updateMany({ where: { requestId: request.id }, data: { categoryCode: 'STEEL' } })
    const [first, sibling] = request.lines
    const winner = await party('ผู้ขายเหล็กแผ่น')
    const other = await party('ผู้ขายลวด')
    const { rfxEventId, lines, bids } = await priceOnly({ kind: 'REQUEST_LINES', requestLineIds: [first!.id] }, [{ p: winner, units: ['9500.00'] }])
    ok(await assignSupplier(proc(), { requestLineIds: [sibling!.id], supplierId: other.supplier.id }, key()))
    const awardId = await sendAward(rfxEventId, allTo(lines, bids[0]!))
    ok(await approve(awardId))
    const pos = await posOf(awardId)
    expect(pos).toHaveLength(1)
    expect(pos[0]!.lines.map((l) => [l.sources[0]!.requestLineId, l.unitPriceSatang])).toEqual([[first!.id, 950_000n]])
    expect(await prisma.poLineSource.count({ where: { requestLineId: sibling!.id } })).toBe(0)
    expect(await prisma.requestLine.findUniqueOrThrow({ where: { id: sibling!.id } })).toMatchObject({ supplierId: other.supplier.id, rfxEventId: null })
    const run = ok(await consolidateNow(proc(), key()))
    const later = await prisma.purchaseOrder.findMany({ where: { id: { in: [...run.purchaseOrderIds] }, lines: { some: { sources: { some: { requestLineId: sibling!.id } } } } } })
    expect(later.map((p) => [p.supplierId, p.awardDecisionId, p.rfxEventId])).toEqual([[other.supplier.id, null, null]])
  })
})

describe('[INV-RFX-04] two approvals at once', () => {
  it('one goes, the other is refused, and the award has one set of POs', async () => {
    const { rfxEventId, bids, lines } = await scene()
    const awardId = await sendAward(rfxEventId, allTo(lines, bids[0]!))
    const task = (await openTaskOf(awardId))!
    await stepUpForTask(task.id, task.assigneeMemberId)
    const both = await Promise.all([decideTask(as('dm_proc'), { taskId: task.id, decision: 'APPROVE' }, key()), decideTask(as('dm_proc'), { taskId: task.id, decision: 'APPROVE' }, key())])
    expect(both.filter((r) => r.ok)).toHaveLength(1)
    expect(await prisma.purchaseOrder.count({ where: { awardDecisionId: awardId } })).toBe(2)
    expect(await prisma.consolidationRun.count({ where: { organizationId: org.organizationId, createdPoIds: { hasSome: (await posOf(awardId)).map((p) => p.id) } } })).toBe(1)
  })
})

describe('[FR-SRC-204/AC4] [BR-BUD-05] an award above what the requests approved', () => {
  it('still makes its POs; the budget then stops the PO at its send (BUDGET_INSUFFICIENT)', async () => {
    const tight = await flow.fundedLine(270_000n)
    const { rfxEventId, bids, lines } = await scene({ requestPrices: ['20000.00', '20000.00'], budget: tight })
    const awardId = await sendAward(rfxEventId, allTo(lines, bids[0]!), 'ราคาเหล็กขึ้นหลังขออนุมัติ')
    expect((await awardOf(awardId)).reasonCodes).toEqual(['ABOVE_REQUEST'])
    ok(await approve(awardId))
    const pos = await posOf(awardId)
    expect(pos.map((p) => p.netSatang)).toEqual([18_520_000n, 11_575_000n])
    // 185,200.00 against the 160,000.00 the request reserved: 25,200.00 more where 10,000.00 is left
    expect(await submitPo(proc(), { poId: pos[0]!.id }, key())).toMatchObject({ ok: false, error: { code: 'BUDGET_INSUFFICIENT' } })
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: pos[0]!.id } })).status).toBe('DRAFT')
  })
})

describe('[FR-SRC-204/AC10] [GC-SRC-41] [OQ-212] a winner who bid with VAT included', () => {
  it('approved: no PO until it confirms its prices before VAT within its bid and procurement releases the award', async () => {
    const { rfxEventId, bids, lines, parties, requestLineIds } = await scene()
    const awardId = await sendAward(rfxEventId, allTo(lines, bids[2]!), 'ส่งของได้เร็วที่สุด')
    ok(await approve(awardId))
    expect(await awardOf(awardId)).toMatchObject({ status: 'APPROVED', poStatus: 'PENDING_PRICE', purchaseOrderIds: [] })
    expect(await prisma.purchaseOrder.count({ where: { awardDecisionId: awardId } })).toBe(0)
    // the request lines stay with the RFx, without a supplier, so no round drafts them at the request's price
    expect(await prisma.requestLine.findMany({ where: { id: { in: requestLineIds } }, select: { rfxEventId: true, supplierId: true } })).toEqual(requestLineIds.map(() => ({ rfxEventId, supplierId: null })))
    const notices = await prisma.supplierNotice.findMany({ where: { organizationId: org.organizationId, subjectId: rfxEventId, supplierId: parties[2]!.supplier.id, templateKey: { in: ['rfx.awarded', 'rfx.net_price_confirm_requested'] } } })
    expect(notices.map((n) => n.templateKey).sort()).toEqual(['rfx.awarded', 'rfx.net_price_confirm_requested'])
    expect(notices.find((n) => n.templateKey === 'rfx.awarded')!.data).toMatchObject({ pendingPrice: true, lines: [{ unitPrice: '' }, { unitPrice: '' }] })

    expect(ok(await awardWorkspace(proc(), rfxEventId)).after).toMatchObject({ poStatus: 'PENDING_PRICE', purchaseOrders: [], winnersToConfirm: [{ supplierName: parties[2]!.supplier.nameTh, confirmed: false }] })
    // the winner's form: its price with VAT and the highest it may give before VAT, line by line; a loser has none
    expect((await portalRfx(parties[2]!.ctx(), rfxEventId))!.priceConfirm).toMatchObject({
      vatRateBp: 700,
      confirmedAt: null,
      lines: [
        { lineNo: 1, quotedUnitPrice: '25000.00', maxNetUnitPrice: '23364.48', confirmedNetUnitPrice: null },
        { lineNo: 2, quotedUnitPrice: '25000.00', maxNetUnitPrice: '23364.48', confirmedNetUnitPrice: null },
      ],
    })
    expect((await portalRfx(parties[0]!.ctx(), rfxEventId))!.priceConfirm).toBeNull()
    let award = await awardOf(awardId)
    expect(await releaseAwardPo(proc(), { awardDecisionId: awardId, version: award.version }, key())).toMatchObject({ ok: false, error: { code: 'PO_PENDING_PRICE' } })
    for (const code of ['fin_officer', 'req_con']) expect(await releaseAwardPo(as(code), { awardDecisionId: awardId, version: award.version }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // a bidder who did not win, or one who bid before VAT, confirms nothing
    expect(await confirmNetPrices(parties[0]!.ctx(), { rfxEventId, lines: lines.map((rfxLineId) => ({ rfxLineId, unitPrice: '23000.00' })) }, key())).toMatchObject({ ok: false })
    const winner = parties[2]!
    // every line it won, once
    expect(await confirmNetPrices(winner.ctx(), { rfxEventId, lines: [{ rfxLineId: lines[0]!, unitPrice: '23364.48' }] }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'LINES' } } })
    // GC-SRC-41: 23,364.49 × 1.07 is above 25,000.00 bid; 23,364.48 is the most it may confirm
    expect(await confirmNetPrices(winner.ctx(), { rfxEventId, lines: [{ rfxLineId: lines[0]!, unitPrice: '23364.49' }, { rfxLineId: lines[1]!, unitPrice: '23364.48' }] }, key())).toMatchObject({ ok: false, error: { code: 'AWARD_PRICE_EXCEEDS_BID', details: { line: '1', reason: 'LINE' } } })
    const confirmed = ok(await confirmNetPrices(winner.ctx(), { rfxEventId, lines: lines.map((rfxLineId) => ({ rfxLineId, unitPrice: '23364.48' })) }, key()))
    // 186,915.84 + 116,822.40 = 303,738.24 + VAT 21,261.68 = 324,999.92 — within the 325,000.00 bid
    expect(confirmed).toMatchObject({ net: '303738.24', vat: '21261.68', gross: '324999.92' })
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, recipientMemberId: org.member.proc_officer!, templateKey: 'award.prices_confirmed', subjectId: awardId } })).toBe(1)
    expect((await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'bid.net_prices_confirmed', aggregateId: bids[2]! } })).data).toMatchObject({ awardDecisionId: awardId, lineCount: 2, netSatang: '30373824' })

    expect(ok(await awardWorkspace(proc(), rfxEventId)).after!.winnersToConfirm).toEqual([{ supplierName: parties[2]!.supplier.nameTh, confirmed: true }])
    expect((await portalRfx(winner.ctx(), rfxEventId))!.priceConfirm!.lines.map((l) => l.confirmedNetUnitPrice)).toEqual(['23364.48', '23364.48'])
    award = await awardOf(awardId)
    const released = ok(await releaseAwardPo(as('admin2'), { awardDecisionId: awardId, version: award.version }, key()))
    expect(released.purchaseOrderIds).toHaveLength(2)
    award = await awardOf(awardId)
    expect(award).toMatchObject({ poStatus: 'CREATED', netSatang: 30_373_832n, vatSatang: 2_126_168n })
    expect(award.lines.map((l) => l.unitPriceSatang)).toEqual([2_336_448n, 2_336_448n])
    const pos = await posOf(awardId)
    expect(pos.map((p) => [p.netSatang, p.vatSatang, p.vatRateBp, p.createdById])).toEqual([
      [18_691_584n, 1_308_411n, 700, org.member.proc_officer],
      [11_682_240n, 817_757n, 700, org.member.proc_officer],
    ])
    expect(pos.flatMap((p) => p.lines.map((l) => l.unitPriceSatang))).toEqual([2_336_448n, 2_336_448n])
    expect((await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: awardId, type: 'award.po_created' } })).data).toMatchObject({ purchaseOrderIds: released.purchaseOrderIds })
    expect(await prisma.requestLine.count({ where: { id: { in: requestLineIds }, rfxEventId: { not: null } } })).toBe(0)
    expect((await portalRfx(winner.ctx(), rfxEventId))!.priceConfirm).toBeNull()
    // released once
    expect(await confirmNetPrices(winner.ctx(), { rfxEventId, lines: lines.map((rfxLineId) => ({ rfxLineId, unitPrice: '23000.00' })) }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NOT_PENDING_PRICE' } } })
    expect(await releaseAwardPo(proc(), { awardDecisionId: awardId, version: award.version }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NOT_PENDING_PRICE' } } })
  })

  it('the total too: two halves at 1.00 with VAT confirmed at 0.93 each are 0.94 + 0.07 = 1.01 — one satang above the bid', async () => {
    const winner = await party('ผู้ขายรวม VAT')
    const { rfxEventId, lines, bids } = await priceOnly({ kind: 'NEED', categoryCode: 'STEEL', lines: [{ description: 'ชิ้นส่วน ก', quantity: '0.5', uom: 'ชิ้น' }, { description: 'ชิ้นส่วน ข', quantity: '0.5', uom: 'ชิ้น' }] }, [{ p: winner, vat: true, units: ['1.00', '1.00'] }])
    const awardId = await sendAward(rfxEventId, allTo(lines, bids[0]!))
    ok(await approve(awardId))
    expect((await awardOf(awardId)).poStatus).toBe('PENDING_PRICE')
    expect(await confirmNetPrices(winner.ctx(), { rfxEventId, lines: lines.map((rfxLineId) => ({ rfxLineId, unitPrice: '0.93' })) }, key())).toMatchObject({ ok: false, error: { code: 'AWARD_PRICE_EXCEEDS_BID', details: { reason: 'TOTAL', line: '1, 2' } } })
    ok(await confirmNetPrices(winner.ctx(), { rfxEventId, lines: [{ rfxLineId: lines[0]!, unitPrice: '0.92' }, { rfxLineId: lines[1]!, unitPrice: '0.93' }] }, key()))
    // a need makes no PO; its lines have no catalogue item, so no agreed price either
    const released = ok(await releaseAwardPo(proc(), { awardDecisionId: awardId, version: (await awardOf(awardId)).version }, key()))
    expect(released).toMatchObject({ purchaseOrderIds: [], priceAgreementIds: [] })
    expect((await awardOf(awardId)).poStatus).toBe('NOT_APPLICABLE')
  })
})

describe('[FR-SRC-204/AC9] [BR-RFX-13] a need: agreed prices instead of POs', () => {
  it('one per line with a catalogue item at the awarded price for 365 days, the overlapping one ended the day before; one that starts within is refused first', async () => {
    const item = async (code: string) => prisma.catalogItem.create({ data: { organizationId: org.organizationId, code: `${code}-${randomUUID().slice(0, 6)}`, nameTh: code, uom: 'ชิ้น', categoryCode: 'STEEL', refUnitPriceSatang: 10_000n } })
    const [a, b] = [await item('ITEM-A'), await item('ITEM-B')]
    const winner = await party('ผู้ขายแคตตาล็อก')
    const loser = await party('ผู้ขายอีกราย')
    const old = await prisma.priceAgreement.create({ data: { organizationId: org.organizationId, catalogItemId: a.id, supplierId: winner.supplier.id, unitPriceSatang: 11_000n, validFrom: new Date('2026-10-01T00:00:00Z'), validTo: new Date('2027-01-01T00:00:00Z') } })
    const future = await prisma.priceAgreement.create({ data: { organizationId: org.organizationId, catalogItemId: b.id, supplierId: winner.supplier.id, unitPriceSatang: 22_000n, validFrom: new Date('2026-12-01T00:00:00Z'), validTo: new Date('2027-03-01T00:00:00Z') } })
    const source = {
      kind: 'NEED' as const,
      categoryCode: 'STEEL',
      lines: [
        { description: 'สินค้า ก', quantity: '10', uom: 'ชิ้น', catalogItemId: a.id },
        { description: 'สินค้า ข', quantity: '5', uom: 'ชิ้น', catalogItemId: b.id },
        { description: 'งานตัดพิเศษ', quantity: '1', uom: 'งาน', refUnitPrice: '500.00' },
      ],
    }
    const { rfxEventId, lines, bids } = await priceOnly(source, [
      { p: winner, units: ['100.00', '200.00', '300.00'] },
      { p: loser, units: ['120.00', '210.00', '320.00'] },
    ])
    const awardId = await sendAward(rfxEventId, allTo(lines, bids[0]!))
    // the agreement of item B that starts on 1 Dec is the procurement's to end first: the approval rolls back, the task stays
    expect(await approve(awardId)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'AGREEMENT_OVERLAP', priceAgreementId: future.id, lineNo: 2 } } })
    expect(await awardOf(awardId)).toMatchObject({ status: 'PENDING_APPROVAL' })
    expect(await openTaskOf(awardId)).not.toBeNull()
    expect((await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).status).not.toBe('AWARDED')
    await prisma.priceAgreement.delete({ where: { id: future.id } })

    ok(await approve(awardId))
    const award = await awardOf(awardId)
    expect(award).toMatchObject({ status: 'APPROVED', poStatus: 'NOT_APPLICABLE', purchaseOrderIds: [] })
    expect(await prisma.purchaseOrder.count({ where: { awardDecisionId: awardId } })).toBe(0)
    const made = await prisma.priceAgreement.findMany({ where: { sourceRef: award.number }, orderBy: { unitPriceSatang: 'asc' } })
    expect(made.map((p) => [p.catalogItemId, p.supplierId, p.unitPriceSatang, p.validFrom.toISOString().slice(0, 10), p.validTo.toISOString().slice(0, 10), p.createdById])).toEqual([
      [a.id, winner.supplier.id, 10_000n, '2026-11-06', '2027-11-06', org.member.proc_officer],
      [b.id, winner.supplier.id, 20_000n, '2026-11-06', '2027-11-06', org.member.proc_officer],
    ])
    expect([...(award.priceAgreementIds as string[])].sort()).toEqual(made.map((p) => p.id).sort())
    // the old one of item A ends on 5 Nov (validTo 6 Nov, not included)
    expect(await prisma.priceAgreement.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ validTo: new Date('2026-11-06T00:00:00Z'), endedAt: SEND })
    const approved = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: awardId, type: 'award.approved' } })
    expect(approved.data).toMatchObject({ poStatus: 'NOT_APPLICABLE', linesWithoutAgreement: [3] })
    const created = await prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'price_agreement.created', aggregateId: { in: made.map((p) => p.id) } } })
    expect(created.every((e) => (e.data as { via: string; sourceRef: string }).via === 'AWARD' && (e.data as { sourceRef: string }).sourceRef === award.number && e.actorMemberId === org.member.proc_officer)).toBe(true)
    expect(await prisma.preferredSupplier.count({ where: { awardDecisionId: awardId, supplierId: winner.supplier.id, categoryCode: 'STEEL' } })).toBe(1)
  })
})

describe('[BR-RFX-14] [INV-RFX-03] what nobody won, and a pair preferred again', () => {
  it('an RFx line not awarded goes back to the pool without a supplier; a second award of the same winner in STEEL extends its row', async () => {
    const { rfxEventId, bids, lines, parties, requestLineIds } = await scene()
    const awardId = await sendAward(rfxEventId, [{ rfxLineId: lines[0]!, bidId: bids[0]! }])
    ok(await approve(awardId))
    expect((await posOf(awardId)).map((p) => p.netSatang)).toEqual([18_520_000n])
    expect(await prisma.requestLine.findUniqueOrThrow({ where: { id: requestLineIds[1]! } })).toMatchObject({ rfxEventId: null, supplierId: null })
    expect(await prisma.poLineSource.count({ where: { requestLineId: requestLineIds[1]! } })).toBe(0)
    const first = await prisma.preferredSupplier.findFirstOrThrow({ where: { awardDecisionId: awardId } })

    // a later award to the same supplier in the same category, a day later: one row, its end moved a day
    const again = await priceOnly({ kind: 'NEED', categoryCode: 'STEEL', lines: [{ description: 'DB16', quantity: '1', uom: 'ตัน' }] }, [{ p: parties[0]!, units: ['24000.00'] }])
    const later = new Date('2026-11-09T03:00:00Z')
    const made = ok(await createAward(proc(later), { rfxEventId: again.rfxEventId, lines: allTo(again.lines, again.bids[0]!) }, key()))
    ok(await submitAward(proc(later), { awardDecisionId: made.awardDecisionId, version: (await awardOf(made.awardDecisionId)).version }, key()))
    const task = (await openTaskOf(made.awardDecisionId))!
    await stepUpForTask(task.id, task.assigneeMemberId)
    ok(await decideTask(as(codeOf(task.assigneeMemberId), later), { taskId: task.id, decision: 'APPROVE' }, key()))
    expect(await prisma.preferredSupplier.findMany({ where: { supplierId: parties[0]!.supplier.id, categoryCode: 'STEEL' }, select: { id: true, validTo: true } })).toEqual([{ id: first.id, validTo: new Date('2027-11-09T00:00:00Z') }])
    expect((await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'preferred_supplier.extended', aggregateId: first.id } })).data).toMatchObject({ from: '2027-11-06', to: '2027-11-09', awardDecisionId: made.awardDecisionId })
  })
})

describe('[INV-RFX-05] what is stored is computed again from the prices', () => {
  it('every approved award of this suite: its amount is awardTotals of its lines, and each line\'s amount is its winning bid line\'s', async () => {
    const awards = await prisma.awardDecision.findMany({ where: { organizationId: org.organizationId, status: 'APPROVED' }, include: { lines: true } })
    expect(awards.length).toBeGreaterThan(5)
    for (const a of awards) {
      const totals = awardTotals(a.lines.map((l) => ({ ref: l.rfxLineId, supplierId: l.supplierId, lineNetSatang: l.lineNetSatang, vatRateBp: l.vatRateBp })))
      expect([a.netSatang, a.vatSatang, a.grossSatang]).toEqual([totals.net, totals.vat, totals.gross])
      for (const l of a.lines) {
        const bidLine = await prisma.bidLine.findFirstOrThrow({ where: { bidId: l.bidId, rfxLineId: l.rfxLineId } })
        expect(l.lineNetSatang).toBe(bidLine.lineNetSatang)
      }
    }
  })
})
