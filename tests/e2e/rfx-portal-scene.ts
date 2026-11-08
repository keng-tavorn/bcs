import { randomUUID } from 'node:crypto'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import { answerQuestion, closeRfxEarly, createRfx, inviteToRfx, openRfx, setScorecard } from '@/server/services/sourcing'
import { createP2Org } from '../support/p2-org'
import { E2E_DB } from '../support/e2e-env'

// Run by tests/e2e/rfx-portal.spec.ts against the e2e database only (S10-07 · FR-SRC-202 AC1 AC2 · BR-RFX-07):
//   open <tag> <th|en>   an organization of its own with SUPPLIER and SOURCING on (AI off), a supplier registered for VAT on
//                        the portal with its primary contact in that language, and an RFQ of two lines PROCUREMENT opened
//                        for it, closing in three days; prints the org code, the RFx, the contact and the invite's link
//   otp <contactId>      the six-digit code of the contact's latest sign-in e-mail (read from its notice, as Mailpit would)
//   answer <rfxEventId> <memberId>  procurement answers the RFx's open question to everyone
//   award <rfxEventId> <memberId>   procurement closes the RFx early (every invite has bid) and an approved award gives both lines
//                        to the supplier at its bid's prices (the award's own commands come in S10-10)
// Prints one JSON line. The demo organization is never touched.
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the RFx portal scene runs in the e2e database only')
const [mode, arg, arg2] = process.argv.slice(2)
setDefaultOutboxSender(null)
const NOW = new Date()
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
function ok<T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const memberCtx = (organizationId: string, memberId: string) => makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'WEB', now: new Date() })

async function open(tag: string, locale: string) {
  const org = await createP2Org({ modules: ['SUPPLIER'] })
  const id = org.organizationId
  const code = `ZE2E-RFX-${tag.toUpperCase()}`
  await prisma.organization.update({ where: { id }, data: { code } })
  await prisma.orgModule.create({ data: { organizationId: id, module: 'SOURCING', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
  const supplier = await prisma.supplier.create({
    data: { organizationId: id, code: `RFX-${tag.toUpperCase()}`, nameTh: 'บริษัท วัสดุทดสอบ จำกัด', nameEn: 'Test Materials Co., Ltd.', taxId: '0105561000011', isVatRegistered: true, branchCode: '00000', portalEnabled: true, email: `register.${tag}@supplier.test` },
  })
  const contact = await prisma.supplierContact.create({
    data: { organizationId: id, supplierId: supplier.id, nameTh: 'คุณผู้ติดต่อ', email: `rfx.${tag}@supplier.test`, isPrimary: true, locale: locale === 'en' ? 'en' : 'th', privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION },
  })
  const proc = org.ctxOf('proc_officer', NOW)
  const { rfxEventId } = ok(
    await createRfx(
      proc,
      {
        kind: 'RFQ',
        title: 'ปูนซีเมนต์และทราย ไซต์ 9',
        titleEn: 'Cement and sand, site 9',
        description: 'ขอราคาปูนซีเมนต์และทรายสำหรับงานฐานราก ส่งหน้างาน',
        descriptionEn: 'Cement and sand for the foundations, delivered to the site',
        source: { kind: 'NEED', categoryCode: 'CEMENT', lines: [{ description: 'ปูนซีเมนต์ 50 กก.', descriptionEn: 'Cement 50 kg', quantity: '100', uom: 'ถุง', uomEn: 'bag', refUnitPrice: '150.00' }, { description: 'ทรายหยาบ', descriptionEn: 'Coarse sand', quantity: '4', uom: 'คิว', uomEn: 'm³', refUnitPrice: '600.00' }] },
      },
      key(),
    ),
  )
  const version = async () => (await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).version
  ok(await inviteToRfx(proc, { rfxEventId, expectedVersion: await version(), supplierId: supplier.id }, key()))
  ok(await setScorecard(proc, { rfxEventId, expectedVersion: await version(), criteria: [{ code: 'PRICE', nameTh: 'ราคา', weightBp: 10000, kind: 'PRICE' }], evaluatorMemberIds: [] }, key()))
  const closesAt = new Date(NOW.getTime() + 3 * 24 * 3600 * 1000).toISOString()
  ok(await openRfx(proc, { rfxEventId, expectedVersion: await version(), closesAt, fewerInvitesReason: 'ฉากทดสอบพอร์ทัลมีผู้ขายรายเดียว' }, key()))
  const notice = await prisma.supplierNotice.findFirstOrThrow({ where: { organizationId: id, subjectId: rfxEventId, templateKey: 'rfx.invited' } })
  const url = (notice.data as { url?: string }).url
  if (!url) throw new Error('the invite e-mail has no link')
  const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { number: true } })
  return { orgCode: code, rfxEventId, number: rfx.number, contactId: contact.id, procMemberId: org.member.proc_officer!, path: new URL(url).pathname }
}

async function otp(contactId: string) {
  const notice = await prisma.supplierNotice.findFirstOrThrow({ where: { contactId, templateKey: 'supplier.otp' }, orderBy: { createdAt: 'desc' } })
  const code = (notice.data as { code?: string }).code
  if (!code) throw new Error('the code was sent and dropped already')
  return { code }
}

async function answer(rfxEventId: string, memberId: string) {
  const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { organizationId: true } })
  const question = await prisma.rfxQuestion.findFirstOrThrow({ where: { rfxEventId, status: 'OPEN' }, orderBy: { askedAt: 'desc' } })
  ok(await answerQuestion(memberCtx(rfx.organizationId, memberId), { rfxEventId, questionId: question.id, answer: 'ส่งหน้างานไซต์ 9 ได้ ไม่มีค่าขนส่งเพิ่ม', visibility: 'ALL' }, key()))
  return { questionId: question.id }
}

async function award(rfxEventId: string, memberId: string) {
  const rfx = await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { organizationId: true, version: true } })
  const organizationId = rfx.organizationId
  const now = new Date()
  ok(await closeRfxEarly(memberCtx(organizationId, memberId), { rfxEventId, expectedVersion: rfx.version, reason: 'ผู้ขายที่เชิญยื่นครบแล้ว' }, key()))
  const bid = await prisma.bid.findFirstOrThrow({ where: { rfxEventId, status: 'SUBMITTED' }, include: { lines: true } })
  const lines = await prisma.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' } })
  const decision = await prisma.awardDecision.create({
    data: { organizationId, rfxEventId, number: `AWD-E2E-${randomUUID().slice(0, 6)}`, status: 'APPROVED', netSatang: bid.netSatang, vatSatang: bid.vatSatang, grossSatang: bid.grossSatang, createdById: memberId, submittedById: memberId, submittedAt: now, decidedAt: now },
  })
  for (const l of lines) {
    const mine = bid.lines.find((b) => b.rfxLineId === l.id)!
    await prisma.awardLine.create({ data: { organizationId, awardDecisionId: decision.id, rfxLineId: l.id, bidId: bid.id, supplierId: bid.supplierId, quantity: l.quantity, unitPriceSatang: mine.unitPriceSatang!, lineNetSatang: mine.lineNetSatang!, vatRateBp: bid.vatRateBp ?? 0 } })
  }
  await prisma.rfxEvent.update({ where: { id: rfxEventId }, data: { status: 'AWARDED', awardDecisionId: decision.id } })
  return { awardDecisionId: decision.id }
}

const out = mode === 'open' && arg ? await open(arg, arg2 ?? 'th') : mode === 'otp' && arg ? await otp(arg) : mode === 'answer' && arg && arg2 ? await answer(arg, arg2) : mode === 'award' && arg && arg2 ? await award(arg, arg2) : null
if (!out) throw new Error('usage: rfx-portal-scene.ts open <tag> <th|en> | otp <contactId> | answer <rfxEventId> <memberId> | award <rfxEventId> <memberId>')
console.log(JSON.stringify(out))
await prisma.$disconnect()
