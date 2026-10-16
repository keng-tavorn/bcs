import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { MS_PER_HOUR } from '@/lib/constants'
import { prisma } from '@/server/db/client'
import { chatIntakeIdOfRequest, getMyChatIntake, listMyOpenChatIntakes } from '@/server/queries/chat-intake'
import { dismissChatIntake, draftFromChat, storeChatImageCommand } from '@/server/services/chat-intake'
import { runCommand } from '@/server/services/_pipeline'
import { systemCtx } from '@/server/context'
import { editRequest, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// S17-07 · asking through the LINE chat, the LIFF side (FR-LINE-301 AC4 AC6 AC7 · BR-LINE-12 · OQ-161). The chat draft is
// made as the chat side makes it (rows of ChatIntake with its items and a stored photo of the owner); the owner picks a
// type in LIFF, the request draft is made by request.create_draft's logic, and the requester edits and sends it with the
// commands every request uses — with the AI module off, as in this organization (AC6). The database is real.

const NOW = new Date('2026-10-21T02:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let budgetLineId: string

beforeAll(async () => {
  org = await createDoaOrg()
  budgetLineId = await p2p(org, NOW).fundedLine(5_000_000n)
})

/** A chat draft of `code` as the chat side leaves it: its text, a photo stored as the owner's file and one that failed */
async function chatDraft(code: string, text: string | null, options: { readonly photos?: boolean } = {}) {
  const memberId = org.member[code]!
  const intake = await prisma.chatIntake.create({
    data: { organizationId: org.organizationId, memberId, status: 'OPEN', text, messageCount: 1, imageCount: options.photos ? 2 : 0, openedAt: NOW, lastMessageAt: NOW, expiresAt: new Date(NOW.getTime() + 24 * MS_PER_HOUR) },
  })
  await prisma.chatIntakeItem.create({ data: { organizationId: org.organizationId, intakeId: intake.id, seq: 1, kind: 'TEXT', lineMessageId: `${Date.now()}${Math.floor(Math.random() * 1e6)}`, receivedAt: NOW } })
  let fileId: string | null = null
  if (options.photos) {
    const file = await prisma.fileObject.create({
      data: { organizationId: org.organizationId, storageKey: `org/${org.organizationId}/chat-intake/${intake.id}/${randomUUID()}`, fileName: 'chat-2.jpg', mimeType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64), status: 'AVAILABLE', uploadedById: memberId, scanStatus: 'NOT_REQUIRED' },
    })
    fileId = file.id
    await prisma.chatIntakeItem.create({ data: { organizationId: org.organizationId, intakeId: intake.id, seq: 2, kind: 'IMAGE', lineMessageId: `${Date.now()}2${Math.floor(Math.random() * 1e6)}`, fetchStatus: 'STORED', fileId, receivedAt: NOW } })
    await prisma.chatIntakeItem.create({ data: { organizationId: org.organizationId, intakeId: intake.id, seq: 3, kind: 'IMAGE', lineMessageId: `${Date.now()}3${Math.floor(Math.random() * 1e6)}`, fetchStatus: 'FAILED', fetchError: 'GONE', receivedAt: NOW } })
  }
  return { intakeId: intake.id, fileId }
}

const liff = (code: string) => org.ctxOf(code, NOW, 'LIFF')

describe('[FR-LINE-301/AC4] the owner picks a type in LIFF: a request draft by request.create_draft, then checked, edited and sent by the requester', () => {
  it('opening the chat draft changes nothing; picking a type makes the draft with the first line as title, the photos as OTHER, source CHAT_INTAKE', async () => {
    const { intakeId, fileId } = await chatDraft('req_con', '\n  กระดาษถ่ายเอกสาร A4 80 แกรม  \nจำนวน 10 รีม ส่งที่หน้างาน', { photos: true })
    const before = await prisma.request.count({ where: { organizationId: org.organizationId } })
    const view = ok(await getMyChatIntake(liff('req_con'), intakeId))
    expect(view).toMatchObject({ status: 'OPEN', proposedTitle: 'กระดาษถ่ายเอกสาร A4 80 แกรม', images: [{ seq: 2, state: 'STORED' }, { seq: 3, state: 'FAILED' }] })
    expect(ok(await getMyChatIntake(liff('req_con'), intakeId))).toEqual(view)
    expect(await prisma.request.count({ where: { organizationId: org.organizationId } })).toBe(before)
    expect((await listMyOpenChatIntakes(liff('req_con'), 5)).map((r) => r.id)).toContain(intakeId)

    const made = ok(await draftFromChat(liff('req_con'), { intakeId, requestTypeCode: 'BUY_GOODS' }, key()))
    expect(made.images).toBe(1)
    const request = await prisma.request.findUniqueOrThrow({ where: { id: made.requestId }, include: { requestType: true } })
    expect(request).toMatchObject({ status: 'DRAFT', title: 'กระดาษถ่ายเอกสาร A4 80 แกรม', requesterMemberId: org.member.req_con })
    expect(request.requestType.code).toBe('BUY_GOODS')
    expect(await prisma.fileLink.findMany({ where: { subjectType: 'Request', subjectId: made.requestId }, select: { fileId: true, kind: true } })).toEqual([{ fileId, kind: 'OTHER' }])
    expect(await prisma.chatIntake.findUniqueOrThrow({ where: { id: intakeId } })).toMatchObject({ status: 'DRAFTED', requestId: made.requestId, text: '\n  กระดาษถ่ายเอกสาร A4 80 แกรม  \nจำนวน 10 รีม ส่งที่หน้างาน' })
    const drafted = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'request.drafted', aggregateId: made.requestId }, orderBy: { seq: 'asc' } })
    expect(drafted).toMatchObject({ channel: 'LIFF', actorMemberId: org.member.req_con, schemaVersion: 2 })
    expect(drafted.data).toMatchObject({ requestTypeCode: 'BUY_GOODS', source: 'CHAT_INTAKE', lines: 0 })
    const chatDrafted = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'chat_intake.drafted', aggregateId: intakeId } })
    expect(chatDrafted.data).toEqual({ requestId: made.requestId, requestTypeCode: 'BUY_GOODS', images: 1, aiAssisted: false })
    // The text stays on the chat draft as a reference until the sweep clears it
    expect(ok(await getMyChatIntake(liff('req_con'), intakeId))).toMatchObject({ status: 'DRAFTED', requestId: made.requestId })

    // [FR-LINE-301/AC6] with the AI module off the requester completes it: lines and budget in the LIFF form, then sends it
    ok(await editRequest(liff('req_con'), { requestId: made.requestId, expectedVersion: 0, budgetLineId, lines: [{ description: 'กระดาษถ่ายเอกสาร A4', quantity: '10', uom: 'รีม', unitPrice: '120.00' }] }, key()))
    const sent = ok(await submitRequest(liff('req_con'), { requestId: made.requestId }, key()))
    expect(sent.number).toMatch(/^PR-/)
    expect(await prisma.request.findUniqueOrThrow({ where: { id: made.requestId } })).toMatchObject({ status: 'PENDING_APPROVAL', number: sent.number })
  })

  it('the title is the first line cut at a whole character within 200 UTF-16 code units; a draft with only photos needs a title from the owner', async () => {
    const long = 'น้ำ'.repeat(70) + 'ท้ายบรรทัด'
    const { intakeId } = await chatDraft('req_con', long)
    const made = ok(await draftFromChat(liff('req_con'), { intakeId, requestTypeCode: 'BUY_GOODS' }, key()))
    const title = (await prisma.request.findUniqueOrThrow({ where: { id: made.requestId } })).title
    expect(title).toBe('น้ำ'.repeat(66))
    expect(title.length).toBeLessThanOrEqual(200)

    const photosOnly = await chatDraft('req_con', null)
    expect(await draftFromChat(liff('req_con'), { intakeId: photosOnly.intakeId, requestTypeCode: 'BUY_GOODS' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'title', reason: 'INTAKE_TITLE' } } })
    ok(await draftFromChat(liff('req_con'), { intakeId: photosOnly.intakeId, requestTypeCode: 'BUY_GOODS', title: 'อุปกรณ์ตามรูป' }, key()))
  })

  it('a type that is not switched on is refused and nothing changes; the same submission again makes one draft', async () => {
    const { intakeId } = await chatDraft('req_con', 'เก้าอี้')
    expect(await draftFromChat(liff('req_con'), { intakeId, requestTypeCode: 'NO_SUCH_TYPE' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'requestTypeCode', reason: 'INTAKE_TYPE' } } })
    expect(await prisma.chatIntake.findUniqueOrThrow({ where: { id: intakeId } })).toMatchObject({ status: 'OPEN', requestId: null })
    const once = key()
    const first = ok(await draftFromChat(liff('req_con'), { intakeId, requestTypeCode: 'BUY_GOODS' }, once))
    expect(ok(await draftFromChat(liff('req_con'), { intakeId, requestTypeCode: 'BUY_GOODS' }, once))).toEqual(first)
    expect(await draftFromChat(liff('req_con'), { intakeId, requestTypeCode: 'BUY_GOODS' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await prisma.request.count({ where: { organizationId: org.organizationId, title: 'เก้าอี้' } })).toBe(1)
  })
})

describe('[FR-LINE-301/AC3] a photo fetched after the owner made the request draft lands on that request', () => {
  it('the image job stores it on the DRAFTED chat draft and attaches it as OTHER while the request is a draft; a sent request is left as it was', async () => {
    const { intakeId } = await chatDraft('req_con', 'โต๊ะประชุมตามรูป')
    const pending = await prisma.chatIntakeItem.create({ data: { organizationId: org.organizationId, intakeId, seq: 2, kind: 'IMAGE', lineMessageId: `${Date.now()}9${Math.floor(Math.random() * 1e6)}`, fetchStatus: 'PENDING', receivedAt: NOW } })
    const made = ok(await draftFromChat(liff('req_con'), { intakeId, requestTypeCode: 'BUY_GOODS' }, key()))
    expect(made.images).toBe(0)
    const store = (itemId: string) =>
      runCommand(systemCtx(org.organizationId, NOW, 'chat-intake-image'), storeChatImageCommand, { itemId, status: 'STORED', key: `org/${org.organizationId}/chat-intake/${intakeId}/${itemId}`, mimeType: 'image/jpeg', sizeBytes: 10, sha256: 'b'.repeat(64) }, key())
    const stored = ok(await store(pending.id))
    expect(await prisma.fileLink.findMany({ where: { subjectType: 'Request', subjectId: made.requestId }, select: { fileId: true, kind: true } })).toEqual([{ fileId: stored.fileId, kind: 'OTHER' }])
    const attachedEvent = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'request.drafted', aggregateId: made.requestId, data: { path: ['file', 'fileId'], equals: stored.fileId! } } })
    expect(attachedEvent).toMatchObject({ actorType: 'SYSTEM' })

    // Sent meanwhile: the request keeps what it was sent with
    ok(await editRequest(liff('req_con'), { requestId: made.requestId, budgetLineId, lines: [{ description: 'โต๊ะประชุม', quantity: '1', uom: 'ตัว', unitPrice: '3500.00' }] }, key()))
    ok(await submitRequest(liff('req_con'), { requestId: made.requestId }, key()))
    const later = await prisma.chatIntakeItem.create({ data: { organizationId: org.organizationId, intakeId, seq: 3, kind: 'IMAGE', lineMessageId: `${Date.now()}8${Math.floor(Math.random() * 1e6)}`, fetchStatus: 'PENDING', receivedAt: NOW } })
    ok(await store(later.id))
    expect(await prisma.fileLink.count({ where: { subjectType: 'Request', subjectId: made.requestId } })).toBe(1)
  })
})

describe('[FR-LINE-301/AC7] only the owner sees and uses a chat draft; "ไม่ใช่คำขอ" closes it', () => {
  it('anyone else — ORG_ADMIN and AUDITOR too — gets NOT_FOUND for reading, drafting and dismissing', async () => {
    const { intakeId } = await chatDraft('req_con', 'ของคนอื่นห้ามเห็น')
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
    for (const code of ['admin', 'dm_con', 'ceo']) {
      expect(await getMyChatIntake(liff(code), intakeId), code).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
      expect(await draftFromChat(liff(code), { intakeId, requestTypeCode: 'BUY_GOODS' }, key()), code).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
      expect(await dismissChatIntake(liff(code), { intakeId }, key()), code).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
      expect((await listMyOpenChatIntakes(liff(code), 5)).map((r) => r.id), code).not.toContain(intakeId)
    }
    expect(await prisma.chatIntake.findUniqueOrThrow({ where: { id: intakeId } })).toMatchObject({ status: 'OPEN' })
  })

  it('the draft form leads back to the chat text for its owner only', async () => {
    const { intakeId } = await chatDraft('req_con', 'กล่องเอกสาร')
    const made = ok(await draftFromChat(liff('req_con'), { intakeId, requestTypeCode: 'BUY_GOODS' }, key()))
    expect(await chatIntakeIdOfRequest(liff('req_con'), made.requestId)).toBe(intakeId)
    for (const code of ['admin', 'dm_con']) expect(await chatIntakeIdOfRequest(liff(code), made.requestId), code).toBeNull()
  })

  it('the owner dismisses it: DISMISSED, no request, and it can no longer be drafted', async () => {
    const { intakeId } = await chatDraft('req_con', 'ส่งผิด ไม่ใช่คำขอ')
    ok(await dismissChatIntake(liff('req_con'), { intakeId }, key()))
    expect(await prisma.chatIntake.findUniqueOrThrow({ where: { id: intakeId } })).toMatchObject({ status: 'DISMISSED', requestId: null })
    expect((await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'chat_intake.dismissed', aggregateId: intakeId } })).data).toEqual({})
    expect(await draftFromChat(liff('req_con'), { intakeId, requestTypeCode: 'BUY_GOODS' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect((await listMyOpenChatIntakes(liff('req_con'), 50)).map((r) => r.id)).not.toContain(intakeId)
  })
})
