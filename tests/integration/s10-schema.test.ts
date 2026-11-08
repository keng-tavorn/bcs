import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { testAppUrl, testMigratorUrl } from '../support/test-db'

// S10-01 (docs/sub-specs/S10.md "Entity และ migration" · ADR-201 to ADR-207): the one migration of S10 against real
// Postgres (ADR-027) — the CHECKs, partial uniques and the append-only trigger hold what the services of S10-04 to
// S10-13 will rely on: THB only, one open RFx per request line, one bid per supplier, one PRICE criterion, one open
// award, gross = net + vat.

const NOW = new Date('2026-11-08T03:00:00Z')
let orgId: string
let memberId: string
let departmentId: string
let supplierId: string
let otherSupplierId: string
let contactId: string
let requestLineIds: string[] = []
let app: pg.Client
let migrator: pg.Client

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { code: `S10-${randomUUID().slice(0, 8)}`, legalNameTh: 'S10 schema', taxId: '0999999000055', settings: {} } })
  orgId = org.id
  memberId = (await prisma.member.create({ data: { organizationId: orgId, displayNameTh: 'จัดซื้อ', email: `s10-${randomUUID().slice(0, 8)}@test.bcs.local`, status: 'ACTIVE' } })).id
  departmentId = (await prisma.department.create({ data: { organizationId: orgId, code: 'PROC', nameTh: 'จัดซื้อ', kind: 'COMPANY' } })).id
  supplierId = (await prisma.supplier.create({ data: { organizationId: orgId, code: 'S10-A', nameTh: 'ผู้ขาย A', taxId: '0105555000011' } })).id
  otherSupplierId = (await prisma.supplier.create({ data: { organizationId: orgId, code: 'S10-B', nameTh: 'ผู้ขาย B', taxId: '0105555000029' } })).id
  contactId = (await prisma.supplierContact.create({ data: { organizationId: orgId, supplierId, nameTh: 'ผู้ติดต่อ', email: `c-${randomUUID().slice(0, 8)}@supplier.test` } })).id
  const type = await prisma.requestType.create({ data: { organizationId: orgId, code: 'S10', nameTh: 'ขอซื้อ', documentType: 'PURCHASE_REQUEST' } })
  const form = await prisma.formVersion.create({ data: { organizationId: orgId, requestTypeId: type.id, versionNo: 1, schema: {} } })
  const request = await prisma.request.create({
    data: {
      organizationId: orgId,
      requestTypeId: type.id,
      formVersionId: form.id,
      documentType: 'PURCHASE_REQUEST',
      title: 'เหล็กเส้น',
      requesterMemberId: memberId,
      requesterDepartmentId: departmentId,
      chargedDepartmentId: departmentId,
      lines: {
        create: [1, 2].map((lineNo) => ({ lineNo, description: `เหล็ก ${lineNo}`, categoryCode: 'STEEL', quantity: '10', uom: 'เส้น', unitPriceSatang: 10_000n, netSatang: 100_000n })),
      },
    },
    include: { lines: true },
  })
  requestLineIds = request.lines.map((l) => l.id)
  app = new pg.Client({ connectionString: testAppUrl() })
  migrator = new pg.Client({ connectionString: testMigratorUrl() })
  await Promise.all([app.connect(), migrator.connect()])
})

afterAll(async () => {
  await Promise.all([app.end(), migrator.end()])
})

const rfx = (data: Record<string, unknown> = {}) =>
  prisma.rfxEvent.create({
    data: { organizationId: orgId, kind: 'RFQ', title: 'เหล็กเส้น', description: 'ขอราคา', categoryCode: 'STEEL', sourceKind: 'REQUEST_LINES', requestingDepartmentId: departmentId, createdById: memberId, minInvites: 3, ...data },
  })
const line = (rfxEventId: string, lineNo = 1) => prisma.rfxLine.create({ data: { organizationId: orgId, rfxEventId, lineNo, description: 'เหล็ก', categoryCode: 'STEEL', quantity: '10', uom: 'เส้น' } })
const invite = (rfxEventId: string, data: Record<string, unknown> = {}) =>
  prisma.rfxInvite.create({ data: { organizationId: orgId, rfxEventId, supplierId, contactId, invitedById: memberId, invitedAt: NOW, ...data } })
const bid = (rfxEventId: string, inviteId: string, data: Record<string, unknown> = {}) => prisma.bid.create({ data: { organizationId: orgId, rfxEventId, inviteId, supplierId, ...data } })

describe('[BR-RFX-01] [BR-RFX-02] an RFx: THB only, its number and times once open, an RFI without a scorecard', () => {
  it('refuses another currency, a close before the open, and an RFx past DRAFT without its number', async () => {
    await expect(rfx({ currency: 'USD' })).rejects.toThrow(/rfx_event_shape/)
    await expect(rfx({ openedAt: NOW, closesAt: new Date(NOW.getTime() - 1) })).rejects.toThrow(/rfx_event_shape/)
    await expect(rfx({ status: 'OPEN' })).rejects.toThrow(/rfx_event_shape/)
    const open = await rfx({ status: 'OPEN', number: `RFX-2569-${randomUUID().slice(0, 5)}`, openedAt: NOW, openedById: memberId, closesAt: new Date('2026-11-12T03:00:00Z') })
    expect(open.currency).toBe('THB')
    await expect(prisma.rfxEvent.update({ where: { id: open.id }, data: { status: 'CLOSED' } })).rejects.toThrow(/rfx_event_shape/)
    await expect(prisma.rfxEvent.update({ where: { id: open.id }, data: { status: 'CANCELLED' } })).rejects.toThrow(/rfx_event_shape/)
    await expect(prisma.rfxEvent.update({ where: { id: open.id }, data: { status: 'CANCELLED', cancelReason: 'ยกเลิก', cancelledAt: NOW } })).resolves.toBeTruthy()
  })

  it('an RFI has no scorecard and concludes with a note; an RFQ never concludes', async () => {
    const rfi = await rfx({ kind: 'RFI' })
    const scorecard = await prisma.scorecard.create({ data: { organizationId: orgId, rfxEventId: rfi.id } })
    await expect(prisma.rfxEvent.update({ where: { id: rfi.id }, data: { scorecardId: scorecard.id } })).rejects.toThrow(/rfx_event_shape/)
    const opened = { number: `RFX-2569-${randomUUID().slice(0, 5)}`, openedAt: NOW, openedById: memberId, closesAt: new Date('2026-11-12T03:00:00Z'), closedAt: new Date('2026-11-12T03:00:00Z') }
    await expect(rfx({ ...opened, status: 'CONCLUDED', conclusionNote: 'สรุป' })).rejects.toThrow(/rfx_event_shape/)
    await expect(rfx({ ...opened, kind: 'RFI', status: 'CONCLUDED' })).rejects.toThrow(/rfx_event_shape/)
    await expect(rfx({ ...opened, kind: 'RFI', status: 'CONCLUDED', conclusionNote: 'สรุป' })).resolves.toBeTruthy()
  })
})

describe('[INV-RFX-03] a request line is in one open RFx at most; RequestLine.rfxEventId is the projection', () => {
  it('a second active source of the same request line is refused; an inactive one frees it', async () => {
    const first = await line((await rfx()).id)
    const second = await line((await rfx()).id)
    const source = await prisma.rfxLineSource.create({ data: { organizationId: orgId, rfxLineId: first.id, requestLineId: requestLineIds[0]!, quantity: '10' } })
    await expect(prisma.rfxLineSource.create({ data: { organizationId: orgId, rfxLineId: second.id, requestLineId: requestLineIds[0]!, quantity: '10' } })).rejects.toThrow(/Unique constraint/)
    await prisma.rfxLineSource.update({ where: { id: source.id }, data: { active: false } })
    await expect(prisma.rfxLineSource.create({ data: { organizationId: orgId, rfxLineId: second.id, requestLineId: requestLineIds[0]!, quantity: '10' } })).resolves.toBeTruthy()
    await expect(prisma.rfxLineSource.create({ data: { organizationId: orgId, rfxLineId: second.id, requestLineId: requestLineIds[1]!, quantity: '0' } })).rejects.toThrow(/rfx_line_source_quantity/)
    await prisma.requestLine.update({ where: { id: requestLineIds[0]! }, data: { rfxEventId: second.rfxEventId } })
    expect((await prisma.requestLine.findUniqueOrThrow({ where: { id: requestLineIds[0]! } })).rfxEventId).toBe(second.rfxEventId)
  })

  it('an RFx line has a positive quantity, and a reference price with its source or neither', async () => {
    const event = await rfx()
    const base = { organizationId: orgId, rfxEventId: event.id, description: 'เหล็ก', categoryCode: 'STEEL', uom: 'เส้น' }
    await expect(prisma.rfxLine.create({ data: { ...base, lineNo: 1, quantity: '0' } })).rejects.toThrow(/rfx_line_shape/)
    await expect(prisma.rfxLine.create({ data: { ...base, lineNo: 1, quantity: '1', refUnitPriceSatang: 100n } })).rejects.toThrow(/rfx_line_shape/)
    await expect(prisma.rfxLine.create({ data: { ...base, lineNo: 1, quantity: '1', refUnitPriceSatang: 100n, refSource: 'HISTORY' } })).resolves.toBeTruthy()
  })
})

describe('[BR-RFX-03] [ADR-203] an invite names a supplier or an application, once per RFx', () => {
  it('one invite per supplier per RFx; an invite of nobody is refused', async () => {
    const event = await rfx()
    await invite(event.id)
    await expect(invite(event.id)).rejects.toThrow(/Unique constraint/)
    await expect(invite(event.id, { supplierId: null })).rejects.toThrow(/rfx_invite_shape/)
    await expect(invite(event.id, { supplierId: otherSupplierId, status: 'DECLINED' })).rejects.toThrow(/rfx_invite_shape/)
  })
})

describe('[BR-RFX-04] questions and answers', () => {
  it('a question up to 2,000 characters; an answered one names its answer and who answered', async () => {
    const event = await rfx()
    const inv = await invite(event.id)
    const q = { organizationId: orgId, rfxEventId: event.id, inviteId: inv.id, askedByContactId: contactId, askedAt: NOW }
    await expect(prisma.rfxQuestion.create({ data: { ...q, question: 'ก'.repeat(2001) } })).rejects.toThrow(/rfx_question_shape/)
    const asked = await prisma.rfxQuestion.create({ data: { ...q, question: 'ส่งได้เมื่อไร' } })
    await expect(prisma.rfxQuestion.update({ where: { id: asked.id }, data: { status: 'ANSWERED' } })).rejects.toThrow(/rfx_question_shape/)
    await expect(prisma.rfxQuestion.update({ where: { id: asked.id }, data: { status: 'ANSWERED', answer: 'ภายใน 7 วัน', answeredById: memberId, answeredAt: NOW } })).resolves.toBeTruthy()
  })
})

describe('[BR-RFX-05] amendments are append-only and only move the close later', () => {
  it('refuses a revision below 2 and an earlier close; UPDATE and DELETE are refused to the app role and by the trigger', async () => {
    const event = await rfx()
    const a = { organizationId: orgId, rfxEventId: event.id, summary: 'เลื่อนวันปิดรับ', createdById: memberId }
    await expect(prisma.rfxAmendment.create({ data: { ...a, revisionNo: 1 } })).rejects.toThrow(/rfx_amendment_shape/)
    await expect(prisma.rfxAmendment.create({ data: { ...a, revisionNo: 2, previousClosesAt: new Date('2026-11-12T03:00:00Z'), newClosesAt: new Date('2026-11-11T03:00:00Z') } })).rejects.toThrow(/rfx_amendment_shape/)
    const row = await prisma.rfxAmendment.create({ data: { ...a, revisionNo: 2, previousClosesAt: new Date('2026-11-12T03:00:00Z'), newClosesAt: new Date('2026-11-14T03:00:00Z') } })
    expect(await sqlError(app, `update "RfxAmendment" set summary = 'x' where id = $1`, [row.id])).toBe('42501')
    expect(await sqlError(app, `delete from "RfxAmendment" where id = $1`, [row.id])).toBe('42501')
    expect(await sqlError(migrator, `update "RfxAmendment" set summary = 'x' where id = $1`, [row.id])).toBeDefined()
    const triggers = await migrator.query(`select tgname from pg_trigger where tgrelid = '"RfxAmendment"'::regclass and not tgisinternal`)
    expect(triggers.rows.map((r: { tgname: string }) => r.tgname)).toContain('rfx_amendment_append_only')
  })
})

describe('[INV-RFX-02] [BR-RFX-08] one bid per supplier per RFx; gross = net + vat; a submitted bid is complete', () => {
  it('a second bid of the same supplier is refused; amounts must add up', async () => {
    const event = await rfx()
    const inv = await invite(event.id)
    await bid(event.id, inv.id)
    await expect(bid(event.id, inv.id)).rejects.toThrow(/Unique constraint/)
    const other = await rfx()
    const otherInvite = await invite(other.id)
    await expect(bid(other.id, otherInvite.id, { netSatang: 100n, vatSatang: 7n, grossSatang: 108n })).rejects.toThrow(/bid_shape/)
    await expect(bid(other.id, otherInvite.id, { status: 'SUBMITTED', submittedAt: NOW, submittedByContactId: contactId })).rejects.toThrow(/bid_shape/)
    await expect(
      bid(other.id, otherInvite.id, { status: 'SUBMITTED', submittedAt: NOW, submittedByContactId: contactId, submittedByMemberId: memberId, vatRateBp: 700, validUntil: new Date('2026-12-08'), revisionNoAtSubmit: 1 }),
    ).rejects.toThrow(/bid_shape/)
    const submitted = await bid(other.id, otherInvite.id, {
      status: 'SUBMITTED',
      submittedAt: NOW,
      submittedByContactId: contactId,
      vatRateBp: 700,
      validUntil: new Date('2026-12-08'),
      revisionNoAtSubmit: 1,
      netSatang: 100n,
      vatSatang: 7n,
      grossSatang: 107n,
    })
    expect(submitted.grossSatang).toBe(107n)
  })

  it('a line not offered has no price; an offered line has a positive price', async () => {
    const event = await rfx()
    const rl = await line(event.id)
    const b = await bid(event.id, (await invite(event.id)).id)
    const base = { organizationId: orgId, bidId: b.id, rfxLineId: rl.id }
    await expect(prisma.bidLine.create({ data: { ...base, offered: false, unitPriceSatang: 100n } })).rejects.toThrow(/bid_line_shape/)
    await expect(prisma.bidLine.create({ data: { ...base, offered: true } })).rejects.toThrow(/bid_line_shape/)
    await expect(prisma.bidLine.create({ data: { ...base, offered: true, unitPriceSatang: 0n } })).rejects.toThrow(/bid_line_shape/)
    await expect(prisma.bidLine.create({ data: { ...base, offered: true, unitPriceSatang: 12_500n, lineQuotedSatang: 125_000n, lineNetSatang: 125_000n } })).resolves.toBeTruthy()
  })
})

describe('[BR-RFX-09] [INV-RFX-02] scorecards: one PRICE criterion, weights and scores in range', () => {
  it('one PRICE criterion per scorecard; weights 0..10000; scores 0..100; a REVEALED one says when', async () => {
    const event = await rfx()
    const card = await prisma.scorecard.create({ data: { organizationId: orgId, rfxEventId: event.id } })
    const c = { organizationId: orgId, scorecardId: card.id, nameTh: 'ราคา' }
    const price = await prisma.scoreCriterion.create({ data: { ...c, code: 'PRICE', kind: 'PRICE', weightBp: 7000 } })
    await expect(prisma.scoreCriterion.create({ data: { ...c, code: 'PRICE2', kind: 'PRICE', weightBp: 1000 } })).rejects.toThrow(/Unique constraint/)
    await expect(prisma.scoreCriterion.create({ data: { ...c, code: 'QUALITY', kind: 'QUALITY', weightBp: 10001 } })).rejects.toThrow(/score_criterion_shape/)
    const quality = await prisma.scoreCriterion.create({ data: { ...c, code: 'QUALITY', kind: 'QUALITY', weightBp: 3000 } })
    expect(price.weightBp + quality.weightBp).toBe(10000)
    const b = await bid(event.id, (await invite(event.id)).id)
    const e = { organizationId: orgId, scorecardId: card.id, criterionId: quality.id, bidId: b.id, evaluatorMemberId: memberId }
    await expect(prisma.scoreEntry.create({ data: { ...e, score: 101 } })).rejects.toThrow(/score_entry_shape/)
    await expect(prisma.scoreEntry.create({ data: { ...e, score: 80 } })).resolves.toBeTruthy()
    await expect(prisma.scorecard.update({ where: { id: card.id }, data: { status: 'REVEALED', lockedAt: NOW } })).rejects.toThrow(/scorecard_shape/)
    await expect(prisma.scorecard.update({ where: { id: card.id }, data: { status: 'LOCKED', lockedAt: NOW } })).resolves.toBeTruthy()
    const evaluator = await prisma.scorecardEvaluator.create({ data: { organizationId: orgId, scorecardId: card.id, memberId, assignedAt: NOW } })
    await expect(prisma.scorecardEvaluator.update({ where: { id: evaluator.id }, data: { status: 'RECUSED' } })).rejects.toThrow(/scorecard_evaluator_shape/)
  })
})

describe('[BR-RFX-12] [BR-DOA-27] awards: one open per RFx, a positive amount, gross = net + vat', () => {
  it('a second open award is refused; a cancelled one frees the RFx; amounts must add up and be positive', async () => {
    const event = await rfx()
    const a = { organizationId: orgId, rfxEventId: event.id, createdById: memberId, netSatang: 100_000n, vatSatang: 7_000n, grossSatang: 107_000n }
    const first = await prisma.awardDecision.create({ data: a })
    await expect(prisma.awardDecision.create({ data: a })).rejects.toThrow(/Unique constraint/)
    await prisma.awardDecision.update({ where: { id: first.id }, data: { status: 'CANCELLED', cancelReason: 'ทำใหม่', cancelledAt: NOW } })
    await expect(prisma.awardDecision.create({ data: { ...a, grossSatang: 107_001n } })).rejects.toThrow(/award_decision_shape/)
    await expect(prisma.awardDecision.create({ data: { ...a, netSatang: 0n, vatSatang: 0n, grossSatang: 0n } })).rejects.toThrow(/award_decision_shape/)
    await expect(prisma.awardDecision.create({ data: { ...a, status: 'PENDING_APPROVAL' } })).rejects.toThrow(/award_decision_shape/)
    await expect(prisma.awardDecision.create({ data: { ...a, poStatus: 'PENDING_PRICE' } })).rejects.toThrow(/award_decision_shape/)
    const second = await prisma.awardDecision.create({ data: a })
    const rl = await line(event.id)
    const b = await bid(event.id, (await invite(event.id)).id)
    const l = { organizationId: orgId, awardDecisionId: second.id, rfxLineId: rl.id, bidId: b.id, supplierId, unitPriceSatang: 10_000n, lineNetSatang: 100_000n }
    await expect(prisma.awardLine.create({ data: { ...l, quantity: '10', vatRateBp: 10001 } })).rejects.toThrow(/award_line_shape/)
    await expect(prisma.awardLine.create({ data: { ...l, quantity: '10', vatRateBp: 700 } })).resolves.toBeTruthy()
  })
})

describe('[BR-RFX-14] [BR-FORM-12] preferred suppliers and the reason for choosing another', () => {
  it('a window [validFrom, validTo); one from an award names it; an ended one names who and why', async () => {
    const p = { organizationId: orgId, categoryCode: 'STEEL', supplierId, validFrom: new Date('2026-11-08'), validTo: new Date('2027-11-08') }
    await expect(prisma.preferredSupplier.create({ data: { ...p, source: 'MANUAL', validTo: p.validFrom } })).rejects.toThrow(/preferred_supplier_shape/)
    await expect(prisma.preferredSupplier.create({ data: { ...p, source: 'SOURCING' } })).rejects.toThrow(/preferred_supplier_shape/)
    const row = await prisma.preferredSupplier.create({ data: { ...p, source: 'MANUAL', createdById: memberId } })
    await expect(prisma.preferredSupplier.update({ where: { id: row.id }, data: { endedAt: NOW, endedById: memberId } })).rejects.toThrow(/preferred_supplier_shape/)
    await expect(prisma.preferredSupplier.update({ where: { id: row.id }, data: { endedAt: NOW, endedById: memberId, endReason: 'เปลี่ยนผู้ขาย' } })).resolves.toBeTruthy()
  })

  it('a request keeps the reason for another supplier than the preferred one; an empty reason is refused', async () => {
    const request = await prisma.requestLine.findUniqueOrThrow({ where: { id: requestLineIds[0]! }, select: { requestId: true } })
    await expect(prisma.request.update({ where: { id: request.requestId }, data: { preferredSupplierOverrideReason: '' } })).rejects.toThrow(/request_preferred_override_reason/)
    await expect(prisma.request.update({ where: { id: request.requestId }, data: { preferredSupplierOverrideReason: 'ผู้ขายที่แนะนำส่งไม่ทัน' } })).resolves.toBeTruthy()
  })
})

async function sqlError(client: pg.Client, sql: string, params: unknown[] = []): Promise<string | undefined> {
  try {
    await client.query(sql, params)
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}
