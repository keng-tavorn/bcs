import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { getPurchaseOrderView } from '@/server/queries/purchase-orders'
import { boardView } from '@/server/services/board'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { createPoChange, submitPoChange } from '@/server/services/purchase-orders/change'
import { sendPurchaseOrder } from '@/server/services/purchase-orders/send'
import { openRiskAssessmentForPo, poRiskStatus, proposeRiskPolicy, proposeRiskTiers, riskGateDryRun } from '@/server/services/risk'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'
import { p2p } from '../support/p2p'

// S11-07 (FR-RSK-203 AC1 AC4 · FR-RSK-201 AC4 · BR-RSK-09 BR-RSK-12 · INV-RSK-01) against Postgres: the gate before a PO
// goes out at po.submit, po.send and a PO change — refused before anything is written (no budget held, no PDF), passed
// with PurchaseOrder.riskGate and its event, an override's cumulative cap counted once per PO and moved by a change, the
// registry flag, the reason a warning needs, and nothing at all with RISK off. Tiers and the policy are test data of the
// organization (the demo values of OQ-221 OQ-222 OQ-227), never code.

const NOW = new Date('2026-11-09T03:00:00Z')
const LATER = new Date('2027-12-01T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const SCREEN_HIGH = { processesPersonalData: 'Y', accessesSystems: 'N', accessesPremises: 'N' } as const
const SCREEN_LOW = { processesPersonalData: 'N', accessesSystems: 'N', accessesPremises: 'N' } as const

let org: DoaOrg
let flow: ReturnType<typeof p2p>
let questionnaireId: string
const proc = (now = NOW) => org.ctxOf('proc_officer', now)

async function riskOn(o: DoaOrg): Promise<string> {
  const id = o.organizationId
  await prisma.orgModule.create({ data: { organizationId: id, module: 'RISK', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
  await prisma.roleAssignment.createMany({ data: [{ organizationId: id, memberId: o.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW }, { organizationId: id, memberId: o.member.admin2!, role: 'ORG_ADMIN', grantedAt: NOW }, { organizationId: id, memberId: o.member.auditor!, role: 'AUDITOR', grantedAt: NOW }] })
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
  return (await prisma.supplier.create({ data: { organizationId: org.organizationId, code, nameTh: `ผู้ขาย ${code}`, isForeign: true, email: `${code.toLowerCase()}@supplier.test`, ...data } })).id
}

/** A draft PO of one approved request (one line at `unitPrice`, VAT 7%) whose request answered `screening` */
async function draftPo(supplierId: string, unitPrice: string, screening: Record<string, string> = SCREEN_LOW, o = org, f = flow) {
  const line = await f.fundedLine(5_000_000n)
  const request = await f.approvedRequest(line, [{ quantity: '1', unitPrice }])
  await prisma.request.update({ where: { id: request.id }, data: { formData: screening } })
  const site = await prisma.deliverySite.create({ data: { organizationId: o.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์ทดสอบ', address: 'ถนนทดสอบ' } })
  await prisma.request.update({ where: { id: request.id }, data: { deliverySiteId: site.id } })
  const c = o.ctxOf('proc_officer', NOW)
  ok(await assignSupplier(c, { requestLineIds: [request.lines[0]!.id], supplierId }, key()))
  const run = ok(await consolidateNow(c, key()))
  return prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id } })
}

/** A COMPLETED assessment of the supplier (as riskAssessment.submit leaves it) and the supplier's projection */
async function completed(supplierId: string, opts: { screening?: Record<string, string>; completedAt?: Date; validUntil?: string; tier?: 'LOW' | 'MEDIUM' | 'HIGH' } = {}) {
  const completedAt = opts.completedAt ?? new Date('2026-11-02T03:00:00Z')
  const tier = opts.tier ?? 'HIGH'
  const a = await prisma.riskAssessment.create({
    data: {
      organizationId: org.organizationId,
      number: `RSA-T-${randomUUID().slice(0, 8)}`,
      supplierId,
      questionnaireId,
      screening: opts.screening ?? SCREEN_HIGH,
      categoryCodes: [],
      payeeType: 'JURISTIC',
      workScopes: [],
      inherentTier: 'HIGH',
      pointsTotal: 45,
      tier,
      status: 'COMPLETED',
      openedById: org.member.proc_officer!,
      lastActivityAt: completedAt,
      submittedAt: completedAt,
      completedAt,
      completedOn: new Date(completedAt.toISOString().slice(0, 10)),
      validUntil: new Date(opts.validUntil ?? '2027-11-02'),
      remindOn: new Date('2027-10-03'),
    },
  })
  await prisma.supplier.update({ where: { id: supplierId }, data: { riskTier: tier, riskStatus: 'CURRENT', currentRiskAssessmentId: a.id } })
  return a
}

async function override(supplierId: string, opts: { cap: bigint; expiresOn?: string; poId?: string; status?: 'APPROVED' | 'PENDING_APPROVAL' }) {
  return prisma.riskOverride.create({
    data: {
      organizationId: org.organizationId,
      number: `RO-T-${randomUUID().slice(0, 8)}`,
      supplierId,
      reason: 'ผู้ขายรายเดียวที่ส่งของได้ทันในสัปดาห์นี้',
      capGrossSatang: opts.cap,
      expiresOn: new Date(opts.expiresOn ?? '2026-12-31'),
      requestedById: org.member.proc_officer!,
      submittedAt: NOW,
      decidedAt: NOW,
      status: opts.status ?? 'APPROVED',
      poId: opts.poId ?? null,
    },
  })
}

const gateOf = async (poId: string) => (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { riskGate: true, riskOverrideId: true, status: true } }))
const eventsOf = (aggregateId: string, type: string) => prisma.event.findMany({ where: { organizationId: org.organizationId, aggregateId, type }, orderBy: { occurredAt: 'asc' } })

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  questionnaireId = await riskOn(org)
  flow = p2p(org, NOW)
})

describe('[FR-RSK-203/AC1] the gate at po.submit (BR-RSK-09)', () => {
  it('a LOW supplier passes NOT_REQUIRED: riskGate and po.risk_gate_passed with the submit', async () => {
    const po = await draftPo(await supplier('RG-LOW'), '1000.00')
    ok(await submitPo(proc(), { poId: po.id }, key()))
    expect(await gateOf(po.id)).toMatchObject({ status: 'PENDING_APPROVAL', riskOverrideId: null, riskGate: { tier: 'LOW', source: 'NOT_REQUIRED', trigger: 'SUBMIT', warnings: [], assessmentId: null, overrideId: null } })
    expect(await eventsOf(po.id, 'po.risk_gate_passed')).toEqual([expect.objectContaining({ data: expect.objectContaining({ tier: 'LOW', inherentTier: 'LOW', source: 'NOT_REQUIRED', trigger: 'SUBMIT' }) })])
  })

  it('HIGH from the screening with no assessment → RISK_ASSESSMENT_REQUIRED NOT_ASSESSED; nothing written (no number, no budget held, no event)', async () => {
    const s = await supplier('RG-NONE')
    const po = await draftPo(s, '1000.00', SCREEN_HIGH)
    expect(await submitPo(proc(), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'RISK_ASSESSMENT_REQUIRED', details: { reason: 'NOT_ASSESSED', tier: 'HIGH', supplierId: s } } })
    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })
    expect(after).toMatchObject({ status: 'DRAFT', number: null, riskGate: null, currentRouteId: null })
    expect(await prisma.budgetAllocation.count({ where: { sourceType: 'PO_LINE', sourceId: { in: (await prisma.poLine.findMany({ where: { poId: po.id } })).map((l) => l.id) } } })).toBe(0)
    expect(await eventsOf(po.id, 'po.submitted')).toHaveLength(0)
  })

  it('an open assessment → IN_PROGRESS; once COMPLETED and covering the PO → passes ASSESSMENT with its id', async () => {
    const s = await supplier('RG-ASM')
    const po = await draftPo(s, '1000.00', SCREEN_HIGH)
    const open = await prisma.riskAssessment.create({
      data: { organizationId: org.organizationId, number: `RSA-T-${randomUUID().slice(0, 8)}`, supplierId: s, questionnaireId, screening: SCREEN_HIGH, categoryCodes: [], payeeType: 'JURISTIC', workScopes: [], inherentTier: 'HIGH', status: 'DRAFT', openedById: org.member.proc_officer!, lastActivityAt: NOW },
    })
    expect(await submitPo(proc(), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'RISK_ASSESSMENT_REQUIRED', details: { reason: 'IN_PROGRESS' } } })
    await prisma.riskAssessment.update({ where: { id: open.id }, data: { status: 'CANCELLED' } })
    const a = await completed(s)
    ok(await submitPo(proc(), { poId: po.id }, key()))
    expect((await gateOf(po.id)).riskGate).toMatchObject({ tier: 'HIGH', source: 'ASSESSMENT', assessmentId: a.id })
  })

  it('a current assessment that does not cover new screening → RISK_REASSESSMENT_REQUIRED SCOPE_EXPANDED', async () => {
    const s = await supplier('RG-SCOPE')
    await completed(s, { screening: SCREEN_LOW, tier: 'HIGH' })
    const po = await draftPo(s, '1000.00', SCREEN_HIGH)
    expect(await submitPo(proc(), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'RISK_REASSESSMENT_REQUIRED', details: { reason: 'SCOPE_EXPANDED' } } })
  })
})

describe('[FR-RSK-203/AC1] the gate again at po.send and at a PO change', () => {
  it('po.send after the assessment lapsed → RISK_REASSESSMENT_REQUIRED VALIDITY_LAPSED, and no PDF or file is made', async () => {
    const s = await supplier('RG-SEND')
    await completed(s, { validUntil: '2027-11-02' })
    const po = await draftPo(s, '1000.00', SCREEN_HIGH)
    ok(await submitPo(proc(), { poId: po.id }, key()))
    await flow.approveAll(po.id)
    const files = await prisma.fileObject.count({ where: { organizationId: org.organizationId } })
    expect(await sendPurchaseOrder(proc(LATER), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'RISK_REASSESSMENT_REQUIRED', details: { reason: 'VALIDITY_LAPSED' } } })
    expect(await prisma.fileObject.count({ where: { organizationId: org.organizationId } })).toBe(files)
    expect(await prisma.fileLink.count({ where: { subjectType: 'PurchaseOrder', subjectId: po.id, kind: 'PO_PDF' } })).toBe(0)
    expect((await gateOf(po.id)).status).toBe('APPROVED')
  })

  it('an override lets out POs up to its cumulative cap: counted once per PO (submit then send), the next PO over the cap refused', async () => {
    const s = await supplier('RG-OVR')
    const o = await override(s, { cap: 15_000_000n })
    // 100,000.00 + VAT 7,000.00 = 107,000.00 gross
    const first = await draftPo(s, '100000.00', SCREEN_HIGH)
    ok(await submitPo(proc(), { poId: first.id }, key()))
    expect(await gateOf(first.id)).toMatchObject({ riskOverrideId: o.id, riskGate: { source: 'OVERRIDE', overrideId: o.id, warnings: ['OVERRIDE_USED'], countedGrossSatang: '10700000' } })
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ usedCount: 1, usedGrossSatang: 10_700_000n })
    await flow.approveAll(first.id)
    ok(await sendPurchaseOrder(proc(), { poId: first.id }, key()))
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ usedCount: 1, usedGrossSatang: 10_700_000n })
    expect((await gateOf(first.id)).riskGate).toMatchObject({ source: 'OVERRIDE', trigger: 'SEND' })
    expect(await eventsOf(o.id, 'risk_override.used')).toHaveLength(1)
    // AUDITOR hears of it in the day's digest, once per PO (FR-RSK-203 AC6)
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, templateKey: 'risk.override_used', subjectId: first.id, recipientMemberId: org.member.auditor! } })).toBe(1)

    const second = await draftPo(s, '100000.00', SCREEN_HIGH)
    expect(await submitPo(proc(), { poId: second.id }, key())).toMatchObject({ ok: false, error: { code: 'RISK_BLOCKED', details: { reason: 'OVERRIDE_CAP_EXCEEDED', overrideId: o.id } } })
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ usedCount: 1, usedGrossSatang: 10_700_000n })
  })

  it('a PO change over the cap is refused at its submit; one within it moves the PO’s share when it is approved', async () => {
    const s = await supplier('RG-CHG')
    const o = await override(s, { cap: 15_000_000n })
    const po = await draftPo(s, '100000.00', SCREEN_HIGH)
    ok(await submitPo(proc(), { poId: po.id }, key()))
    await flow.approveAll(po.id)
    const line = (await prisma.poLine.findFirstOrThrow({ where: { poId: po.id } })).id
    // 500,000.00: the PO let out on a 150,000.00 override becomes 535,000.00 gross (GC-RSK-58)
    const tooMuch = ok(await createPoChange(proc(), { poId: po.id, reason: 'ผู้ขายขอเพิ่มราคา', lines: [{ poLineId: line, newUnitPrice: '500000.00' }] }, key()))
    const version = (await prisma.poChange.findUniqueOrThrow({ where: { id: tooMuch.poChangeId } })).version
    expect(await submitPoChange(proc(), { poChangeId: tooMuch.poChangeId, version }, key())).toMatchObject({ ok: false, error: { code: 'RISK_BLOCKED', details: { reason: 'OVERRIDE_CAP_EXCEEDED' } } })
    expect(await prisma.poChange.findUniqueOrThrow({ where: { id: tooMuch.poChangeId } })).toMatchObject({ status: 'DRAFT', currentRouteId: null })
    await prisma.poChange.update({ where: { id: tooMuch.poChangeId }, data: { status: 'CANCELLED' } })

    // 130,000.00 + VAT 9,100.00 = 139,100.00 ≤ 150,000.00: approved by DOA PO_CHANGE, the override now holds 139,100.00
    const fits = ok(await createPoChange(proc(), { poId: po.id, reason: 'ผู้ขายขอเพิ่มราคา', lines: [{ poLineId: line, newUnitPrice: '130000.00' }] }, key()))
    ok(await submitPoChange(proc(), { poChangeId: fits.poChangeId, version: (await prisma.poChange.findUniqueOrThrow({ where: { id: fits.poChangeId } })).version }, key()))
    await flow.approveAll(fits.poChangeId)
    expect(await prisma.poChange.findUniqueOrThrow({ where: { id: fits.poChangeId } })).toMatchObject({ status: 'APPROVED', appliedRevisionNo: 1 })
    expect(await gateOf(po.id)).toMatchObject({ riskOverrideId: o.id, riskGate: { source: 'OVERRIDE', trigger: 'PO_CHANGE', countedGrossSatang: '13910000' } })
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ usedCount: 1, usedGrossSatang: 13_910_000n })
    expect(await eventsOf(o.id, 'risk_override.used')).toHaveLength(1)
  })

  it('a PO that drew on an override and now passes on a completed assessment gives its share back', async () => {
    const s = await supplier('RG-REL')
    const o = await override(s, { cap: 15_000_000n })
    const po = await draftPo(s, '100000.00', SCREEN_HIGH)
    ok(await submitPo(proc(), { poId: po.id }, key()))
    await flow.approveAll(po.id)
    const a = await completed(s)
    ok(await sendPurchaseOrder(proc(), { poId: po.id }, key()))
    expect(await gateOf(po.id)).toMatchObject({ riskOverrideId: null, riskGate: { source: 'ASSESSMENT', assessmentId: a.id, trigger: 'SEND' } })
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ usedCount: 0, usedGrossSatang: 0n })
    expect(await eventsOf(o.id, 'risk_override.released')).toEqual([expect.objectContaining({ data: { poId: po.id, grossSatang: '10700000', trigger: 'SEND' } })])
  })
})

describe('[FR-RSK-203/AC4] the registry flag (BR-RSK-12 · OQ-227)', () => {
  it('CEASED blocks every tier, even with a completed assessment and an override', async () => {
    const s = await supplier('RG-CEASED', { registryFlag: 'CEASED', registryFlaggedAt: new Date('2026-10-01T03:00:00Z') })
    await completed(s)
    await override(s, { cap: 50_000_000n })
    const po = await draftPo(s, '1000.00', SCREEN_LOW)
    expect(await submitPo(proc(), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'RISK_BLOCKED', details: { reason: 'REGISTRY_CEASED' } } })
  })

  it('VAT_CANCELLED blocks until an assessment completes after the flag', async () => {
    const s = await supplier('RG-VAT', { registryFlag: 'VAT_CANCELLED', registryFlaggedAt: new Date('2026-11-05T03:00:00Z') })
    const before = await completed(s, { tier: 'LOW', screening: SCREEN_LOW, completedAt: new Date('2026-11-01T03:00:00Z') })
    const po = await draftPo(s, '1000.00', SCREEN_LOW)
    expect(await submitPo(proc(), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'RISK_BLOCKED', details: { reason: 'REGISTRY_FLAGGED' } } })
    // the reassessment completes after the flag (the assessment row stands in for the new one)
    await prisma.riskAssessment.update({ where: { id: before.id }, data: { completedAt: new Date('2026-11-06T03:00:00Z'), completedOn: new Date('2026-11-06') } })
    ok(await submitPo(proc(), { poId: po.id }, key()))
    expect((await gateOf(po.id)).riskGate).toMatchObject({ tier: 'LOW', source: 'NOT_REQUIRED', warnings: [] })
  })

  it('with registryFlagBlocks off the flag is a warning that needs a reason: refused without one, kept with the PO and carried to its send', async () => {
    const o = await createP2Org()
    const qid = questionnaireId
    questionnaireId = await riskOn(o)
    await prisma.riskPolicy.update({ where: { organizationId: o.organizationId }, data: { registryFlagBlocks: false } })
    const saved = org
    org = o
    const f = p2p(o, NOW)
    try {
      const s = await supplier('RG-WARN', { registryFlag: 'CEASED', registryFlaggedAt: new Date('2026-10-01T03:00:00Z') })
      const po = await draftPo(s, '1000.00', SCREEN_LOW, o, f)
      expect(await submitPo(proc(), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'riskReason', reason: 'RISK_REASON_REQUIRED', warnings: ['REGISTRY_FLAGGED'] } } })
      ok(await submitPo(proc(), { poId: po.id, riskReason: 'ผู้ขายแจ้งว่าจดทะเบียนใหม่แล้ว รอทะเบียนปรับ' }, key()))
      const gate = (await gateOf(po.id)).riskGate as { reasonCommentId: string; warnings: string[]; reasonFor: string[] }
      expect(gate).toMatchObject({ source: 'NOT_REQUIRED', warnings: ['REGISTRY_FLAGGED'], reasonFor: ['REGISTRY_FLAGGED'] })
      expect(await prisma.comment.findUniqueOrThrow({ where: { id: gate.reasonCommentId } })).toMatchObject({ subjectType: 'PurchaseOrder', subjectId: po.id, body: 'ผู้ขายแจ้งว่าจดทะเบียนใหม่แล้ว รอทะเบียนปรับ' })
      await f.approveAll(po.id)
      ok(await sendPurchaseOrder(proc(), { poId: po.id }, key()))
      expect((await gateOf(po.id)).riskGate).toMatchObject({ trigger: 'SEND', reasonCommentId: gate.reasonCommentId })
    } finally {
      org = saved
      questionnaireId = qid
    }
  })
})

describe('[FR-RSK-201/AC4] a proposal waiting for someone else changes nothing at the gate (BR-RSK-02)', () => {
  it('HIGH proposed not to block and the flag proposed to warn: both still block until confirmed', async () => {
    const s = await supplier('RG-PEND', { registryFlag: 'VAT_CANCELLED', registryFlaggedAt: new Date('2026-10-01T03:00:00Z') })
    const po = await draftPo(s, '1000.00', SCREEN_HIGH)
    const admin = org.ctxOf('admin', NOW)
    ok(await proposeRiskTiers(admin, { changes: { HIGH: { blocksPo: false } } }, key()))
    ok(await proposeRiskPolicy(admin, { changes: { registryFlagBlocks: false } }, key()))
    expect(await submitPo(proc(), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'RISK_BLOCKED', details: { reason: 'REGISTRY_FLAGGED' } } })
    await prisma.supplier.update({ where: { id: s }, data: { registryFlag: 'NONE', registryFlaggedAt: null } })
    expect(await submitPo(proc(), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'RISK_ASSESSMENT_REQUIRED', details: { reason: 'NOT_ASSESSED' } } })
  })
})

describe('[FR-RSK-203/AC1] RISK off: the PO goes out as before', () => {
  it('a HIGH screening in an organization without RISK submits and sends with no gate written', async () => {
    const off = await createP2Org()
    const f = p2p(off, NOW)
    const s = (await prisma.supplier.create({ data: { organizationId: off.organizationId, code: 'RG-OFF', nameTh: 'ปิด', isForeign: true, email: 'off@supplier.test' } })).id
    const po = await draftPo(s, '1000.00', SCREEN_HIGH, off, f)
    ok(await submitPo(off.ctxOf('proc_officer', NOW), { poId: po.id }, key()))
    await f.approveAll(po.id)
    ok(await sendPurchaseOrder(off.ctxOf('proc_officer', NOW), { poId: po.id }, key()))
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).toMatchObject({ status: 'SENT', riskGate: null, riskOverrideId: null })
    expect(await prisma.event.count({ where: { organizationId: off.organizationId, type: 'po.risk_gate_passed' } })).toBe(0)
  })
})

describe('[FR-RSK-203/AC6] what the screens show of the gate', () => {
  it('the PO page: why a draft is held, the assessment it opens from the PO, and the gate the PO passed in its facts', async () => {
    const s = await supplier('RG-UI')
    const po = await draftPo(s, '1000.00', SCREEN_HIGH)
    expect(await poRiskStatus(proc(), po.id)).toMatchObject({ trigger: 'SUBMIT', tier: 'HIGH', decision: { allowed: false, error: 'RISK_ASSESSMENT_REQUIRED', reason: 'NOT_ASSESSED' }, openAssessment: null, canOpenAssessment: true })
    // AUDITOR reads every PO but does not open an assessment (risk.assessment.manage is PROCUREMENT's); a requester reads none
    expect(await poRiskStatus(org.ctxOf('auditor', NOW), po.id)).toMatchObject({ canOpenAssessment: false })
    expect(await poRiskStatus(org.ctxOf('req_con', NOW), po.id)).toBeNull()
    expect(await openRiskAssessmentForPo(org.ctxOf('auditor', NOW), po.id, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const opened = ok(await openRiskAssessmentForPo(proc(), po.id, key()))
    expect(await prisma.riskAssessment.findUniqueOrThrow({ where: { id: opened.assessmentId } })).toMatchObject({ supplierId: s, triggerPoId: po.id, screening: SCREEN_HIGH })
    expect(await poRiskStatus(proc(), po.id)).toMatchObject({ decision: { reason: 'IN_PROGRESS' }, openAssessment: { id: opened.assessmentId }, canOpenAssessment: false })

    const o = await override(s, { cap: 50_000_000n })
    expect(await poRiskStatus(proc(), po.id)).toMatchObject({ decision: { allowed: true, source: 'OVERRIDE' }, override: { id: o.id, number: o.number }, reasonNeeded: [] })
    ok(await submitPo(proc(), { poId: po.id }, key()))
    const view = await getPurchaseOrderView(proc(), po.id)
    expect(view!.riskGate).toMatchObject({ tier: 'HIGH', source: 'OVERRIDE', trigger: 'SUBMIT', override: { id: o.id, number: o.number }, assessment: null, warnings: ['OVERRIDE_USED'], reasoned: false })
    // waiting for approval, the PO meets no gate until it is sent: the band says nothing
    expect(await poRiskStatus(proc(), po.id)).toBeNull()
  })

  it('the board: "PO ติดด่านความเสี่ยง" lists a PO waiting for approval whose sending the gate would refuse now', async () => {
    const s = await supplier('RG-BOARD')
    const o = await override(s, { cap: 50_000_000n, expiresOn: '2026-11-20' })
    const po = await draftPo(s, '1000.00', SCREEN_HIGH)
    ok(await submitPo(proc(), { poId: po.id }, key()))
    const ids = async (now: Date) => ok(await boardView(org.ctxOf('proc_officer', now), { riskGated: true })).rows.flatMap((r) => r.tasks.map((t) => t.subjectId))
    expect(await ids(NOW)).not.toContain(po.id)
    // the override's last day passed while the PO waited: approved, it could not go out
    expect(await ids(new Date('2026-11-21T03:00:00Z'))).toContain(po.id)
    expect(ok(await boardView(org.ctxOf('proc_officer', NOW))).riskFilter).toBe(true)
    await prisma.riskOverride.update({ where: { id: o.id }, data: { expiresOn: new Date('2026-12-31') } })
  })

  it('the modules page: how many POs not yet out the gate would hold if RISK were switched on — the BCS team only', async () => {
    const off = await createP2Org()
    const f = p2p(off, NOW)
    await riskOn(off)
    await prisma.orgModule.updateMany({ where: { organizationId: off.organizationId, module: 'RISK' }, data: { enabled: false } })
    const held = (await prisma.supplier.create({ data: { organizationId: off.organizationId, code: 'RG-DRY', nameTh: 'ทดลอง', isForeign: true, email: 'dry@supplier.test' } })).id
    await draftPo(held, '1000.00', SCREEN_HIGH, off, f)
    await draftPo(held, '1000.00', SCREEN_LOW, off, f)
    const admin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
    const platform = makeCtx({ organizationId: off.organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: admin.id }, channel: 'WEB', now: NOW })
    expect(await riskGateDryRun(platform)).toEqual({ ok: true, data: { kind: 'COUNTED', open: 2, held: 1 } })
    expect(await riskGateDryRun(off.ctxOf('admin', NOW))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    await prisma.riskPolicy.update({ where: { organizationId: off.organizationId }, data: { confirmedById: null, confirmedAt: null } })
    expect(await riskGateDryRun(platform)).toEqual({ ok: true, data: { kind: 'NOT_CONFIGURED', code: 'RISK_POLICY_NOT_CONFIGURED' } })
    // nothing written by the count
    expect((await prisma.purchaseOrder.findMany({ where: { organizationId: off.organizationId }, select: { riskGate: true } })).every((p) => p.riskGate === null)).toBe(true)
  })
})

describe('[INV-RSK-01] every PO that went out in an organization with RISK has its gate; an override holds exactly its POs', () => {
  it('scans the POs and overrides this file left', async () => {
    const pos = await prisma.purchaseOrder.findMany({ where: { organizationId: org.organizationId, status: { notIn: ['DRAFT', 'CANCELLED'] } }, select: { id: true, riskGate: true, grossSatang: true, riskOverrideId: true } })
    expect(pos.length).toBeGreaterThan(0)
    for (const po of pos) {
      const gate = po.riskGate as { tier: string; source: string; assessmentId: string | null; overrideId: string | null } | null
      expect(gate, po.id).not.toBeNull()
      if (gate!.tier === 'HIGH') expect(['ASSESSMENT', 'OVERRIDE']).toContain(gate!.source)
      if (gate!.source === 'ASSESSMENT') expect(gate!.assessmentId).not.toBeNull()
      if (gate!.source === 'OVERRIDE') expect(gate!.overrideId).toBe(po.riskOverrideId)
    }
    for (const o of await prisma.riskOverride.findMany({ where: { organizationId: org.organizationId } })) {
      const drawing = await prisma.purchaseOrder.findMany({ where: { riskOverrideId: o.id }, select: { grossSatang: true } })
      expect(o.usedCount, o.id).toBe(drawing.length)
      expect(o.usedGrossSatang, o.id).toBe(drawing.reduce((a, p) => a + p.grossSatang, 0n))
      expect(o.usedGrossSatang <= o.capGrossSatang).toBe(true)
    }
  })
})
