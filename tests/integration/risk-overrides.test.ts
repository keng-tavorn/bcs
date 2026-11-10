import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { riskOverridesForPayment } from '@/server/queries/risk-overrides'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import { outsideChannels } from '@/server/services/approvals/subjects'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { sendPurchaseOrder } from '@/server/services/purchase-orders/send'
import { cancelRiskOverride, listRiskOverrides, poRiskStatus, requestRiskOverride, riskOverrideForm, riskOverrideView, submitRiskOverride, updateRiskOverride } from '@/server/services/risk'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { P1_FIXTURES } from '../support/p1-org'
import { createP2Org } from '../support/p2-org'
import { p2p } from '../support/p2p'

// S11-08 (FR-RSK-203 AC2 AC3 AC5 · FR-PAY-101 AC13 · BR-RSK-10 BR-RSK-11 BR-RSK-12 · BR-DOA-28 · BR-SOD-15 · ADR-226 ·
// OQ-224 OQ-225) against Postgres: PROCUREMENT asks for an override of the risk gate (a cap with VAT that counts every PO
// it lets out, a last day within settings.risk.overrideMaxDays of the send day), sends it under DOA RISK_OVERRIDE with the
// cap as the amount (RO-01 → COO), and the COO decides it through approval.decide; the requester, the PO's creator and the
// assessment's filler-in never approve it; no chat button, no e-mail link, no question; returned it is edited and sent
// again, rejected it ends. The gate then lets POs out under it, once per PO, never above the cap. Tiers and the policy
// are test data of the organization (the demo values of OQ-221 OQ-222 OQ-227), never code.

const NOW = new Date('2026-11-09T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const SCREEN_HIGH = { processesPersonalData: 'Y', accessesSystems: 'N', accessesPremises: 'N' } as const
const REASON = 'ผู้ขายรายเดียวที่ส่งมอบระบบได้ทันกำหนดเปิดโครงการ'

let org: DoaOrg
let flow: ReturnType<typeof p2p>
let questionnaireId: string
const proc = (now = NOW) => org.ctxOf('proc_officer', now)
const coo = (now = NOW) => org.ctxOf('coo', now)

async function riskOn(o: DoaOrg): Promise<string> {
  const id = o.organizationId
  await prisma.orgModule.create({ data: { organizationId: id, module: 'RISK', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
  await prisma.roleAssignment.createMany({ data: [{ organizationId: id, memberId: o.member.auditor!, role: 'AUDITOR', grantedAt: NOW }] })
  for (const t of [
    { code: 'LOW' as const, minPoints: 0, reviewMonths: 36, blocksPo: false, requiresExplicitAnswers: false },
    { code: 'MEDIUM' as const, minPoints: 20, reviewMonths: 24, blocksPo: false, requiresExplicitAnswers: false },
    { code: 'HIGH' as const, minPoints: 40, reviewMonths: 12, blocksPo: true, requiresExplicitAnswers: true },
  ]) {
    await prisma.riskTier.create({ data: { organizationId: id, ...t, nameTh: t.code, nameEn: t.code, reminderDaysBefore: 30, updatedById: o.member.admin!, confirmedById: o.member.admin2!, confirmedAt: NOW } })
  }
  await prisma.riskPolicy.create({
    data: { organizationId: id, screeningTierMap: { processesPersonalData: 'HIGH', accessesSystems: 'MEDIUM', accessesPremises: 'MEDIUM' }, highRiskCategories: ['PROF'], registryFlagBlocks: true, mediumOverdueBlocks: false, overrideChatButton: false, updatedById: o.member.admin!, confirmedById: o.member.admin2!, confirmedAt: NOW },
  })
  const q = await prisma.riskQuestionnaire.create({ data: { organizationId: id, code: 'RQ-T', versionNo: 1, status: 'PUBLISHED', effectiveFrom: new Date('2026-11-01T00:00:00+07:00'), submittedById: o.member.admin!, submittedAt: NOW, publishedById: o.member.admin2!, publishedAt: NOW, checksum: 'test' } })
  return q.id
}

async function supplier(code: string, data: Record<string, unknown> = {}) {
  return (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `${code}-${randomUUID().slice(0, 4)}`, nameTh: `ผู้ขาย ${code}`, isForeign: true, email: `${code.toLowerCase()}@supplier.test`, ...data } })).id
}

/** A draft PO of one approved request (one line at `unitPrice`, VAT 7%) whose request answered `screening` */
async function draftPo(supplierId: string, unitPrice: string, screening: Record<string, string> = SCREEN_HIGH) {
  const line = await flow.fundedLine(5_000_000n)
  const request = await flow.approvedRequest(line, [{ quantity: '1', unitPrice }])
  await prisma.request.update({ where: { id: request.id }, data: { formData: screening } })
  const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์ทดสอบ', address: 'ถนนทดสอบ' } })
  await prisma.request.update({ where: { id: request.id }, data: { deliverySiteId: site.id } })
  ok(await assignSupplier(proc(), { requestLineIds: [request.lines[0]!.id], supplierId }, key()))
  const run = ok(await consolidateNow(proc(), key()))
  return prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id } })
}

/** An open assessment of the supplier (as riskAssessment.open leaves one), filled in by `filler` when given */
async function openAssessment(supplierId: string, filler?: string) {
  return prisma.riskAssessment.create({
    data: {
      organizationId: org.organizationId,
      number: `RSA-T-${randomUUID().slice(0, 8)}`,
      supplierId,
      questionnaireId,
      screening: SCREEN_HIGH,
      categoryCodes: [],
      payeeType: 'JURISTIC',
      workScopes: [],
      inherentTier: 'HIGH',
      status: 'DRAFT',
      openedById: org.member.proc_officer!,
      lastActivityAt: NOW,
      ...(filler ? { filledOnBehalfById: org.member[filler]! } : {}),
    },
  })
}

const request = (supplierId: string, terms: { capGross?: string; expiresOn?: string; poId?: string | null; reason?: string } = {}, by = 'proc_officer') =>
  requestRiskOverride(org.ctxOf(by, NOW), { supplierId, reason: terms.reason ?? REASON, capGross: terms.capGross ?? '50000.00', expiresOn: terms.expiresOn ?? '2026-12-31', poId: terms.poId ?? null }, key())
const versionOf = async (id: string) => (await prisma.riskOverride.findUniqueOrThrow({ where: { id } })).version
const openTaskOf = (routeId: string) => prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { routeId } } })
const eventsOf = (aggregateId: string, type: string) => prisma.event.findMany({ where: { organizationId: org.organizationId, aggregateId, type }, orderBy: { seq: 'asc' } })

/** request → submit → the COO approves (RO-01; below stepUpThreshold, no PIN) */
async function approvedOverride(supplierId: string, capGross: string, poId: string | null = null) {
  const r = ok(await request(supplierId, { capGross, poId }))
  const sent = ok(await submitRiskOverride(proc(), { overrideId: r.overrideId, expectedVersion: 0 }, key()))
  ok(await decideTask(coo(), { taskId: (await openTaskOf(sent.routeId)).id, decision: 'APPROVE' }, key()))
  return r.overrideId
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  questionnaireId = await riskOn(org)
  flow = p2p(org, NOW)
})

describe('[FR-RSK-203/AC2] [BR-RSK-10] asked, sent under DOA RISK_OVERRIDE by its cap with VAT, decided by the COO', () => {
  it('a draft with no number; sent it takes RO-…, routes RO-01 to the COO with the cap as the amount (VAT 0); approved it is APPROVED and its requester hears of it', async () => {
    const s = await supplier('RO-A')
    const a = await openAssessment(s)
    const drafted = ok(await request(s))
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: drafted.overrideId } })).toMatchObject({ status: 'DRAFT', number: null, capGrossSatang: 5_000_000n, assessmentId: a.id, requestedById: org.member.proc_officer })
    expect(await eventsOf(drafted.overrideId, 'risk_override.drafted')).toEqual([expect.objectContaining({ data: { supplierId: s, capGrossSatang: '5000000', expiresOn: '2026-12-31', poId: null, assessmentId: a.id } })])

    const sent = ok(await submitRiskOverride(proc(), { overrideId: drafted.overrideId, expectedVersion: 0 }, key()))
    expect(sent.number).toMatch(/^RO-2569-\d{5}$/)
    const route = await prisma.approvalRoute.findUniqueOrThrow({ where: { id: sent.routeId } })
    expect(route).toMatchObject({ subjectType: 'RISK_OVERRIDE', subjectId: drafted.overrideId, ruleCode: 'RO-01', amountSatang: 5_000_000n })
    const task = await openTaskOf(sent.routeId)
    expect(task.assigneeMemberId).toBe(org.member.coo)
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: drafted.overrideId } })).toMatchObject({ status: 'PENDING_APPROVAL', number: sent.number, currentRouteId: sent.routeId, submittedAt: NOW })

    // the facts of the task (web, LIFF and the app read the same view): the COO has a task on it, so reads it
    const view = ok(await riskOverrideView(coo(), drafted.overrideId))
    expect(view).toMatchObject({ number: sent.number, tier: 'HIGH', tierSource: 'SCREENING', assessment: { state: 'IN_PROGRESS', id: a.id }, capGrossSatang: 5_000_000n, route: { ruleCode: 'RO-01', openTaskId: task.id }, canEdit: false })

    ok(await decideTask(coo(), { taskId: task.id, decision: 'APPROVE' }, key()))
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: drafted.overrideId } })).toMatchObject({ status: 'APPROVED', decidedAt: NOW })
    expect(await eventsOf(drafted.overrideId, 'risk_override.approved')).toEqual([expect.objectContaining({ data: { number: sent.number, capGrossSatang: '5000000', expiresOn: '2026-12-31' } })])
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, templateKey: 'risk.override_decided', recipientMemberId: org.member.proc_officer!, subjectId: drafted.overrideId } })).toBe(1)
  })

  it('a cap of 150,000.00 is at or above stepUpThreshold: deciding asks for the step-up by the amount (BR-RSK-11)', async () => {
    const s = await supplier('RO-SU')
    const r = ok(await request(s, { capGross: '150000.00' }))
    const sent = ok(await submitRiskOverride(proc(), { overrideId: r.overrideId, expectedVersion: 0 }, key()))
    const task = await openTaskOf(sent.routeId)
    expect(await decideTask(coo(), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: r.overrideId } })).toMatchObject({ status: 'PENDING_APPROVAL' })
  })

  it('no chat button and no e-mail link (OQ-225), unless the confirmed policy turns the button on; no question — a return instead', async () => {
    const s = await supplier('RO-CH')
    const r = ok(await request(s))
    const sent = ok(await submitRiskOverride(proc(), { overrideId: r.overrideId, expectedVersion: 0 }, key()))
    const channels = () => forTenant(org.organizationId).$transaction((tx) => outsideChannels(tx, 'RISK_OVERRIDE', r.overrideId))
    expect(await channels()).toEqual({ chatButton: false, emailLink: false })
    // a change waiting for its second person turns nothing on (BR-RSK-02)
    await prisma.riskPolicy.updateMany({ where: { organizationId: org.organizationId }, data: { pendingChange: { overrideChatButton: true }, pendingById: org.member.admin!, pendingAt: NOW } })
    expect(await channels()).toEqual({ chatButton: false, emailLink: false })
    await prisma.riskPolicy.updateMany({ where: { organizationId: org.organizationId }, data: { overrideChatButton: true } })
    expect(await channels()).toEqual({ chatButton: true, emailLink: false })
    await prisma.riskPolicy.updateMany({ where: { organizationId: org.organizationId }, data: { overrideChatButton: false } })
    const task = await openTaskOf(sent.routeId)
    expect(await requestInfo(coo(), { taskId: task.id, question: 'ขอทราบว่าผู้ขายรายอื่นส่งได้หรือไม่' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('returned: RETURNED with the approver’s words, edited and sent again on a new route with the same number; rejected: REJECTED', async () => {
    const s = await supplier('RO-RT')
    const r = ok(await request(s))
    const first = ok(await submitRiskOverride(proc(), { overrideId: r.overrideId, expectedVersion: 0 }, key()))
    ok(await decideTask(coo(), { taskId: (await openTaskOf(first.routeId)).id, decision: 'RETURN', reason: 'ขอให้ลดเพดานให้เท่ายอดใบสั่งซื้อจริง' }, key()))
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: r.overrideId } })).toMatchObject({ status: 'RETURNED', currentRouteId: null })
    expect(ok(await riskOverrideView(proc(), r.overrideId))).toMatchObject({ status: 'RETURNED', canEdit: true, lastDecision: { outcome: 'RETURNED', reason: 'ขอให้ลดเพดานให้เท่ายอดใบสั่งซื้อจริง' } })

    ok(await updateRiskOverride(proc(), { overrideId: r.overrideId, expectedVersion: await versionOf(r.overrideId), capGross: '30000.00' }, key()))
    expect(await eventsOf(r.overrideId, 'risk_override.updated')).toEqual([expect.objectContaining({ data: { fields: ['capGrossSatang'], from: 'RETURNED' } })])
    // edited it is a DRAFT again, and the approver's words stay on its page while it is fixed
    expect(ok(await riskOverrideView(proc(), r.overrideId))).toMatchObject({ status: 'DRAFT', lastDecision: { outcome: 'RETURNED', reason: 'ขอให้ลดเพดานให้เท่ายอดใบสั่งซื้อจริง' } })
    const again = ok(await submitRiskOverride(proc(), { overrideId: r.overrideId, expectedVersion: await versionOf(r.overrideId) }, key()))
    expect(again.number).toBe(first.number)
    expect(again.routeId).not.toBe(first.routeId)
    expect((await eventsOf(r.overrideId, 'risk_override.submitted')).map((e) => (e.data as { resubmitted: boolean }).resubmitted)).toEqual([false, true])

    ok(await decideTask(coo(), { taskId: (await openTaskOf(again.routeId)).id, decision: 'REJECT', reason: 'ให้รอผลประเมินความเสี่ยงก่อน' }, key()))
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: r.overrideId } })).toMatchObject({ status: 'REJECTED', decidedAt: NOW })
    // REJECTED is over: the supplier may ask for a new one
    expect((await request(s)).ok).toBe(true)
  })

  it('a DOA version with no RISK_OVERRIDE rule: DOA_NOT_CONFIGURED at the request, and the form says so (FR-RSK-203 AC2)', async () => {
    const p1 = await createDoaOrg({ fixtures: P1_FIXTURES })
    await prisma.orgModule.create({ data: { organizationId: p1.organizationId, module: 'RISK', enabled: true, enabledAt: NOW, contractRef: 'TEST-P1', reason: 'ทดสอบไม่มีข้อ RO' } })
    const s = (await prisma.supplier.create({ data: { organizationId: p1.organizationId, code: 'RO-NR', nameTh: 'ผู้ขายไม่มีข้อ', isForeign: true } })).id
    const ctx = p1.ctxOf('proc_officer', NOW)
    expect(await requestRiskOverride(ctx, { supplierId: s, reason: REASON, capGross: '50000.00', expiresOn: '2026-12-31' }, key())).toMatchObject({ ok: false, error: { code: 'DOA_NOT_CONFIGURED', details: { documentType: 'RISK_OVERRIDE' } } })
    expect(await riskOverrideForm(ctx, { supplierId: s })).toMatchObject({ ok: false, error: { code: 'DOA_NOT_CONFIGURED' } })
    expect(await prisma.riskOverride.count({ where: { organizationId: p1.organizationId } })).toBe(0)
  })

  it('refuses a flagged supplier (REGISTRY_BLOCKED · BR-RSK-12), a second open one (RISK_OVERRIDE_OPEN), a cap of zero and a PO of another supplier', async () => {
    const ceased = await supplier('RO-CE', { registryFlag: 'CEASED' })
    expect(await request(ceased)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'REGISTRY_BLOCKED', registryFlag: 'CEASED' } } })
    const vat = await supplier('RO-VC', { registryFlag: 'VAT_CANCELLED' })
    expect(await request(vat)).toMatchObject({ ok: false, error: { details: { reason: 'REGISTRY_BLOCKED' } } })
    const s = await supplier('RO-OP')
    const first = ok(await request(s))
    expect(await request(s)).toMatchObject({ ok: false, error: { code: 'RISK_OVERRIDE_OPEN', details: { overrideId: first.overrideId } } })
    expect(await request(await supplier('RO-Z'), { capGross: '0.00' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'capGross', reason: 'AMOUNT_NOT_POSITIVE' } } })
    const other = await draftPo(await supplier('RO-OT'), '1000.00')
    expect(await request(await supplier('RO-PO'), { poId: other.id })).toMatchObject({ ok: false, error: { details: { field: 'poId', reason: 'PO_OTHER_SUPPLIER' } } })
    // a flag that comes after the request stops its send
    const later = await supplier('RO-LF')
    const r = ok(await request(later))
    await prisma.supplier.update({ where: { id: later }, data: { registryFlag: 'NOT_FOUND' } })
    expect(await submitRiskOverride(proc(), { overrideId: r.overrideId, expectedVersion: 0 }, key())).toMatchObject({ ok: false, error: { details: { reason: 'REGISTRY_BLOCKED' } } })
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: r.overrideId } })).toMatchObject({ status: 'DRAFT', number: null })
  })

  it('[BR-RSK-16] RISK off: every command and read is MODULE_DISABLED', async () => {
    const off = await createP2Org()
    const s = (await prisma.supplier.create({ data: { organizationId: off.organizationId, code: 'RO-OFF', nameTh: 'ผู้ขายไม่มีโมดูล', isForeign: true } })).id
    expect(await requestRiskOverride(off.ctxOf('proc_officer', NOW), { supplierId: s, reason: REASON, capGross: '50000.00', expiresOn: '2026-12-31' }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await listRiskOverrides(off.ctxOf('proc_officer', NOW))).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })
})

describe('[FR-RSK-203/AC2] who may ask, change and decide (risk.override.request · BR-SOD-15)', () => {
  it('only PROCUREMENT asks; only who asked changes, sends or cancels it; a draft or a returned one only', async () => {
    const s = await supplier('RO-PERM')
    for (const by of ['fin_officer', 'req_con', 'coo']) expect(await request(s, {}, by)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const r = ok(await request(s))
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.dm_proc!, role: 'PROCUREMENT', grantedAt: NOW } })
    const other = org.ctxOf('dm_proc', NOW)
    expect(await updateRiskOverride(other, { overrideId: r.overrideId, expectedVersion: 0, capGross: '1.00' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'NOT_REQUESTER' } } })
    expect(await submitRiskOverride(other, { overrideId: r.overrideId, expectedVersion: 0 }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'NOT_REQUESTER' } } })
    expect(await cancelRiskOverride(other, { overrideId: r.overrideId, expectedVersion: 0 }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await submitRiskOverride(proc(), { overrideId: r.overrideId, expectedVersion: 7 }, key())).toMatchObject({ ok: false, error: { code: 'CONFLICT_VERSION' } })
    // a sent one is neither edited nor cancelled (cancelled while DRAFT or RETURNED only)
    const sent = ok(await submitRiskOverride(proc(), { overrideId: r.overrideId, expectedVersion: 0 }, key()))
    expect(await cancelRiskOverride(proc(), { overrideId: r.overrideId, expectedVersion: await versionOf(r.overrideId) }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await updateRiskOverride(proc(), { overrideId: r.overrideId, expectedVersion: await versionOf(r.overrideId), capGross: '1.00' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    // whoever has no task on it and does not read the risk files does not read it
    expect(await riskOverrideView(org.ctxOf('req_con', NOW), r.overrideId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect((await riskOverrideView(coo(), r.overrideId)).ok).toBe(true)
    expect(sent.routeId).toBeTruthy()

    const c = ok(await request(await supplier('RO-CAN')))
    ok(await cancelRiskOverride(proc(), { overrideId: c.overrideId, expectedVersion: 0 }, key()))
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: c.overrideId } })).toMatchObject({ status: 'CANCELLED' })
    expect(await eventsOf(c.overrideId, 'risk_override.cancelled')).toEqual([expect.objectContaining({ data: { from: 'DRAFT' } })])
  })

  it('[BR-SOD-15] the PO’s creator is kept off the route (the next band, the CEO); the assessment’s filler-in is refused at deciding', async () => {
    // the COO made the PO the override names: the route passes the COO over to the next band (BR-DOA-06)
    const s = await supplier('RO-SOD')
    const po = await draftPo(s, '10000.00')
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { createdById: org.member.coo! } })
    const r = ok(await request(s, { poId: po.id }))
    const sent = ok(await submitRiskOverride(proc(), { overrideId: r.overrideId, expectedVersion: 0 }, key()))
    expect((await openTaskOf(sent.routeId)).assigneeMemberId).toBe(org.member.ceo)

    // the COO fills in the supplier's assessment for it after the send: the decision is refused BR-SOD-15
    const s2 = await supplier('RO-SOD2')
    const a = await openAssessment(s2)
    const r2 = ok(await request(s2))
    const sent2 = ok(await submitRiskOverride(proc(), { overrideId: r2.overrideId, expectedVersion: 0 }, key()))
    const task = await openTaskOf(sent2.routeId)
    expect(task.assigneeMemberId).toBe(org.member.coo)
    await prisma.riskAssessment.update({ where: { id: a.id }, data: { filledOnBehalfById: org.member.coo! } })
    expect(await decideTask(coo(), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-15' } } })
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: r2.overrideId } })).toMatchObject({ status: 'PENDING_APPROVAL' })
  })
})

describe('[FR-RSK-203/AC3] the last day and the cumulative cap (BR-RSK-10 · BR-RSK-19 · OQ-224)', () => {
  it('the last day from the send day to the send day + overrideMaxDays (90): the day itself and the 90th day pass, the day before and the 91st do not', async () => {
    // NOW is 2026-11-09 in Bangkok: the window ends 2027-02-07 (GC-RSK-73 to 76 on the database)
    expect((await request(await supplier('RO-D0'), { expiresOn: '2026-11-09' })).ok).toBe(true)
    expect((await request(await supplier('RO-D90'), { expiresOn: '2027-02-07' })).ok).toBe(true)
    expect(await request(await supplier('RO-DP'), { expiresOn: '2026-11-08' })).toMatchObject({ ok: false, error: { details: { field: 'expiresOn', reason: 'OVERRIDE_EXPIRY_PAST' } } })
    expect(await request(await supplier('RO-DF'), { expiresOn: '2027-02-08' })).toMatchObject({ ok: false, error: { details: { field: 'expiresOn', reason: 'OVERRIDE_EXPIRY_TOO_FAR' } } })
    // sent on a later day, the day is checked against the send day
    const s = await supplier('RO-DL')
    const r = ok(await request(s, { expiresOn: '2026-11-10' }))
    expect(await submitRiskOverride(proc(new Date('2026-11-11T03:00:00Z')), { overrideId: r.overrideId, expectedVersion: 0 }, key())).toMatchObject({ ok: false, error: { details: { reason: 'OVERRIDE_EXPIRY_PAST' } } })
  })

  it('two POs at once under one override: both pass, usedCount 2 and usedGrossSatang their sum', async () => {
    const s = await supplier('RO-TWO')
    const o = await approvedOverride(s, '50000.00')
    // 10,000.00 + VAT 700.00 = 10,700.00 each
    const [a, b] = [await draftPo(s, '10000.00'), await draftPo(s, '10000.00')]
    const results = await Promise.all([submitPo(proc(), { poId: a.id }, key()), submitPo(proc(), { poId: b.id }, key())])
    expect(results.map((r) => r.ok)).toEqual([true, true])
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: o } })).toMatchObject({ usedCount: 2, usedGrossSatang: 2_140_000n })
    expect(await eventsOf(o, 'risk_override.used')).toHaveLength(2)
  })

  it('po.submit then po.send of one PO: usedCount 1 and risk_override.used once', async () => {
    const s = await supplier('RO-ONE')
    const o = await approvedOverride(s, '50000.00')
    const po = await draftPo(s, '10000.00')
    ok(await submitPo(proc(), { poId: po.id }, key()))
    await flow.approveAll(po.id)
    ok(await sendPurchaseOrder(proc(), { poId: po.id }, key()))
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: o } })).toMatchObject({ usedCount: 1, usedGrossSatang: 1_070_000n })
    expect(await eventsOf(o, 'risk_override.used')).toHaveLength(1)
    // the PO page shows the override it passed with, and its page the PO it let out
    expect(ok(await riskOverrideView(proc(), o)).posUsing).toEqual([{ id: po.id, number: expect.any(String), countedGrossSatang: 1_070_000n }])
  })

  it('the second PO that takes the cumulative gross one satang above the cap is RISK_BLOCKED OVERRIDE_CAP_EXCEEDED (GC-RSK-57 on the database)', async () => {
    const s = await supplier('RO-CAP')
    // 21,399.99: the first 10,700.00 fits, the second makes 21,400.00 — one satang above
    const o = await approvedOverride(s, '21399.99')
    const first = await draftPo(s, '10000.00')
    ok(await submitPo(proc(), { poId: first.id }, key()))
    const second = await draftPo(s, '10000.00')
    expect(await submitPo(proc(), { poId: second.id }, key())).toMatchObject({ ok: false, error: { code: 'RISK_BLOCKED', details: { reason: 'OVERRIDE_CAP_EXCEEDED', overrideId: o } } })
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: o } })).toMatchObject({ usedCount: 1, usedGrossSatang: 1_070_000n })
  })

  it('[FR-RSK-203/AC6] the PO band offers "ขออนุมัติข้าม" while the gate holds the PO and none is open, then "ดูการอนุมัติข้าม"', async () => {
    const s = await supplier('RO-BAND')
    const po = await draftPo(s, '10000.00')
    expect(await poRiskStatus(proc(), po.id)).toMatchObject({ decision: { allowed: false, reason: 'NOT_ASSESSED' }, canRequestOverride: true, openOverride: null })
    // FINANCE reads the PO but does not ask
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: NOW } })
    expect(await poRiskStatus(org.ctxOf('fin_officer', NOW), po.id)).toMatchObject({ canRequestOverride: false })
    const r = ok(await request(s, { poId: po.id }))
    expect(await poRiskStatus(proc(), po.id)).toMatchObject({ canRequestOverride: false, openOverride: { id: r.overrideId } })
    expect(ok(await riskOverrideForm(proc(), { poId: po.id }))).toMatchObject({ supplier: { id: s }, po: { id: po.id }, open: { id: r.overrideId }, today: '2026-11-09', lastAllowed: '2027-02-07' })
    // an inactive supplier gets the reason, not the form
    const inactive = await supplier('RO-INACT', { status: 'INACTIVE' })
    expect(await riskOverrideForm(proc(), { supplierId: inactive })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SUPPLIER_INACTIVE' } } })
  })
})

describe('[FR-RSK-203/AC5] [FR-PAY-101/AC13] riskOverridesForPayment: what a payment run weighs for RISK_OVERRIDE_EXPIRED', () => {
  it('the latest approved or expired override of a supplier not yet assessed; nothing once assessed, nothing with RISK off', async () => {
    const lapsed = await supplier('RO-PAY1')
    const renewed = await supplier('RO-PAY2')
    const assessed = await supplier('RO-PAY3')
    const none = await supplier('RO-PAY4')
    const row = (supplierId: string, status: 'APPROVED' | 'EXPIRED' | 'PENDING_APPROVAL', expiresOn: string) =>
      prisma.riskOverride.create({
        data: { organizationId: org.organizationId, number: `RO-T-${randomUUID().slice(0, 8)}`, supplierId, reason: REASON, capGrossSatang: 5_000_000n, expiresOn: new Date(`${expiresOn}T00:00:00Z`), requestedById: org.member.proc_officer!, submittedAt: new Date('2026-09-01T03:00:00Z'), decidedAt: new Date('2026-09-02T03:00:00Z'), status },
      })
    await row(lapsed, 'EXPIRED', '2026-10-01')
    await row(renewed, 'EXPIRED', '2026-10-01')
    await row(renewed, 'APPROVED', '2026-12-31')
    await row(assessed, 'EXPIRED', '2026-10-01')
    await row(none, 'PENDING_APPROVAL', '2026-12-31')
    await prisma.riskAssessment.create({
      data: { organizationId: org.organizationId, number: `RSA-T-${randomUUID().slice(0, 8)}`, supplierId: assessed, questionnaireId, screening: SCREEN_HIGH, categoryCodes: [], payeeType: 'JURISTIC', workScopes: [], inherentTier: 'HIGH', pointsTotal: 45, tier: 'HIGH', status: 'COMPLETED', openedById: org.member.proc_officer!, lastActivityAt: NOW, submittedAt: NOW, completedAt: NOW, completedOn: new Date('2026-11-09'), validUntil: new Date('2027-11-09'), remindOn: new Date('2027-10-10') },
    })
    const read = (orgId: string, ids: string[]) => forTenant(orgId).$transaction((tx) => riskOverridesForPayment(tx, ids, '2026-11-13'))
    const got = await read(org.organizationId, [lapsed, renewed, assessed, none])
    expect(Object.fromEntries(got)).toEqual({ [lapsed]: [{ expiresOn: '2026-10-01' }], [renewed]: [{ expiresOn: '2026-12-31' }] })

    const off = await createP2Org()
    const offSupplier = (await prisma.supplier.create({ data: { organizationId: off.organizationId, code: 'RO-POFF', nameTh: 'ผู้ขายไม่มีโมดูล', isForeign: true } })).id
    await prisma.riskOverride.create({
      data: { organizationId: off.organizationId, number: 'RO-T-OFF', supplierId: offSupplier, reason: REASON, capGrossSatang: 5_000_000n, expiresOn: new Date('2026-10-01T00:00:00Z'), requestedById: off.member.proc_officer!, submittedAt: new Date('2026-09-01T03:00:00Z'), decidedAt: new Date('2026-09-02T03:00:00Z'), status: 'EXPIRED' },
    })
    expect((await read(off.organizationId, [offSupplier])).size).toBe(0)
  })
})
