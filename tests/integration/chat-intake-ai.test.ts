import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setAiClientForTests, type AiClient, type AiRequest } from '@/integrations/ai'
import { putObject } from '@/integrations/storage'
import { PROMPT_VERSIONS } from '@/lib/ai-config'
import { CHAT_AI_READING_WINDOW_MS, MS_PER_DAY, MS_PER_HOUR, MS_PER_SECOND } from '@/lib/constants'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { chatIntakeAiRun } from '@/server/jobs/chat-intake-ai'
import { runCommand } from '@/server/services/_pipeline'
import { runMonthlyGrant, setAiRuntimeForTests, updateAgentSetting, type AiRuntime } from '@/server/services/ai'
import { chatIntakeAiView, draftFromChat, linkChatIntakeAgentActionCommand, readChatIntakeWithAi, runChatIntakeSweep } from '@/server/services/chat-intake'
import { getRequestForEdit } from '@/server/services/requests/form-view'
import { createDraft, editRequest, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// S17-08 · asking through the LINE chat, the AI part (FR-LINE-301 AC5 AC6 · BR-LINE-11 BR-LINE-13 · ADR-162). Job
// chat-intake-ai reads a chat draft with the Intake Agent of S13 (fixture mode: the model's answers are handed in by the
// test, which counts the calls) and links the reading; LIFF offers its values; what the owner takes goes into the request
// draft through aiAssist, and the values BR-AI-16 asks to confirm one by one hold the request back until confirmed with
// request.edit. The requester still sends it. The database and the bucket are real.

const NOW = new Date('2026-10-22T02:00:00Z')
const FIXTURE: AiRuntime = { enabled: true, mode: 'fixture', appEnv: 'local', modelEnv: {}, gates: [] }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const step = { run: <T,>(_id: string, fn: () => Promise<T>) => fn() }
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let budgetLineId: string
const sent: Array<AiRequest<unknown>> = []

const reading = {
  requestTypeCode: 'BUY_GOODS',
  title: 'หมวกนิรภัยสำหรับไซต์',
  siteCode: null,
  neededBy: null,
  lines: [{ description: 'หมวกนิรภัยสีขาว', itemCode: null, qty: '20', unit: 'ใบ', unitPrice: '250' }],
  supplier: { name: null, taxId: null, branch: null },
  confidence: [
    { field: 'title', value: 95 },
    { field: 'lines.0.description', value: 96 },
    { field: 'lines.0.unit', value: 97 },
  ],
}

beforeAll(async () => {
  org = await createDoaOrg()
  budgetLineId = await p2p(org, NOW).fundedLine(5_000_000n)
  await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'AI', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-S17', reason: 'ทดสอบขอผ่านแชท' } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  setAiRuntimeForTests(FIXTURE)
  ok(await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'INTAKE', enabled: true }, key()))
  ok(await runMonthlyGrant(org.organizationId, NOW))
  const client: AiClient = {
    mode: 'fixture',
    extract: async (request) => {
      sent.push(request as AiRequest<unknown>)
      return { ok: true, promptVersion: PROMPT_VERSIONS[request.purpose], model: request.model, output: request.schema.parse(reading), usage: { input: 1500, output: 300, cacheRead: 0, cacheWrite: 0 }, latencyMs: 500 }
    },
    write: async () => {
      throw new Error('not used')
    },
  }
  setAiClientForTests(client)
})
afterAll(() => setAiClientForTests(null))

let messageNo = 0
const lineId = () => `${Date.now()}${String(++messageNo).padStart(5, '0')}`

/** A chat draft of the requester as the chat side leaves it: its text, and a photo PENDING or STORED */
async function chatDraft(text: string, photo: 'NONE' | 'PENDING' | 'STORED' = 'NONE') {
  const memberId = org.member.req_con!
  const intake = await prisma.chatIntake.create({
    data: { organizationId: org.organizationId, memberId, status: 'OPEN', text, messageCount: photo === 'NONE' ? 1 : 2, imageCount: photo === 'NONE' ? 0 : 1, openedAt: NOW, lastMessageAt: NOW, expiresAt: new Date(NOW.getTime() + 24 * MS_PER_HOUR) },
  })
  await prisma.chatIntakeItem.create({ data: { organizationId: org.organizationId, intakeId: intake.id, seq: 1, kind: 'TEXT', lineMessageId: lineId(), receivedAt: NOW } })
  let photoItemId: string | null = null
  if (photo !== 'NONE') {
    const item = await prisma.chatIntakeItem.create({ data: { organizationId: org.organizationId, intakeId: intake.id, seq: 2, kind: 'IMAGE', lineMessageId: lineId(), fetchStatus: 'PENDING', receivedAt: NOW } })
    photoItemId = item.id
    if (photo === 'STORED') await storePhoto(intake.id, item.id)
  }
  return { intakeId: intake.id, photoItemId }
}

async function storePhoto(intakeId: string, itemId: string) {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(`chat-${randomUUID()}`)])
  const storageKey = `org/${org.organizationId}/chat-intake/${intakeId}/${itemId}`
  await putObject(storageKey, bytes, 'image/jpeg')
  const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey, fileName: 'chat-2.jpg', mimeType: 'image/jpeg', sizeBytes: bytes.length, status: 'AVAILABLE', uploadedById: org.member.req_con!, scanStatus: 'NOT_REQUIRED' } })
  await prisma.chatIntakeItem.update({ where: { id: itemId }, data: { fetchStatus: 'STORED', fileId: file.id } })
}

const run = (intakeId: string) => chatIntakeAiRun({ data: { organizationId: org.organizationId, aggregateId: intakeId } }, step)
const liff = (code: string) => org.ctxOf(code, NOW, 'LIFF')

describe('[FR-LINE-301/AC5] job chat-intake-ai reads the chat draft with the Intake Agent once its photos are in, and links the reading', () => {
  it('waits for a photo still being fetched; then reads text and photo once under chat_intake:<id>:<seq>; a retry calls nothing; a new message is a new reading', async () => {
    const { intakeId, photoItemId } = await chatDraft('ขอหมวกนิรภัย 20 ใบ ใบละ 250 บาท', 'PENDING')
    expect(await run(intakeId)).toEqual({ status: 'SKIPPED', reason: 'IMAGES_PENDING' })
    await storePhoto(intakeId, photoItemId!)

    const calls = sent.length
    const first = await run(intakeId)
    expect(first).toMatchObject({ status: 'LINKED' })
    expect(sent.length).toBe(calls + 1)
    // The photo was read in the same call (FR-AI-303 AC9 through intakeFromMessage)
    expect(sent.at(-1)!.files?.map((f) => f.mediaType)).toEqual(['image/jpeg'])
    const agentActionId = (first as { agentActionId: string }).agentActionId
    const action = await prisma.agentAction.findUniqueOrThrow({ where: { id: agentActionId } })
    expect(action).toMatchObject({ subjectType: 'CHAT_INTAKE', subjectId: intakeId, requestedById: org.member.req_con, channel: 'LINE_CHAT', idempotencyKey: `chat_intake:${intakeId}:2`, inputText: null })
    expect(await prisma.chatIntake.findUniqueOrThrow({ where: { id: intakeId } })).toMatchObject({ agentActionId })
    expect((await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'chat_intake.ai_requested', aggregateId: intakeId } })).data).toEqual({ agentActionId })

    // The job tried again: the same messages give the same reading without a call
    expect(await run(intakeId)).toEqual({ status: 'SKIPPED', reason: 'READ_ALREADY' })
    expect(await readChatIntakeWithAi(org.organizationId, intakeId, NOW)).toEqual({ status: 'SKIPPED', reason: 'READ_ALREADY' })
    await prisma.chatIntake.update({ where: { id: intakeId }, data: { agentActionId: null } })
    expect(await readChatIntakeWithAi(org.organizationId, intakeId, NOW)).toEqual({ status: 'READ', agentActionId, idempotencyKey: `chat_intake:${intakeId}:2` })
    expect(sent.length).toBe(calls + 1)
    await prisma.chatIntake.update({ where: { id: intakeId }, data: { agentActionId } })

    // A new message: a new key, a new reading, linked over the older one; the older one never comes back over it
    await prisma.chatIntakeItem.create({ data: { organizationId: org.organizationId, intakeId, seq: 3, kind: 'TEXT', lineMessageId: lineId(), receivedAt: NOW } })
    const second = await run(intakeId)
    expect(second).toMatchObject({ status: 'LINKED' })
    expect(sent.length).toBe(calls + 2)
    const newer = (second as { agentActionId: string }).agentActionId
    expect(newer).not.toBe(agentActionId)
    const ctx = systemCtx(org.organizationId, NOW, 'chat-intake-ai')
    expect(await runCommand(ctx, linkChatIntakeAgentActionCommand, { intakeId, agentActionId }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await prisma.chatIntake.findUniqueOrThrow({ where: { id: intakeId } })).toMatchObject({ agentActionId: newer })
    // Only the system links a reading
    expect(await runCommand(liff('req_con'), linkChatIntakeAgentActionCommand, { intakeId, agentActionId: newer }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('LIFF offers the reading to its owner only: the proposed type, the values in words, and which ones are confirmed one by one', async () => {
    const { intakeId } = await chatDraft('ขอหมวกนิรภัย 20 ใบ')
    // The job links the reading once the model answered: until then, LIFF says the AI is reading it (AC5)
    expect(ok(await chatIntakeAiView(liff('req_con'), intakeId, 'th'))).toEqual({ status: 'READING' })
    await run(intakeId)
    const view = ok(await chatIntakeAiView(liff('req_con'), intakeId, 'th'))
    expect(view).toMatchObject({ status: 'READY', requestTypeCode: 'BUY_GOODS' })
    if (view.status !== 'READY') throw new Error('not ready')
    expect(Object.fromEntries(view.values.map((v) => [v.path, [v.text, v.mustConfirm]]))).toEqual({
      title: ['หมวกนิรภัยสำหรับไซต์', false],
      'lines.0.description': ['หมวกนิรภัยสีขาว', false],
      'lines.0.quantity': ['20', true],
      'lines.0.uom': ['ใบ', false],
      'lines.0.unitPrice': ['250.00', true],
    })
    for (const code of ['dm_con', 'admin']) expect(await chatIntakeAiView(liff(code), intakeId, 'th'), code).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('while the reading runs LIFF says so', async () => {
    const { intakeId } = await chatDraft('ขอโต๊ะ')
    const action = await prisma.agentAction.create({
      data: { organizationId: org.organizationId, agent: 'INTAKE', purpose: 'INTAKE', level: 'L1', status: 'PENDING', subjectType: 'CHAT_INTAKE', subjectId: intakeId, requestedById: org.member.req_con!, channel: 'LINE_CHAT', promptVersion: PROMPT_VERSIONS.INTAKE },
    })
    await prisma.chatIntake.update({ where: { id: intakeId }, data: { agentActionId: action.id } })
    expect(ok(await chatIntakeAiView(liff('req_con'), intakeId, 'th'))).toEqual({ status: 'READING' })
  })

  it('before the reading is linked LIFF says the AI is reading for CHAT_AI_READING_WINDOW_MS after the last message, then nothing', async () => {
    const { intakeId } = await chatDraft('ขอเก้าอี้')
    const at = (ms: number) => org.ctxOf('req_con', new Date(NOW.getTime() + ms), 'LIFF')
    expect(ok(await chatIntakeAiView(at(CHAT_AI_READING_WINDOW_MS - MS_PER_SECOND), intakeId, 'th'))).toEqual({ status: 'READING' })
    // No answer by then: the reading failed or was skipped, and the page offers nothing of it
    expect(ok(await chatIntakeAiView(at(CHAT_AI_READING_WINDOW_MS), intakeId, 'th'))).toEqual({ status: 'NONE' })
    // Nothing to read: no words and no photo
    const empty = await chatDraft('   ')
    expect(ok(await chatIntakeAiView(liff('req_con'), empty.intakeId, 'th'))).toEqual({ status: 'NONE' })
  })
})

describe('[FR-LINE-301/AC5] the values the owner takes go into the request draft through aiAssist; money and quantities wait to be confirmed one by one; the requester sends it', () => {
  it('a draft with the reading: AI_REVIEW_PENDING until request.edit confirms each value, then the requester sends it', async () => {
    const { intakeId } = await chatDraft('ขอหมวกนิรภัย 20 ใบ ใบละ 250 บาท')
    const read = await run(intakeId)
    const agentActionId = (read as { agentActionId: string }).agentActionId
    const all = ['title', 'lines.0.description', 'lines.0.quantity', 'lines.0.uom', 'lines.0.unitPrice']
    // The lines go together or not at all
    expect(await draftFromChat(liff('req_con'), { intakeId, requestTypeCode: 'BUY_GOODS', ai: { agentActionId, usePaths: ['lines.0.description'] } }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { reason: 'AI_LINES' } },
    })
    const made = ok(await draftFromChat(liff('req_con'), { intakeId, requestTypeCode: 'BUY_GOODS', ai: { agentActionId, usePaths: all } }, key()))
    const request = await prisma.request.findUniqueOrThrow({ where: { id: made.requestId }, include: { lines: true } })
    // Nothing is sent by itself: a draft, with what the AI read
    expect(request).toMatchObject({ status: 'DRAFT', title: 'หมวกนิรภัยสำหรับไซต์' })
    expect(request.lines.map((l) => [l.description, l.quantity.toString(), l.uom, l.unitPriceSatang])).toEqual([['หมวกนิรภัยสีขาว', '20', 'ใบ', 25_000n]])
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: agentActionId } })).toMatchObject({ subjectType: 'REQUEST', subjectId: made.requestId, status: 'DRAFT' })
    const drafted = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'chat_intake.drafted', aggregateId: intakeId } })
    expect(drafted.data).toMatchObject({ aiAssisted: true })
    expect((await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'request.drafted', aggregateId: made.requestId }, orderBy: { seq: 'asc' } })).data).toMatchObject({ source: 'CHAT_INTAKE', agentActionId })

    ok(await editRequest(liff('req_con'), { requestId: made.requestId, budgetLineId }, key()))
    expect(await submitRequest(liff('req_con'), { requestId: made.requestId }, key())).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING', details: { count: 2 } } })
    // What the LIFF form offers is exactly what submit counts
    const form = ok(await getRequestForEdit(liff('req_con'), made.requestId, 'th'))
    expect(form.draft?.intakeAi?.pendingPaths).toEqual(['lines.0.quantity', 'lines.0.unitPrice'])
    // One of the two confirmed: still waiting
    ok(await editRequest(liff('req_con'), { requestId: made.requestId, aiAssist: { agentActionId, confirmedPaths: ['lines.0.quantity'] } }, key()))
    expect(await submitRequest(liff('req_con'), { requestId: made.requestId }, key())).toMatchObject({ ok: false, error: { code: 'AI_REVIEW_PENDING', details: { count: 1 } } })
    ok(await editRequest(liff('req_con'), { requestId: made.requestId, aiAssist: { agentActionId, confirmedPaths: ['lines.0.unitPrice'] } }, key()))
    ok(await submitRequest(liff('req_con'), { requestId: made.requestId }, key()))
    expect(await prisma.request.findUniqueOrThrow({ where: { id: made.requestId } })).toMatchObject({ status: 'PENDING_APPROVAL' })
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: agentActionId } })).toMatchObject({ status: 'ACCEPTED' })
  })

  it('a chat reading belongs to its owner: another member cannot take it into their own request (NOT_FOUND), and it stays on the chat draft', async () => {
    const { intakeId } = await chatDraft('ขอกุญแจล็อก 5 ชุด')
    const read = (await run(intakeId)) as { agentActionId: string }
    const theirs = ok(await createDraft(org.ctxOf('dm_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ของฝ่ายอื่น' }, key()))
    expect(await editRequest(org.ctxOf('dm_con', NOW), { requestId: theirs.requestId, aiAssist: { agentActionId: read.agentActionId, confirmedPaths: [] } }, key())).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND', details: { field: 'aiAssist.agentActionId' } },
    })
    expect(await prisma.agentAction.findUniqueOrThrow({ where: { id: read.agentActionId } })).toMatchObject({ subjectType: 'CHAT_INTAKE', subjectId: intakeId, appliedAt: null })
  })

  it('a reading of another chat draft is refused; taking nothing of it makes the plain draft', async () => {
    const one = await chatDraft('ขอหมวกนิรภัย 20 ใบ')
    const other = await chatDraft('ขอถุงมือ 10 คู่')
    const read = (await run(one.intakeId)) as { agentActionId: string }
    expect(await draftFromChat(liff('req_con'), { intakeId: other.intakeId, requestTypeCode: 'BUY_GOODS', ai: { agentActionId: read.agentActionId, usePaths: ['title'] } }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'ai.agentActionId' } },
    })
    const plain = ok(await draftFromChat(liff('req_con'), { intakeId: one.intakeId, requestTypeCode: 'BUY_GOODS' }, key()))
    expect(await prisma.request.findUniqueOrThrow({ where: { id: plain.requestId }, include: { lines: true } })).toMatchObject({ title: 'ขอหมวกนิรภัย 20 ใบ', lines: [] })
    expect((await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'chat_intake.drafted', aggregateId: one.intakeId } })).data).toMatchObject({ aiAssisted: false })
  })
})

describe('[FR-LINE-301/AC6] with the Intake Agent off the chat and LIFF work on without AI', () => {
  it('nothing is read or linked, LIFF shows no reading, and the draft is made from the form alone', async () => {
    ok(await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'INTAKE', enabled: false }, key()))
    try {
      const { intakeId } = await chatDraft('ขอกล่องเครื่องมือ')
      const calls = sent.length
      // LIFF does not say the AI is reading a draft the agent will never read
      expect(ok(await chatIntakeAiView(liff('req_con'), intakeId, 'th'))).toEqual({ status: 'NONE' })
      expect(await run(intakeId)).toEqual({ status: 'SKIPPED', reason: 'AI_AGENT_DISABLED' })
      expect(sent.length).toBe(calls)
      expect(ok(await chatIntakeAiView(liff('req_con'), intakeId, 'th'))).toEqual({ status: 'NONE' })
      ok(await draftFromChat(liff('req_con'), { intakeId, requestTypeCode: 'BUY_GOODS' }, key()))
    } finally {
      ok(await updateAgentSetting(org.ctxOf('admin', NOW), { agent: 'INTAKE', enabled: true }, key()))
    }
  })
})

describe('[FR-LINE-301/AC7] BR-LINE-11: what the AI read of a chat draft goes with its text', () => {
  it('the purge of an expired draft clears its reading in the same transaction; a reading a request took stays the request\'s', async () => {
    const { intakeId } = await chatDraft('ขอหมวกนิรภัย 20 ใบ ส่งบางนา')
    const read = (await run(intakeId)) as { agentActionId: string }
    await runChatIntakeSweep(org.organizationId, new Date(NOW.getTime() + 25 * MS_PER_HOUR))
    const purge = await runChatIntakeSweep(org.organizationId, new Date(NOW.getTime() + 8 * MS_PER_DAY))
    expect(purge.purged).toBeGreaterThanOrEqual(1)
    const action = await prisma.agentAction.findUniqueOrThrow({ where: { id: read.agentActionId } })
    expect(action.contentPurgedAt).not.toBeNull()
    expect(action.review).toEqual({ purged: true })
    const purged = await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, type: 'agent_action.content_purged', aggregateId: read.agentActionId } })
    expect(purged.data).toEqual({ reason: 'CHAT_INTAKE_UNUSED' })
    // The reading the earlier test took into a request moved to it, and is not a chat draft's any more
    expect(await prisma.agentAction.count({ where: { organizationId: org.organizationId, subjectType: 'REQUEST', contentPurgedAt: { not: null } } })).toBe(0)
  })
})

describe('[FR-LINE-301/AC5] a full chat draft is read within what the Intake Agent takes (ADR-073 pre-review)', () => {
  it('seven photos and 2,000 characters ending with an emoji: the reading takes the first five photos and the text cut to 2,000 UTF-16 units', async () => {
    // 2,000 characters as LINE and the chat draft count them (code points), 2,001 UTF-16 units as the agent counts them
    const kept = 'ข'.repeat(1_999)
    const { intakeId } = await chatDraft(`${kept}🙂`)
    for (let n = 0; n < 7; n++) {
      const item = await prisma.chatIntakeItem.create({ data: { organizationId: org.organizationId, intakeId, seq: n + 2, kind: 'IMAGE', lineMessageId: lineId(), fetchStatus: 'PENDING', receivedAt: NOW } })
      await storePhoto(intakeId, item.id)
    }
    const calls = sent.length
    expect(await run(intakeId)).toMatchObject({ status: 'LINKED' })
    expect(sent.length).toBe(calls + 1)
    expect(sent.at(-1)!.files).toHaveLength(5)
    expect(String(sent.at(-1)!.text)).toContain(kept)
    expect(String(sent.at(-1)!.text)).not.toContain('🙂')
  })
})
