import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { assignSupplier } from '@/server/services/procurement'
import {
  addRfxLines,
  amendRfx,
  cancelRfx,
  closeRfxAt,
  closeRfxEarly,
  createRfx,
  remindRfxAt,
  rfxReminderAt,
  extendRfx,
  inviteToRfx,
  linkInvitesOfApplication,
  openRfx,
  removeRfxLine,
  reopenRfx,
  setScorecard,
  uninviteFromRfx,
  updateRfx,
} from '@/server/services/sourcing'
import { rfxCloseHandler } from '@/server/jobs/rfx'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// S10-04 (FR-SRC-201 AC1 AC2 AC3 AC5 AC6 · BR-RFX-01 to 05 16 18 · INV-RFX-03): the life of an RFx on real Postgres —
// made from lines of the pool or a need, its invites and scorecard, opened with a number, links and e-mails, amended,
// extended, closed by the job at its time, cancelled and reopened; a line in an RFx never gets a supplier in the pool.

const MON = new Date('2026-11-02T02:00:00Z') // Monday 09:00 Bangkok
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const CRITERIA = [
  { code: 'PRICE', nameTh: 'ราคา', weightBp: 6000, kind: 'PRICE' as const },
  { code: 'DELIVERY', nameTh: 'ส่งมอบ', weightBp: 2500, kind: 'QUALITY' as const },
  { code: 'QUALITY', nameTh: 'คุณภาพ', weightBp: 1500, kind: 'QUALITY' as const },
]

let org: DoaOrg
let flow: ReturnType<typeof p2p>
let budgetLineId: string

beforeAll(async () => {
  org = await createDoaOrg()
  for (const module of ['SUPPLIER', 'SOURCING'] as const) {
    await prisma.orgModule.create({ data: { organizationId: org.organizationId, module, enabled: true, enabledAt: new Date('2026-01-01T00:00:00Z'), contractRef: 'TEST-S10', reason: 'องค์กรทดสอบจัดหา' } })
  }
  // two evaluators beside the creator (BR-SOD-14): another member of procurement and one of IT
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.dm_proc!, role: 'PROCUREMENT', grantedAt: new Date('2026-01-01T00:00:00Z') } })
  flow = p2p(org, MON)
  budgetLineId = await flow.fundedLine(2_000_000n)
}, 120_000)

const proc = () => org.ctxOf('proc_officer', MON)

async function supplier(name: string, extra: Record<string, unknown> = {}) {
  const s = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S10-${randomUUID().slice(0, 6)}`, nameTh: name, taxId: null, isForeign: true, branchCode: '00000', portalEnabled: true, ...extra } })
  await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: s.id, nameTh: `ผู้ติดต่อ ${name}`, email: `c-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true } })
  return s
}

/** Lines of approved requests in the pool, with no supplier, of one category, each request on a site of its own */
async function poolLines(category: string, lines: Array<{ quantity: string; unitPrice: string }>): Promise<string[]> {
  const ids: string[] = []
  for (const l of lines) {
    const request = await flow.approvedRequest(budgetLineId, [l])
    const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 6)}`, nameTh: 'ไซต์', address: 'ถนนทดสอบ' } })
    await prisma.request.update({ where: { id: request.id }, data: { deliverySiteId: site.id } })
    await prisma.requestLine.updateMany({ where: { requestId: request.id }, data: { categoryCode: category } })
    ids.push(request.lines[0]!.id)
  }
  return ids
}

async function version(rfxEventId: string) {
  return (await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).version
}

/** An RFQ from a need with three invites and a full scorecard, ready to open */
async function readyRfq(estimate = '1000.00') {
  const { rfxEventId } = ok(
    await createRfx(proc(), { kind: 'RFQ', title: 'เหล็กเส้น', description: 'ขอราคา', source: { kind: 'NEED', categoryCode: 'STEEL', lines: [{ description: 'เหล็ก DB12', quantity: '1', uom: 'ตัน', refUnitPrice: estimate }] } }, key()),
  )
  const suppliers = [await supplier('ชลบุรีภัณฑ์'), await supplier('สหมิตร'), await supplier('บางนา')]
  for (const s of suppliers) ok(await inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: s.id }, key()))
  ok(await setScorecard(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), criteria: CRITERIA, evaluatorMemberIds: [org.member.dm_proc!, org.member.dm_it!] }, key()))
  return { rfxEventId, suppliers }
}

describe('[FR-SRC-201/AC1] [INV-RFX-03] an RFQ from lines of the pool holds them there', () => {
  it('two lines of two requests and two sites → one RFQ of two lines; the pool refuses them LINE_IN_RFX; a removed line goes back', async () => {
    const lines = await poolLines('STEEL', [
      { quantity: '8', unitPrice: '23800.00' },
      { quantity: '5', unitPrice: '23800.00' },
    ])
    const created = ok(await createRfx(proc(), { kind: 'RFQ', title: 'เหล็กข้ออ้อย DB12', description: 'ขอราคา 13 ตัน', source: { kind: 'REQUEST_LINES', requestLineIds: lines } }, key()))
    const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: created.rfxEventId }, include: { lines: { include: { sources: true }, orderBy: { lineNo: 'asc' } } } })
    expect(rfx).toMatchObject({ status: 'DRAFT', kind: 'RFQ', categoryCode: 'STEEL', sourceKind: 'REQUEST_LINES', requestingDepartmentId: org.department.CON, sealed: true })
    expect(rfx.lines.map((l) => [l.lineNo, l.quantity.toString(), l.sources.length])).toEqual([
      [1, '8', 1],
      [2, '5', 1],
    ])
    // 13 × 23,800 = 309,400.00 before VAT, 331,058.00 with it: above 100,000.00, so three invites (GC-SRC-35)
    expect(rfx.estimatedNetSatang).toBe(30_940_000n)
    expect(created.minInvites).toBe(3)
    for (const id of lines) expect((await prisma.requestLine.findUniqueOrThrow({ where: { id } })).rfxEventId).toBe(rfx.id)
    const s = await supplier('ผู้ขายนอกระบบจัดหา')
    expect(await assignSupplier(proc(), { requestLineIds: [lines[0]!], supplierId: s.id }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'LINE_IN_RFX' } } })
    // the same line in a second RFx is refused too
    expect(await createRfx(proc(), { kind: 'RFQ', title: 'ซ้ำ', description: 'ซ้ำ', source: { kind: 'REQUEST_LINES', requestLineIds: [lines[1]!] } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'LINE_IN_RFX' } } })
    ok(await removeRfxLine(proc(), { rfxEventId: rfx.id, expectedVersion: rfx.version, rfxLineId: rfx.lines[0]!.id }, key()))
    expect((await prisma.requestLine.findUniqueOrThrow({ where: { id: lines[0]! } })).rfxEventId).toBeNull()
    expect(await assignSupplier(proc(), { requestLineIds: [lines[0]!], supplierId: s.id }, key())).toMatchObject({ ok: true })
  })

  it('lines of two categories → MIXED_CATEGORY; a line with its supplier → LINE_HAS_SUPPLIER; an RFI from a need takes typed lines', async () => {
    const [steel] = await poolLines('STEEL', [{ quantity: '1', unitPrice: '100.00' }])
    const [cement] = await poolLines('CEMENT', [{ quantity: '1', unitPrice: '100.00' }])
    expect(await createRfx(proc(), { kind: 'RFQ', title: 'ปน', description: 'ปน', source: { kind: 'REQUEST_LINES', requestLineIds: [steel!, cement!] } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'MIXED_CATEGORY' } } })
    const s = await supplier('มีผู้ขายแล้ว')
    ok(await assignSupplier(proc(), { requestLineIds: [cement!], supplierId: s.id }, key()))
    expect(await createRfx(proc(), { kind: 'RFQ', title: 'มีผู้ขาย', description: 'มีผู้ขาย', source: { kind: 'REQUEST_LINES', requestLineIds: [cement!] } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'LINE_HAS_SUPPLIER' } } })
    const rfi = ok(await createRfx(proc(), { kind: 'RFI', title: 'สำรวจผู้รับเหมา', description: 'สำรวจ', source: { kind: 'NEED', categoryCode: 'SUBCON', lines: [{ description: 'งานเหล็ก', quantity: '1', uom: 'งาน' }] } }, key()))
    expect(await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfi.rfxEventId } })).toMatchObject({ kind: 'RFI', sourceKind: 'NEED', minInvites: 1 })
    expect(await setScorecard(proc(), { rfxEventId: rfi.rfxEventId, expectedVersion: await version(rfi.rfxEventId), criteria: CRITERIA, evaluatorMemberIds: [] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'RFI_HAS_NO_SCORECARD' } } })
  })
})

describe('[FR-SRC-201/AC2] minInvites from the estimate with VAT and settings.sourcing.minInvitesThresholdGross', () => {
  it('at the threshold exactly one invite is enough, a satang above it three; fewer than that opens only with a reason', async () => {
    const settings = (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).settings as Record<string, unknown>
    await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...settings, sourcing: { minInvitesThresholdGross: '1070.00' } } } })
    try {
      const at = ok(await createRfx(proc(), { kind: 'RFQ', title: 'ที่เกณฑ์', description: 'ที่เกณฑ์', source: { kind: 'NEED', categoryCode: 'STEEL', lines: [{ description: 'เหล็ก', quantity: '1', uom: 'ตัน', refUnitPrice: '1000.00' }] } }, key()))
      expect(at.minInvites).toBe(1)
      const above = ok(await createRfx(proc(), { kind: 'RFQ', title: 'เกิน', description: 'เกิน', source: { kind: 'NEED', categoryCode: 'STEEL', lines: [{ description: 'เหล็ก', quantity: '1', uom: 'ตัน', refUnitPrice: '1000.01' }] } }, key()))
      expect(above.minInvites).toBe(3)
      const s = await supplier('รายเดียว')
      ok(await inviteToRfx(proc(), { rfxEventId: above.rfxEventId, expectedVersion: await version(above.rfxEventId), supplierId: s.id }, key()))
      ok(await setScorecard(proc(), { rfxEventId: above.rfxEventId, expectedVersion: await version(above.rfxEventId), criteria: CRITERIA, evaluatorMemberIds: [org.member.dm_proc!, org.member.dm_it!] }, key()))
      const closesAt = '2026-11-05T10:00:00Z'
      expect(await openRfx(proc(), { rfxEventId: above.rfxEventId, expectedVersion: await version(above.rfxEventId), closesAt }, key())).toMatchObject({ ok: false, error: { details: { reason: 'FEWER_INVITES_REASON', invites: 1, minInvites: 3 } } })
      const opened = ok(await openRfx(proc(), { rfxEventId: above.rfxEventId, expectedVersion: await version(above.rfxEventId), closesAt, fewerInvitesReason: 'ผู้ขายเหล็กรายนี้รายเดียวที่ส่งทันไซต์' }, key()))
      const event = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: above.rfxEventId, type: 'rfx.opened' } })
      expect((event.data as { fewerInvitesReasonCommentId: string | null }).fewerInvitesReasonCommentId).not.toBeNull()
      expect(opened.number).toMatch(/^RFX-\d{4}-\d{5}$/)
    } finally {
      await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: settings as object } })
    }
  })

  it('invites only an active supplier the registry does not flag, once; an application of S7 is invited and linked to its supplier when approved', async () => {
    const { rfxEventId } = ok(await createRfx(proc(), { kind: 'RFQ', title: 'เชิญ', description: 'เชิญ', source: { kind: 'NEED', categoryCode: 'STEEL', lines: [{ description: 'เหล็ก', quantity: '1', uom: 'ตัน' }] } }, key()))
    const flagged = await supplier('เลิกกิจการ', { registryFlag: 'CEASED' })
    expect(await inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: flagged.id }, key())).toMatchObject({ ok: false, error: { code: 'SUPPLIER_FLAGGED', details: { flag: 'CEASED' } } })
    const s = await supplier('ปกติ')
    ok(await inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: s.id }, key()))
    expect(await inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: s.id }, key())).toMatchObject({ ok: false, error: { code: 'ALREADY_INVITED' } })
    const application = await prisma.supplierApplication.create({ data: { organizationId: org.organizationId, kind: 'NEW', invitedById: org.member.proc_officer!, invitedAt: MON, lastActivityAt: MON, expiresAt: new Date('2026-12-02T00:00:00Z'), nameTh: 'ผู้สมัครใหม่', status: 'SUBMITTED' } })
    await prisma.supplierContact.create({ data: { organizationId: org.organizationId, applicationId: application.id, nameTh: 'ผู้สมัคร', email: `a-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true } })
    const invited = ok(await inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), applicationId: application.id }, key()))
    const approved = await supplier('ผู้สมัครที่อนุมัติแล้ว')
    expect(await linkInvitesOfApplication(org.organizationId, application.id, approved.id, MON)).toBe(1)
    expect(await prisma.rfxInvite.findUniqueOrThrow({ where: { id: invited.inviteId } })).toMatchObject({ applicationId: application.id, supplierId: approved.id })
  })
})

describe('[FR-SRC-201/AC3] rfx.open: the close on the business calendar, the scorecard, a number, links and e-mails; the job closes it at its time', () => {
  it('an evaluator who created the RFx is refused BR-SOD-14; a scorecard without enough evaluators SCORECARD_INCOMPLETE; a close one minute early CLOSE_TOO_SOON', async () => {
    const { rfxEventId } = await readyRfq()
    expect(await setScorecard(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), criteria: CRITERIA, evaluatorMemberIds: [org.member.proc_officer!, org.member.dm_it!] }, key())).toMatchObject({
      ok: false,
      error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-14' } },
    })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'security.sod_blocked', aggregateId: rfxEventId } })).toBe(1)
    ok(await setScorecard(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), criteria: CRITERIA, evaluatorMemberIds: [org.member.dm_it!] }, key()))
    expect(await openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: '2026-11-05T02:00:00Z' }, key())).toMatchObject({ ok: false, error: { code: 'SCORECARD_INCOMPLETE' } })
    ok(await setScorecard(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), criteria: CRITERIA, evaluatorMemberIds: [org.member.dm_proc!, org.member.dm_it!] }, key()))
    // Monday 09:00 + 3 business days = Thursday 09:00 (GC-SRC-15)
    expect(await openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: '2026-11-05T01:59:00Z' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'CLOSE_TOO_SOON', earliest: '2026-11-05T02:00:00.000Z' } } })
    const opened = ok(await openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: '2026-11-05T02:00:00Z' }, key()))
    const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, include: { scorecard: true, invites: { include: { link: true } } } })
    expect(rfx).toMatchObject({ status: 'OPEN', number: opened.number, openedById: org.member.proc_officer, closesAt: new Date('2026-11-05T02:00:00Z') })
    expect(rfx.scorecard).toMatchObject({ status: 'LOCKED' })
    expect(rfx.invites.map((i) => [i.link?.purpose, i.link?.expiresAt.toISOString()])).toEqual(Array(3).fill(['RFX_INVITE', '2026-11-05T02:00:00.000Z']))
    const notices = await prisma.supplierNotice.findMany({ where: { organizationId: org.organizationId, subjectId: rfxEventId, templateKey: 'rfx.invited' } })
    expect(notices).toHaveLength(3)
    expect(notices.every((n) => (n.data as { number: string }).number === opened.number)).toBe(true)
  })

  it('rfx-close sleeps until closesAt and closes then, not a moment before; invites that did not bid expire', async () => {
    const { rfxEventId } = await readyRfq()
    ok(await openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: '2026-11-05T02:00:00Z' }, key()))
    const event = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: rfxEventId, type: 'rfx.opened' } })
    const payload = { data: { organizationId: org.organizationId, aggregateId: rfxEventId, data: event.data } }
    const slept: string[] = []
    const step = (now: Date) => ({ run: <T,>(_id: string, fn: () => Promise<T>) => fn(), sleepUntil: async (_id: string, at: string) => void slept.push(at), sleep: async () => {} })
    // the run woke a minute early (clock skew): nothing happens
    expect(await rfxCloseHandler({ now: () => new Date('2026-11-05T01:59:00Z') })(payload, step(MON))).toEqual({ closed: false, reason: 'NOT_DUE' })
    expect(slept).toEqual(['2026-11-05T02:00:00.000Z'])
    expect(await rfxCloseHandler({ now: () => new Date('2026-11-05T02:00:00Z') })(payload, step(MON))).toEqual({ closed: true })
    const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, include: { invites: true } })
    expect(rfx).toMatchObject({ status: 'CLOSED', closedAt: new Date('2026-11-05T02:00:00Z') })
    expect(rfx.invites.map((i) => i.status)).toEqual(['EXPIRED', 'EXPIRED', 'EXPIRED'])
    // no bid: procurement reopens it as a new draft with its lines and scorecard; the old one is cancelled
    const reopened = ok(await reopenRfx(proc(), { rfxEventId, expectedVersion: rfx.version, reason: 'ไม่มีผู้ยื่น เปิดใหม่' }, key()))
    expect(await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).toMatchObject({ status: 'CANCELLED' })
    expect(await prisma.rfxEvent.findUniqueOrThrow({ where: { id: reopened.rfxEventId }, include: { lines: true } })).toMatchObject({ status: 'DRAFT', number: null, lines: [{ lineNo: 1 }] })
  })
})

describe('[FR-SRC-201/AC5] amend and extend while open', () => {
  it('an amendment raises the revision, keeps its row, asks submitted bids to confirm, e-mails every invite, and moves the close later only', async () => {
    const { rfxEventId } = await readyRfq()
    ok(await openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: '2026-11-05T02:00:00Z' }, key()))
    const first = await prisma.rfxInvite.findFirstOrThrow({ where: { rfxEventId } })
    await prisma.rfxInvite.update({ where: { id: first.id }, data: { status: 'BID_SUBMITTED' } })
    expect(await amendRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), summary: 'เลื่อนเร็วขึ้น', closesAt: '2026-11-04T02:00:00Z' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'CLOSE_NOT_LATER' } } })
    const amended = ok(await amendRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), summary: 'เพิ่มรายละเอียดมาตรฐาน มอก.', description: 'ขอราคา มอก. 24-2559', closesAt: '2026-11-06T10:00:00Z' }, key()))
    expect(amended.revisionNo).toBe(2)
    expect(await prisma.rfxAmendment.findFirstOrThrow({ where: { rfxEventId } })).toMatchObject({ revisionNo: 2, changedFields: ['description', 'closesAt'], newClosesAt: new Date('2026-11-06T10:00:00Z') })
    expect((await prisma.rfxInvite.findUniqueOrThrow({ where: { id: first.id } })).needsReconfirm).toBe(true)
    expect(await prisma.supplierNotice.count({ where: { organizationId: org.organizationId, subjectId: rfxEventId, templateKey: 'rfx.amended' } })).toBe(3)
    const links = await prisma.portalInviteLink.findMany({ where: { rfxInvites: { some: { rfxEventId } } } })
    expect(links.map((l) => l.expiresAt.toISOString())).toEqual(Array(3).fill('2026-11-06T10:00:00.000Z'))
    // the run of the old close wakes and does nothing
    expect(await closeRfxAt(org.organizationId, rfxEventId, '2026-11-05T02:00:00.000Z', new Date('2026-11-05T02:00:00Z'))).toEqual({ closed: false, reason: 'NOT_DUE' })
    const extended = ok(await extendRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: '2026-11-09T10:00:00Z' }, key()))
    expect(extended.closesAt).toBe('2026-11-09T10:00:00.000Z')
    expect(await extendRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: '2026-11-09T10:00:00Z' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'CLOSE_NOT_LATER' } } })
  })

  it('closing early needs every invite to have answered', async () => {
    const { rfxEventId } = await readyRfq()
    ok(await openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: '2026-11-05T02:00:00Z' }, key()))
    expect(await closeRfxEarly(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), reason: 'ตอบครบแล้ว' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'INVITES_WAITING', waiting: 3 } } })
    await prisma.rfxInvite.updateMany({ where: { rfxEventId }, data: { status: 'DECLINED', declinedAt: MON } })
    expect(ok(await closeRfxEarly(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), reason: 'ทุกรายแจ้งไม่เสนอ' }, key()))).toMatchObject({ bidCount: 0 })
    expect(await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).toMatchObject({ status: 'CLOSED' })
  })
})

describe('[FR-SRC-201/AC6] [BR-RFX-16] cancel', () => {
  it('needs no open award; gives the lines back to the pool, revokes the links, e-mails the invites and removes them', async () => {
    const lines = await poolLines('STEEL', [{ quantity: '2', unitPrice: '500.00' }])
    const { rfxEventId } = ok(await createRfx(proc(), { kind: 'RFQ', title: 'ยกเลิก', description: 'ยกเลิก', source: { kind: 'REQUEST_LINES', requestLineIds: lines } }, key()))
    const s = await supplier('รอยกเลิก')
    ok(await inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: s.id }, key()))
    ok(await setScorecard(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), criteria: [{ code: 'PRICE', nameTh: 'ราคา', weightBp: 10000, kind: 'PRICE' }], evaluatorMemberIds: [org.member.dm_proc!, org.member.dm_it!] }, key()))
    ok(await openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: '2026-11-05T02:00:00Z' }, key()))
    const award = await prisma.awardDecision.create({ data: { organizationId: org.organizationId, rfxEventId, createdById: org.member.proc_officer!, netSatang: 100n, vatSatang: 7n, grossSatang: 107n } })
    expect(await cancelRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), reason: 'ยกเลิกความต้องการ' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'AWARD_OPEN' } } })
    await prisma.awardDecision.update({ where: { id: award.id }, data: { status: 'CANCELLED', cancelReason: 'ทดสอบ', cancelledAt: MON } })
    expect(ok(await cancelRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), reason: 'ยกเลิกความต้องการ' }, key())).requestLineIds).toEqual(lines)
    const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, include: { invites: { include: { link: true } } } })
    expect(rfx).toMatchObject({ status: 'CANCELLED', cancelReason: 'ยกเลิกความต้องการ' })
    expect(rfx.invites.map((i) => [i.status, i.link?.revokedAt !== null])).toEqual([['REMOVED', true]])
    expect(await prisma.supplierNotice.count({ where: { organizationId: org.organizationId, subjectId: rfxEventId, templateKey: 'rfx.cancelled' } })).toBe(1)
    expect((await prisma.requestLine.findUniqueOrThrow({ where: { id: lines[0]! } })).rfxEventId).toBeNull()
    expect(await assignSupplier(proc(), { requestLineIds: lines, supplierId: s.id }, key())).toMatchObject({ ok: true })
  })
})

describe('[BR-RFX-03] [BR-RFX-06] invites after the open, removing an invite, and unsealing', () => {
  it('an invite after the open gets its link and e-mail at once; a removed invite loses its link; prices seen early need a reason', async () => {
    const { rfxEventId, suppliers } = await readyRfq()
    expect(await updateRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), sealed: false }, key())).toMatchObject({ ok: false, error: { details: { reason: 'UNSEAL_REASON' } } })
    ok(await updateRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), sealed: false, unsealReason: 'ราคาเปิดเผยตามระเบียบราคากลาง' }, key()))
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, aggregateId: rfxEventId, type: 'rfx.unsealed' } })).toBe(1)
    ok(await openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: '2026-11-05T02:00:00Z' }, key()))
    const late = await supplier('เชิญเพิ่ม')
    const { inviteId } = ok(await inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: late.id }, key()))
    expect((await prisma.rfxInvite.findUniqueOrThrow({ where: { id: inviteId }, include: { link: true } })).link).toMatchObject({ purpose: 'RFX_INVITE', expiresAt: new Date('2026-11-05T02:00:00Z') })
    expect(await prisma.supplierNotice.count({ where: { organizationId: org.organizationId, subjectId: rfxEventId, templateKey: 'rfx.invited' } })).toBe(4)
    const removed = await prisma.rfxInvite.findFirstOrThrow({ where: { rfxEventId, supplierId: suppliers[0]!.id } })
    ok(await uninviteFromRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), inviteId: removed.id, reason: 'ผู้ขายแจ้งปิดกิจการ' }, key()))
    expect(await prisma.rfxInvite.findUniqueOrThrow({ where: { id: removed.id }, include: { link: true } })).toMatchObject({ status: 'REMOVED', link: { revokedAt: expect.any(Date) } })
    // after the close nobody is invited any more
    expect(await inviteToRfx({ ...proc(), now: new Date('2026-11-05T02:00:00Z') }, { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: (await supplier('สาย')).id }, key())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'PAST_CLOSE' } },
    })
  })
})

describe('[FR-SRC-201/AC1] who may run an RFx (sourcing.manage · requireModule SOURCING)', () => {
  it('FINANCE and a requester are refused FORBIDDEN; with SOURCING off every command is MODULE_DISABLED', async () => {
    const need = { kind: 'RFQ' as const, title: 'ห้าม', description: 'ห้าม', source: { kind: 'NEED' as const, categoryCode: 'STEEL', lines: [{ description: 'เหล็ก', quantity: '1', uom: 'ตัน' }] } }
    expect(await createRfx(org.ctxOf('fin_officer', MON), need, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await createRfx(org.ctxOf('req_con', MON), need, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const other = await createDoaOrg()
    expect(await createRfx(other.ctxOf('proc_officer', MON), need, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED', details: { module: 'SOURCING' } } })
    // adding lines of another source kind is refused
    const { rfxEventId } = ok(await createRfx(proc(), need, key()))
    expect(await addRfxLines(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), source: { kind: 'REQUEST_LINES', requestLineIds: [randomUUID()] } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'SOURCE_KIND' } } })
  })
})

describe('[BR-NOTI-11] rfx-reminder: one business day before the close, to the invites that have not answered', () => {
  it('writes at closesAt − 540 business minutes, reminds who neither bid nor declined, and does nothing for a close that moved', async () => {
    const { rfxEventId } = await readyRfq()
    ok(await openRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: '2026-11-05T10:00:00Z' }, key()))
    // Thursday 17:00 Bangkok less one business day (08:00–17:00 with an hour's lunch) → Wednesday 17:00
    expect(await rfxReminderAt(org.organizationId, '2026-11-05T10:00:00.000Z')).toBe('2026-11-04T10:00:00.000Z')
    const [declined] = await prisma.rfxInvite.findMany({ where: { rfxEventId }, orderBy: { invitedAt: 'asc' } })
    await prisma.rfxInvite.update({ where: { id: declined!.id }, data: { status: 'DECLINED', declinedAt: MON } })
    expect(await remindRfxAt(org.organizationId, rfxEventId, '2026-11-05T10:00:00.000Z', new Date('2026-11-04T10:00:00Z'))).toBe(2)
    expect(await prisma.supplierNotice.count({ where: { organizationId: org.organizationId, subjectId: rfxEventId, templateKey: 'rfx.reminder' } })).toBe(2)
    // the same run again (a retried step) gets the same answer; a run of a close that moved since reminds nobody
    expect(await remindRfxAt(org.organizationId, rfxEventId, '2026-11-05T10:00:00.000Z', new Date('2026-11-04T10:00:00Z'))).toBe(2)
    ok(await extendRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: '2026-11-06T10:00:00Z' }, key()))
    expect(await remindRfxAt(org.organizationId, rfxEventId, '2026-11-04T09:00:00.000Z', new Date('2026-11-04T11:00:00Z'))).toBe(0)
    expect(await prisma.supplierNotice.count({ where: { organizationId: org.organizationId, subjectId: rfxEventId, templateKey: 'rfx.reminder' } })).toBe(2)
  })
})
