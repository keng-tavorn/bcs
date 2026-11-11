import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { portalCtx } from '@/server/portal/session'
import { answerQuestion, askQuestion, closeRfxAt, concludeRfx, createRfx, inviteToRfx, openRfx as openRfxCommand, setScorecard } from '@/server/services/sourcing'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S10-05 (FR-SRC-201 AC4 · BR-RFX-02 · BR-RFX-04): suppliers ask until the question cut-off; procurement answers to every
// invite without naming who asked (ALL) or to the asker alone with a reason (ASKER), and may word the question again
// (the asker's words stay as a comment); an RFI ends CONCLUDED with procurement's summary — no award, no PO.

const MON = new Date('2026-11-02T02:00:00Z') // Monday 09:00 Bangkok
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
  for (const m of ['SUPPLIER', 'SOURCING'] as const) {
    await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: m, enabled: true, enabledAt: new Date('2026-01-01T00:00:00Z'), contractRef: 'TEST-S10', reason: 'องค์กรทดสอบจัดหา' } })
  }
}, 120_000)

const proc = (now = MON) => org.ctxOf('proc_officer', now)
const version = async (id: string) => (await prisma.rfxEvent.findUniqueOrThrow({ where: { id } })).version

async function supplier(name: string) {
  const s = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `Q-${randomUUID().slice(0, 6)}`, nameTh: name, taxId: null, isForeign: true, branchCode: '00000', portalEnabled: true } })
  const contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: s.id, nameTh: `ติดต่อ ${name}`, email: `q-${randomUUID().slice(0, 8)}@supplier.test`, isPrimary: true } })
  return { supplier: s, contact }
}

/** An open RFP (or RFI) with three invites: closes Monday 2026-11-16 09:00, questions until Thursday 2026-11-12 09:00 */
async function openedRfx(kind: 'RFP' | 'RFI') {
  const { rfxEventId } = ok(await createRfx(proc(), { kind, title: kind === 'RFP' ? 'ระบบไฟร์วอลล์' : 'สำรวจผู้รับเหมา', description: 'รายละเอียด', source: { kind: 'NEED', categoryCode: 'IT', lines: [{ description: 'ไฟร์วอลล์', quantity: '2', uom: 'ชุด' }] } }, key()))
  const parties = [await supplier('ไอทีหนึ่ง'), await supplier('ไอทีสอง'), await supplier('ไอทีสาม')]
  for (const p of parties) ok(await inviteToRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), supplierId: p.supplier.id }, key()))
  if (kind === 'RFP') {
    ok(
      await setScorecard(
        proc(),
        { rfxEventId, expectedVersion: await version(rfxEventId), criteria: [{ code: 'PRICE', nameTh: 'ราคา', weightBp: 4000, kind: 'PRICE' }, { code: 'TECHNICAL', nameTh: 'เทคนิค', weightBp: 6000, kind: 'QUALITY' }], evaluatorMemberIds: [org.member.dm_it!, org.member.dm_proc!] },
        key(),
      ),
    )
  }
  const opened = ok(await openRfxCommand(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), closesAt: '2026-11-16T02:00:00Z' }, key()))
  return { rfxEventId, parties, opened }
}

describe('[FR-SRC-201/AC4] questions and answers of an RFP', () => {
  it('a supplier asks; the creator is told without the words; the answer to ALL reaches every invite and never names who asked', async () => {
    const { rfxEventId, parties } = await openedRfx('RFP')
    const asker = parties[0]!
    const { questionId } = ok(await askQuestion(portalCtx(org.organizationId, asker.contact, MON), { rfxEventId, question: 'ต้องรองรับ VPN กี่ผู้ใช้' }, key()))
    const notice = await prisma.notification.findFirstOrThrow({ where: { organizationId: org.organizationId, templateKey: 'rfx.question_asked' } })
    expect(notice).toMatchObject({ recipientMemberId: org.member.proc_officer, urgency: 'IMMEDIATE' })
    expect(JSON.stringify(notice.data)).not.toContain('VPN')
    const asked = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'rfx.question_asked', aggregateId: rfxEventId } })
    expect(asked).toMatchObject({ actorType: 'SUPPLIER', actorSupplierContactId: asker.contact.id, actorMemberId: null })
    expect(JSON.stringify(asked.data)).not.toContain('VPN')
    const answered = ok(await answerQuestion(proc(), { rfxEventId, questionId, answer: 'อย่างน้อย 200 ผู้ใช้พร้อมกัน', publishedQuestion: 'จำนวนผู้ใช้ VPN ที่ต้องรองรับ' }, key()))
    expect(answered.notified).toBe(3)
    const mails = await prisma.supplierNotice.findMany({ where: { organizationId: org.organizationId, subjectId: rfxEventId, templateKey: 'rfx.question_answered' } })
    expect(mails.map((m) => m.contactId).sort()).toEqual(parties.map((p) => p.contact.id).sort())
    for (const m of mails) {
      expect(m.data).toMatchObject({ question: 'จำนวนผู้ใช้ VPN ที่ต้องรองรับ', answer: 'อย่างน้อย 200 ผู้ใช้พร้อมกัน' })
      expect(JSON.stringify(m.data)).not.toContain(asker.supplier.nameTh)
    }
    // the asker's own words stay as a comment of the question
    expect(await prisma.comment.findFirstOrThrow({ where: { organizationId: org.organizationId, subjectType: 'RfxQuestion', subjectId: questionId } })).toMatchObject({ body: 'ต้องรองรับ VPN กี่ผู้ใช้' })
    expect(await prisma.rfxQuestion.findUniqueOrThrow({ where: { id: questionId } })).toMatchObject({ status: 'ANSWERED', visibility: 'ALL', question: 'จำนวนผู้ใช้ VPN ที่ต้องรองรับ' })
    expect(await answerQuestion(proc(), { rfxEventId, questionId, answer: 'ซ้ำ' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })

  it('an answer to the asker alone needs a reason and goes to the asker only; questions close at questionCutoffAt', async () => {
    const { rfxEventId, parties, opened } = await openedRfx('RFP')
    expect(opened.questionCutoffAt).toBe('2026-11-12T02:00:00.000Z')
    const asker = parties[1]!
    const { questionId } = ok(await askQuestion(portalCtx(org.organizationId, asker.contact, MON), { rfxEventId, question: 'ใช้สิทธิบัตรของเราได้ไหม' }, key()))
    expect(await answerQuestion(proc(), { rfxEventId, questionId, answer: 'ได้', visibility: 'ASKER' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'ASKER_ONLY_REASON' } } })
    ok(await answerQuestion(proc(), { rfxEventId, questionId, answer: 'ได้', visibility: 'ASKER', askerOnlyReason: 'คำถามเปิดเผยสิทธิบัตรของผู้ถาม' }, key()))
    expect((await prisma.supplierNotice.findMany({ where: { organizationId: org.organizationId, subjectId: rfxEventId, templateKey: 'rfx.question_answered' } })).map((m) => m.contactId)).toEqual([asker.contact.id])
    const late = new Date('2026-11-12T02:00:00Z')
    expect(await askQuestion(portalCtx(org.organizationId, asker.contact, late), { rfxEventId, question: 'ช้าไป' }, key())).toMatchObject({ ok: false, error: { code: 'QUESTION_CUTOFF_PASSED', details: { cutoff: '2026-11-12T02:00:00.000Z' } } })
  })

  it('a contact not invited gets NOT_FOUND; a member cannot ask through the portal command', async () => {
    const { rfxEventId } = await openedRfx('RFP')
    const stranger = await supplier('ไม่ได้รับเชิญ')
    expect(await askQuestion(portalCtx(org.organizationId, stranger.contact, MON), { rfxEventId, question: 'ขอเข้าร่วม' }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await askQuestion(proc(), { rfxEventId, question: 'ถามเอง' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-SRC-201/AC4] an RFI ends CONCLUDED with procurement summary — no award, no PO', () => {
  it('after the close an RFI concludes with its summary; an RFQ or RFP cannot conclude', async () => {
    const { rfxEventId } = await openedRfx('RFI')
    expect(await concludeRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), conclusionNote: 'ยังไม่ปิดรับ' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await closeRfxAt(org.organizationId, rfxEventId, '2026-11-16T02:00:00.000Z', new Date('2026-11-16T02:00:00Z'))).toEqual({ closed: true })
    // S10-08 review 3: an RFI (no scorecard) tells its creator of the close too
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, recipientMemberId: org.member.proc_officer!, templateKey: 'rfx.closed_internal', subjectId: rfxEventId } })).toBe(1)
    ok(await concludeRfx(proc(), { rfxEventId, expectedVersion: await version(rfxEventId), conclusionNote: 'ผู้รับเหมาสองรายพร้อมทำงานเหล็ก จะเชิญเข้า RFP ไตรมาสหน้า' }, key()))
    expect(await prisma.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId } })).toMatchObject({ status: 'CONCLUDED', conclusionNote: 'ผู้รับเหมาสองรายพร้อมทำงานเหล็ก จะเชิญเข้า RFP ไตรมาสหน้า', awardDecisionId: null })
    expect(await prisma.awardDecision.count({ where: { rfxEventId } })).toBe(0)
    expect(await prisma.purchaseOrder.count({ where: { rfxEventId } })).toBe(0)
    const rfp = await openedRfx('RFP')
    expect(await closeRfxAt(org.organizationId, rfp.rfxEventId, '2026-11-16T02:00:00.000Z', new Date('2026-11-16T02:00:00Z'))).toEqual({ closed: true })
    expect(await concludeRfx(proc(), { rfxEventId: rfp.rfxEventId, expectedVersion: await version(rfp.rfxEventId), conclusionNote: 'สรุป RFP' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NOT_RFI' } } })
  })
})
