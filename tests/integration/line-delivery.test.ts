import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatThaiDateTime } from '@/core/thai'
import { createLineClient, setLineClient } from '@/integrations/line'
import { ManualClock } from '@/lib/clock'
import { MS_PER_MINUTE, MS_PER_SECOND } from '@/lib/constants'
import { prisma } from '@/server/db/client'
import { getDefaultOutboxSender, setDefaultOutboxSender, type OutboxSender } from '@/server/events/outbox'
import { receiveLineWebhook } from '@/server/jobs/line-webhook'
import { notificationDeliverRun, type DeliveryStep } from '@/server/jobs/notification-deliver'
import { documentLink, taskLink } from '@/server/line/postback-cards'
import { deliverNotification, LINE_DELIVERY_GIVE_UP_MS, LINE_FALLBACK_WITHIN_MS, TASK_CLOSED, type OpenLineChannelForDelivery } from '@/server/notifications/deliver'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import { openLineChannel, saveLineChannelSettings } from '@/server/services/line-channel'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { createDraft, submitRequest } from '@/server/services/requests'
import { escalateTask, markTaskOverdue, remindTaskSla } from '@/server/services/sla'
import { emailLinkPath } from '@/server/tokens/action-tokens'
import { startFakeLine } from '../../scripts/lib/fake-line'
import { buildLineWebhook, lineEvents, newLineUserId, signLineWebhook } from '../../scripts/line-simulate'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'
import { messagesTo } from '../support/mailpit'
import { p2p } from '../support/p2p'

// S5-08 · delivering notifications by LINE with e-mail as the fallback (spec §4.7 rule 2, §10.1, BR-NOTI-01 to 03,
// BR-LINE-08, FR-LINE-007 AC3, FR-NOTI-002 AC1, FR-NOTI-003 AC3). LINE is the fake LINE server of the repo — a user id
// starting with "Ublocked" is refused with 403 (a stand-in: what real LINE answers a push to a user who blocked the
// account is unconfirmed until D-03), one starting with "Udown" answers 500 (LINE trouble) — and answers the fake does
// not give (a 400 naming the recipient, the monthly quota's 429) come from a stand-in fetch for the push call. E-mail
// goes to the Mailpit of docker-compose. The job's retries run on a fake clock: the run sleeps by moving it.

const NOW = new Date('2026-10-06T02:00:00Z')
/** Thursday 8 Oct 2026 09:00 Thai time: past the escalation time of a task assigned at NOW (8 business hours after due) */
const THU_0900 = new Date('2026-10-08T02:00:00Z')
const PROVIDER = '1650000001'
const LIFF_ID = '1650000003-AbCdEfGh'
const LIFF = `https://liff.line.me/${LIFF_ID}`
const CHANNEL = { providerId: PROVIDER, messagingChannelId: '1650000002', channelSecret: TEST_CHANNEL_SECRET, channelAccessToken: TEST_ACCESS_TOKEN, liffId: LIFF_ID, liffChannelId: '1650000003' }
const blockedUser = () => `Ublocked${randomUUID().replace(/-/g, '')}`
const downUser = () => `Udown${randomUUID().replace(/-/g, '')}`

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

const line = withFakeLine()
let inngestBefore: OutboxSender | null = null
let org: DoaOrg
let budgetLineId: string
let channelKey: string

/** Links the member to this LINE user (a live ChannelIdentity, as S5-04's link makes), ending any earlier link */
async function linkTo(code: string, lineUserId: string = newLineUserId()) {
  const memberId = org.member[code]!
  await prisma.channelIdentity.updateMany({ where: { organizationId: org.organizationId, memberId, unlinkedAt: null }, data: { unlinkedAt: NOW } })
  await prisma.channelIdentity.create({ data: { organizationId: org.organizationId, memberId, channel: 'LINE', providerKey: PROVIDER, externalUserId: lineUserId, linkedAt: NOW } })
  await prisma.member.update({ where: { id: memberId }, data: { lineReachable: true } })
  return lineUserId
}

beforeAll(async () => {
  inngestBefore = getDefaultOutboxSender()
  setDefaultOutboxSender(async () => {})
  org = await createDoaOrg()
  budgetLineId = await p2p(org, NOW).fundedLine(5_000_000n)
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  channelKey = ok(await saveLineChannelSettings(org.ctxOf('admin', NOW), { ...CHANNEL, active: true }, key())).channelKey
})
afterAll(() => setDefaultOutboxSender(inngestBefore))

/** A submitted request (with the quotations ATT-QUOTES asks above 100,000), its task and the assignee's task.assigned notice */
async function submitted(net = '10000.00') {
  const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุสำนักงาน', budgetLineId, lines: [{ description: 'กระดาษถ่ายเอกสาร A4', quantity: '1', uom: 'รีม', unitPrice: net }] }, key()))
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'ใบเสนอราคา-ร้านเอ.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
  }
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
  const notice = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.assigned', data: { path: ['taskId'], equals: task.id } } })
  const request = await prisma.request.findUniqueOrThrow({ where: { id: draft.requestId } })
  const emailToken = await prisma.actionToken.findFirstOrThrow({ where: { taskId: task.id, channel: 'EMAIL' } })
  return { requestId: request.id, number: request.number!, task, notice, emailToken }
}

const withLine = { openChannel: openLineChannel }
const pushesTo = (lineUserId: string) => line.fake.messages().filter((m) => m.kind === 'push' && m.to === lineUserId)
const pushTries = () => line.fake.requests().filter((r) => r.route === '/v2/bot/message/push').length
const emailOf = async (code: string) => (await prisma.member.findUniqueOrThrow({ where: { id: org.member[code]! } })).email
const reachable = async (code: string) => (await prisma.member.findUniqueOrThrow({ where: { id: org.member[code]! } })).lineReachable

/**
 * LINE answering every push with this status and body, the rest of the API being the fake server's: for answers the
 * fake does not give. Runs `body` with that client and puts the fake's client back.
 */
async function withPushAnswer<T>(status: number, answer: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  const standIn: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/v2/bot/message/push')) {
      return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json', 'x-line-request-id': randomUUID() } })
    }
    return fetch(input, init)
  }
  setLineClient(createLineClient({ apiBaseUrl: line.fake.url, dataApiBaseUrl: line.fake.url, fetch: standIn }))
  try {
    return await body()
  } finally {
    setLineClient(line.client)
  }
}

/** Every text of a message: the texts of a Flex card, or the text of a text message */
function textOf(message: Record<string, unknown>): string {
  if (message.type === 'text') return message.text as string
  const out: string[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>
      if (node.type === 'text' && typeof node.text === 'string') out.push(node.text)
      Object.values(node).forEach(walk)
    }
  }
  walk(message.contents)
  return out.join('\n')
}

describe('[FR-LINE-002/AC1] a new approval task reaches a linked approver as the card: the summary only', () => {
  it('pushes the card with the number, type, requester and department, amount, budget, due time and DOA rule — and nothing more (BR-NOTI-01)', async () => {
    const dm = await linkTo('dm_con')
    const before = (await messagesTo(await emailOf('dm_con'))).length
    const { number, task, notice } = await submitted()
    expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'LINE' })
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ status: 'SENT', sentChannel: 'LINE', sentAt: NOW, error: null })

    const [push, ...more] = pushesTo(dm).filter((m) => m.retryKey === notice.id)
    expect(more).toEqual([])
    // LINE's retry key is the notification: however often the job tries, LINE shows it once
    expect(push).toMatchObject({ to: dm, retryKey: notice.id })
    const card = push!.messages[0]!
    expect(card).toMatchObject({ type: 'flex', altText: `โปรดพิจารณา: ซื้อของ ${number}` })
    expect(textOf(card).split('\n')).toEqual([
      'โปรดพิจารณาอนุมัติ',
      'เลขที่',
      number,
      'ประเภท',
      'ซื้อของ',
      'ผู้ขอ',
      'ผู้ใช้ req_con · ฝ่ายก่อสร้าง',
      'ยอดตามฐาน DOA',
      '10,700.00 บาท (รวม VAT)',
      'งบ',
      'จองแล้ว',
      'กำหนด',
      formatThaiDateTime(task.dueAt!),
      'DOA',
      'DOA-DEMO ฉบับ 1 ข้อ PR-01',
    ])
    // No line item, unit price, file or other person in the chat (BR-LINE-06, BR-NOTI-01)
    const json = JSON.stringify(card)
    for (const forbidden of ['กระดาษถ่ายเอกสาร', '10,000.00', 'ใบเสนอราคา', 'ผู้ใช้ dm_con', '.pdf']) expect(json).not.toContain(forbidden)
    // Its buttons open the task in LIFF; the approve button carries the approver's LINE token
    const lineToken = await prisma.actionToken.findFirstOrThrow({ where: { taskId: task.id, channel: 'LINE' } })
    expect(json).toContain(`"data":"v=1&a=approve&k=${lineToken.id}"`)
    expect(json).toContain(`"uri":"${LIFF}/tasks/${task.id}"`)
    expect(json).toContain(`"uri":"${LIFF}/tasks/${task.id}?action=reject"`)
    // Sent by LINE, so not by e-mail
    expect(await messagesTo(await emailOf('dm_con'))).toHaveLength(before)
  })

  it('speaks the organization\'s language: an English organization gets the card in English (BR-NOTI-03)', async () => {
    const dm = await linkTo('dm_con')
    await prisma.organization.update({ where: { id: org.organizationId }, data: { locale: 'en' } })
    try {
      const { number, notice } = await submitted()
      expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'LINE' })
      const card = pushesTo(dm).find((m) => m.retryKey === notice.id)!.messages[0]!
      expect(card).toMatchObject({ altText: `Please review: ซื้อของ ${number}` })
      expect(textOf(card)).toContain('Waiting for your approval')
      expect(textOf(card)).toContain('10,700.00 baht (incl. VAT)')
      expect(textOf(card)).toContain('DOA-DEMO version 1 rule PR-01')
    } finally {
      await prisma.organization.update({ where: { id: org.organizationId }, data: { locale: 'th' } })
    }
  })

  it('a PO card: its number and type, the amount, the budget its requests hold and the DOA rule — no person, item, price or supplier', async () => {
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 8)}`, nameTh: 'บริษัท ผู้ขายทดสอบ จำกัด', taxId: '0999999000012', branchCode: '00001', email: `po-${randomUUID().slice(0, 8)}@supplier.test` } })
    const kit = p2p(org, NOW)
    const pr = await kit.approvedRequest(budgetLineId, [{ quantity: '10', unitPrice: '1250.00', description: 'ปูนซีเมนต์ปอร์ตแลนด์ประเภทหนึ่ง' }])
    // The request's line on a PO of its own, sent for approval (and not approved)
    const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์ทดสอบ', address: 'ถนนทดสอบ' } })
    await prisma.request.update({ where: { id: pr.id }, data: { deliverySiteId: site.id } })
    const proc = org.ctxOf('proc_officer', NOW)
    ok(await assignSupplier(proc, { requestLineIds: [pr.lines[0]!.id], supplierId: supplier.id }, key()))
    const run = ok(await consolidateNow(proc, key()))
    const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id } })
    ok(await submitPo(proc, { poId: po.id }, key()))
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: po.id } } }, include: { step: { include: { route: true } } } })
    const route = task.step.route
    expect(route).toMatchObject({ subjectType: 'PURCHASE_ORDER', amountSatang: 1_337_500n, amountBasis: 'GROSS' })
    const approver = Object.entries(org.member).find(([, id]) => id === task.assigneeMemberId)![0]
    const lineUser = await linkTo(approver)
    const notice = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.assigned', data: { path: ['taskId'], equals: task.id } } })
    expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'LINE' })

    const card = pushesTo(lineUser).find((m) => m.retryKey === notice.id)!.messages[0]!
    const number = (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).number!
    expect(card).toMatchObject({ type: 'flex', altText: `โปรดพิจารณา: ใบสั่งซื้อ ${number}` })
    expect(textOf(card).split('\n')).toEqual([
      'โปรดพิจารณาอนุมัติ',
      'เลขที่',
      number,
      'ประเภท',
      'ใบสั่งซื้อ',
      'ยอดตามฐาน DOA',
      '13,375.00 บาท (รวม VAT)',
      'งบ',
      'จองแล้ว',
      'กำหนด',
      formatThaiDateTime(task.dueAt!),
      'DOA',
      `DOA-DEMO ฉบับ 1 ข้อ ${route.ruleCode}`,
    ])
    // A PO gathers requests and is made by a buyer: it names nobody (the requester row is a purchase request's)
    const json = JSON.stringify(card)
    for (const forbidden of ['ผู้ขอ', 'ผู้ใช้ ', 'ปูนซีเมนต์', '1,250.00', 'ผู้ขายทดสอบ']) expect(json).not.toContain(forbidden)
  })

  it('links open the LIFF page of the same thing, and the workspace when there is none or the organization has no LIFF app (BR-NOTI-02)', () => {
    const id = randomUUID()
    const withLiff = { locale: 'th' as const, liffId: LIFF_ID, appUrl: 'https://bcs.example' }
    const withoutLiff = { ...withLiff, liffId: null }
    expect(taskLink(withLiff, id, 'approve')).toBe(`${LIFF}/tasks/${id}?action=approve`)
    expect(documentLink(withLiff, `/requests/${id}`)).toBe(`${LIFF}/requests/${id}`)
    expect(documentLink(withLiff, '/board/pending')).toBe('https://bcs.example/board/pending')
    expect(documentLink(withLiff, null)).toBe('https://bcs.example/')
    expect(taskLink(withoutLiff, id, 'approve')).toBe(`https://bcs.example/tasks/${id}`)
    expect(documentLink(withoutLiff, `/requests/${id}`)).toBe(`https://bcs.example/requests/${id}`)
  })

  it('a second run of the job sends nothing more', async () => {
    const dm = await linkTo('dm_con')
    const { notice } = await submitted()
    expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'LINE' })
    expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SKIPPED', why: 'SENT' })
    expect(pushesTo(dm).filter((m) => m.retryKey === notice.id)).toHaveLength(1)
  })
})

describe('[FR-DOA-004/AC3] the requester hears of the decision on LINE: a short text with the link back to the request (BR-NOTI-02)', () => {
  it('request.approved goes to the linked requester as text with the LIFF page of the request', async () => {
    await linkTo('dm_con')
    const requester = await linkTo('req_con')
    const { requestId, number, task } = await submitted()
    ok(await decideTask(org.ctxOf('dm_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
    const approved = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'request.approved', data: { path: ['requestId'], equals: requestId } } })
    expect(await deliverNotification(org.organizationId, approved.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'LINE' })
    const [push] = pushesTo(requester).filter((m) => m.retryKey === approved.id)
    expect(push!.messages).toEqual([{ type: 'text', text: `คำขอ ${number} อนุมัติแล้ว\n${LIFF}/requests/${requestId}` }])
  })
})

describe('[FR-LINE-006/AC1] the daily summary goes to a linked member on LINE as text, with the link to their tasks', () => {
  it('sends the summary lines of digest.daily and the LIFF page of the tasks', async () => {
    const dm = await linkTo('dm_con')
    const digest = await prisma.notification.create({
      data: {
        organizationId: org.organizationId,
        recipientMemberId: org.member.dm_con!,
        templateKey: 'digest.daily',
        urgency: 'IMMEDIATE',
        dedupeKey: `digest.daily:${randomUUID()}`,
        data: { mine: { pending: 2, overdue: 1, oldest: [{ subjectType: 'REQUEST', label: 'PR-2569-00001', ageMinutes: 90, overdue: true }] }, scope: null, updates: 0 },
      },
    })
    expect(await deliverNotification(org.organizationId, digest.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'LINE' })
    const [push] = pushesTo(dm).filter((m) => m.retryKey === digest.id)
    expect(push!.messages).toEqual([
      { type: 'text', text: ['สรุปประจำวัน: มีงานรอคุณพิจารณา 2 งาน', 'โปรดพิจารณางานที่รออนุมัติ 2 งาน (เกินกำหนด 1 งาน)', '• คำขอ PR-2569-00001 รอ 1 ชม. 30 นาที เกินกำหนด', `${LIFF}/tasks`].join('\n') },
    ])
  })
})

describe('[FR-LINE-007/AC3] LINE cannot deliver (blocked, quota used up, LINE down): the approval task reaches its recipient by e-mail within 5 minutes', () => {
  it('blocked: the unfollow event marks the member unreachable (BR-LINE-08), and their approval task goes straight to e-mail with the decision link', async () => {
    const dm = await linkTo('dm_con')
    // LINE tells BCS of a block with the unfollow event, signed as LINE signs it
    const { body } = buildLineWebhook([lineEvents.unfollow({ userId: dm, timestamp: NOW.getTime() })])
    expect(await receiveLineWebhook({ channelKey, rawBody: new TextEncoder().encode(body), signature: signLineWebhook(TEST_CHANNEL_SECRET, body) }, { now: NOW, budgetMs: 30_000, sender: null })).toMatchObject({ status: 200, inline: 1 })
    expect(await reachable('dm_con')).toBe(false)

    const before = (await messagesTo(await emailOf('dm_con'))).length
    const tries = pushTries()
    const { task, notice, emailToken } = await submitted()
    expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'EMAIL' })
    // No push is tried for a member who blocked the account
    expect(pushTries()).toBe(tries)
    const mails = await messagesTo(await emailOf('dm_con'))
    expect(mails).toHaveLength(before + 1)
    expect(mails.at(-1)!.Text).toContain(emailLinkPath(emailToken.id))
    expect(mails.at(-1)!.Text).toContain(`/tasks/${task.id}`)
  })

  it('a push LINE refuses with 403 (the fake server\'s stand-in for a blocked recipient): e-mail at once with the decision link, and the member stays reachable — a 403 may be the channel\'s own refusal', async () => {
    await linkTo('dm_con', blockedUser())
    const before = (await messagesTo(await emailOf('dm_con'))).length
    const { task, notice, emailToken } = await submitted()
    expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'EMAIL', lineFailed: 'FORBIDDEN' })
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ status: 'SENT', sentChannel: 'EMAIL', sentAt: NOW, error: 'LINE_FORBIDDEN' })
    // LINE documents 403 as a call the channel may not make: marking the member would switch LINE off for everyone
    // who gets a notice while the channel is refused
    expect(await reachable('dm_con')).toBe(true)
    const mails = await messagesTo(await emailOf('dm_con'))
    expect(mails).toHaveLength(before + 1)
    expect(mails.at(-1)!.Text).toContain(emailLinkPath(emailToken.id))
    expect(mails.at(-1)!.Text).toContain(`/tasks/${task.id}`)

    // The next notice tries LINE again (one push, refused at once) and goes by e-mail at once too
    const tries = pushTries()
    const next = await submitted()
    expect(await deliverNotification(org.organizationId, next.notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'EMAIL', lineFailed: 'FORBIDDEN' })
    expect(pushTries()).toBe(tries + 1)
    expect(await messagesTo(await emailOf('dm_con'))).toHaveLength(before + 2)
  })

  it('a refusal that names the recipient (400 on "to"): marked unreachable, e-mail at once, and LINE is not tried for them again', async () => {
    await linkTo('dm_con')
    const before = (await messagesTo(await emailOf('dm_con'))).length
    const { notice, emailToken } = await submitted()
    const outcome = await withPushAnswer(400, { message: 'The request body has 1 error(s)', details: [{ message: 'Invalid user id', property: 'to' }] }, () => deliverNotification(org.organizationId, notice.id, NOW, withLine))
    expect(outcome).toEqual({ status: 'SENT', channel: 'EMAIL', lineFailed: 'BAD_REQUEST' })
    expect(await reachable('dm_con')).toBe(false)
    const mails = await messagesTo(await emailOf('dm_con'))
    expect(mails).toHaveLength(before + 1)
    expect(mails.at(-1)!.Text).toContain(emailLinkPath(emailToken.id))

    const tries = pushTries()
    const next = await submitted()
    expect(await deliverNotification(org.organizationId, next.notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'EMAIL' })
    expect(pushTries()).toBe(tries)
  })

  it('the month\'s push quota used up (429 "You have reached your monthly limit."): e-mail at once and the member stays reachable; a rate limit is tried again instead', async () => {
    await linkTo('dm_con')
    const before = (await messagesTo(await emailOf('dm_con'))).length
    const { notice, emailToken } = await submitted()
    const outcome = await withPushAnswer(429, { message: 'You have reached your monthly limit.' }, () => deliverNotification(org.organizationId, notice.id, NOW, withLine))
    expect(outcome).toEqual({ status: 'SENT', channel: 'EMAIL', lineFailed: 'QUOTA_EXHAUSTED' })
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ status: 'SENT', sentChannel: 'EMAIL', sentAt: NOW, error: 'LINE_QUOTA_EXHAUSTED' })
    expect(await reachable('dm_con')).toBe(true)
    const mails = await messagesTo(await emailOf('dm_con'))
    expect(mails).toHaveLength(before + 1)
    expect(mails.at(-1)!.Text).toContain(emailLinkPath(emailToken.id))

    // LINE's rate limit asks to wait: the try says when to try again, and the e-mail follows by the give-up
    const next = await submitted()
    const limited = await withPushAnswer(429, { message: 'The API rate limit has been exceeded. Try again later.' }, () => deliverNotification(org.organizationId, next.notice.id, NOW, withLine))
    expect(limited).toEqual({ status: 'RETRY', channel: 'LINE', reason: 'RATE_LIMITED', tries: 1, firstTryAt: NOW.toISOString(), retryAt: new Date(NOW.getTime() + 15 * MS_PER_SECOND).toISOString() })
    expect(await messagesTo(await emailOf('dm_con'))).toHaveLength(before + 1)
  })

  it('LINE down: the job tries again with backoff and sends the e-mail 4 minutes after the first try, within 5', async () => {
    const down = await linkTo('dm_con', downUser())
    const before = (await messagesTo(await emailOf('dm_con'))).length
    const { notice, emailToken } = await submitted()
    const tries = pushTries()

    // The first try alone: LINE answers 500, nothing is claimed, the try says when to try again
    const first = await deliverNotification(org.organizationId, notice.id, NOW, withLine)
    expect(first).toEqual({ status: 'RETRY', channel: 'LINE', reason: 'SERVER_ERROR', tries: 1, firstTryAt: NOW.toISOString(), retryAt: new Date(NOW.getTime() + 15 * MS_PER_SECOND).toISOString() })
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ status: 'PENDING', sentChannel: null, error: 'LINE_SERVER_ERROR' })

    // The whole run of the job, on a fake clock that its sleeps move
    const clock = new ManualClock(NOW)
    const wakes: number[] = []
    const step: DeliveryStep = {
      run: async (_id, fn) => fn(),
      sleepUntil: async (_id, at) => {
        wakes.push(Date.parse(at) - NOW.getTime())
        clock.set(at)
      },
    }
    const outcome = await notificationDeliverRun(clock, { openChannel: openLineChannel })({ data: { organizationId: org.organizationId, notificationId: notice.id } }, step)
    expect(outcome).toEqual({ status: 'SENT', channel: 'EMAIL', lineFailed: 'SERVER_ERROR' })
    // Tries at 0, 15 s, 45 s, 1:45 and 3:45 (five 500s from LINE), then the e-mail at the give-up, 4:00
    expect(wakes).toEqual([15, 45, 105, 225, 240].map((s) => s * MS_PER_SECOND))
    expect(pushTries() - tries).toBe(1 + 5)
    expect(pushesTo(down)).toEqual([])
    const sent = await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })
    expect(sent).toMatchObject({ status: 'SENT', sentChannel: 'EMAIL', error: 'LINE_SERVER_ERROR' })
    expect(sent.sentAt!.getTime() - NOW.getTime()).toBe(LINE_DELIVERY_GIVE_UP_MS)
    expect(sent.sentAt!.getTime() - NOW.getTime()).toBeLessThanOrEqual(LINE_FALLBACK_WITHIN_MS)
    expect(LINE_FALLBACK_WITHIN_MS).toBe(5 * MS_PER_MINUTE)
    // LINE trouble says nothing about the member: they stay reachable
    expect(await reachable('dm_con')).toBe(true)
    const mails = await messagesTo(await emailOf('dm_con'))
    expect(mails).toHaveLength(before + 1)
    expect(mails.at(-1)!.Text).toContain(emailLinkPath(emailToken.id))
  })

  it('LINE back on the second try: the card goes by LINE and no e-mail is sent', async () => {
    const dm = await linkTo('dm_con')
    const before = (await messagesTo(await emailOf('dm_con'))).length
    const { notice } = await submitted()
    // The first push does not get through (no connection); the next one does
    let failures = 1
    const flaky: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/v2/bot/message/push') && failures-- > 0) throw new TypeError('fetch failed')
      return fetch(input, init)
    }
    setLineClient(createLineClient({ apiBaseUrl: line.fake.url, dataApiBaseUrl: line.fake.url, fetch: flaky }))
    try {
      const clock = new ManualClock(NOW)
      const outcome = await notificationDeliverRun(clock, { openChannel: openLineChannel })(
        { data: { organizationId: org.organizationId, notificationId: notice.id } },
        { run: async (_id, fn) => fn(), sleepUntil: async (_id, at) => clock.set(at) },
      )
      expect(outcome).toEqual({ status: 'SENT', channel: 'LINE' })
    } finally {
      setLineClient(line.client)
    }
    expect(pushesTo(dm).filter((m) => m.retryKey === notice.id)).toHaveLength(1)
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ status: 'SENT', sentChannel: 'LINE', sentAt: new Date(NOW.getTime() + 15 * MS_PER_SECOND), error: null })
    expect(await messagesTo(await emailOf('dm_con'))).toHaveLength(before)
  })

  it('LINE refusing the channel\'s access token sends the e-mail at once and leaves the member reachable', async () => {
    await linkTo('dm_con')
    const { notice } = await submitted()
    const strict = await startFakeLine({ port: 0, channelSecret: TEST_CHANNEL_SECRET, accessToken: 'another-channel-access-token-000000' })
    setLineClient(createLineClient({ apiBaseUrl: strict.url, dataApiBaseUrl: strict.url }))
    try {
      expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'EMAIL', lineFailed: 'UNAUTHORIZED' })
    } finally {
      setLineClient(line.client)
      await strict.close()
    }
    expect(await reachable('dm_con')).toBe(true)
  })
})

describe('[FR-NOTI-003/AC3] a notice about a task that closed is not sent: every try reads the task first', () => {
  it('the approver decides while LINE is down: the next try sends nothing, by LINE or by e-mail, and the notice stays in the bell', async () => {
    const down = await linkTo('dm_con', downUser())
    const before = (await messagesTo(await emailOf('dm_con'))).length
    const { task, notice } = await submitted()
    const tries = pushTries()
    const clock = new ManualClock(NOW)
    let woken = 0
    const step: DeliveryStep = {
      run: async (_id, fn) => fn(),
      sleepUntil: async (_id, at) => {
        // Between LINE's first and second try the approver decides in the workspace
        if (woken++ === 0) ok(await decideTask(org.ctxOf('dm_con', new Date(NOW.getTime() + 5 * MS_PER_SECOND)), { taskId: task.id, decision: 'APPROVE' }, key()))
        clock.set(at)
      },
    }
    const outcome = await notificationDeliverRun(clock, { openChannel: openLineChannel })({ data: { organizationId: org.organizationId, notificationId: notice.id } }, step)
    expect(outcome).toEqual({ status: 'SKIPPED', why: TASK_CLOSED })
    // One try by LINE before the decision, none after, and no e-mail at the give-up
    expect(woken).toBe(1)
    expect(pushTries() - tries).toBe(1)
    expect(pushesTo(down)).toEqual([])
    expect(await messagesTo(await emailOf('dm_con'))).toHaveLength(before)
    // In the bell still, settled as not sent
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ status: 'SENT', sentChannel: 'IN_APP', sentAt: new Date(NOW.getTime() + 15 * MS_PER_SECOND), error: TASK_CLOSED, readAt: null })
    // A later run sends nothing either
    expect(await deliverNotification(org.organizationId, notice.id, new Date(NOW.getTime() + MS_PER_MINUTE), withLine)).toEqual({ status: 'SKIPPED', why: 'SENT' })
  })

  it('the reminder, overdue and escalation notices of a task decided before they went out reach nobody — not the assignee, the co-assignee, the next band or the requester', async () => {
    const dm = await linkTo('dm_con')
    const vp = await linkTo('vp_ops')
    const requester = await linkTo('req_con')
    const mailsBefore = await Promise.all(['dm_con', 'vp_ops', 'req_con'].map(async (code) => (await messagesTo(await emailOf(code))).length))
    const { requestId, task } = await submitted()
    // The SLA jobs' own commands make the notices: the reminder, overdue (to the assignee and, for acknowledgement, the
    // next band) and the escalation (to the new co-assignee, the assignee and the requester)
    expect(await remindTaskSla(org.organizationId, task.id, task.remindAt!)).toEqual({ done: true })
    expect(await markTaskOverdue(org.organizationId, task.id, task.dueAt!)).toMatchObject({ done: true })
    expect(await escalateTask(org.organizationId, task.id, THU_0900)).toMatchObject({ done: true, outcome: 'CO_ASSIGNED' })
    const notices = await prisma.notification.findMany({ where: { subjectId: requestId, templateKey: { in: ['task.reminder', 'task.overdue', 'task.escalated'] } } })
    expect(notices.map((n) => `${n.templateKey}:${(n.data as { role?: string }).role ?? '-'}`).sort()).toEqual([
      'task.escalated:ASSIGNEE',
      'task.escalated:CO_ASSIGNEE',
      'task.escalated:REQUESTER',
      'task.overdue:ACK',
      'task.overdue:ASSIGNEE',
      'task.reminder:-',
    ])
    const assigned = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.assigned', data: { path: ['taskId'], equals: task.id } } })

    // The assignee decides first; the co-assignee's task is cancelled with the route
    ok(await decideTask(org.ctxOf('dm_con', new Date(THU_0900.getTime() + 5 * MS_PER_MINUTE)), { taskId: task.id, decision: 'APPROVE' }, key()))
    const tries = pushTries()
    for (const n of [assigned, ...notices]) {
      expect(await deliverNotification(org.organizationId, n.id, new Date(THU_0900.getTime() + 6 * MS_PER_MINUTE), withLine)).toEqual({ status: 'SKIPPED', why: TASK_CLOSED })
      expect(await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ status: 'SENT', sentChannel: 'IN_APP', error: TASK_CLOSED })
    }
    expect(pushTries()).toBe(tries)
    for (const lineUser of [dm, vp, requester]) expect(pushesTo(lineUser).filter((m) => [assigned, ...notices].some((n) => n.id === m.retryKey))).toEqual([])
    const mailsAfter = await Promise.all(['dm_con', 'vp_ops', 'req_con'].map(async (code) => (await messagesTo(await emailOf(code))).length))
    expect(mailsAfter).toEqual(mailsBefore)
    // The decision's own notice to the requester still goes
    const approved = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'request.approved', data: { path: ['requestId'], equals: requestId } } })
    expect(await deliverNotification(org.organizationId, approved.id, THU_0900, withLine)).toEqual({ status: 'SENT', channel: 'LINE' })
  })

  it('a task decided between the check and the card: nothing is pushed, and no text stands in for the card', async () => {
    const dm = await linkTo('dm_con')
    const { task, notice } = await submitted()
    const tries = pushTries()
    // The channel opens after the check: the approver decides at that very moment
    const decidingWhileOpening: OpenLineChannelForDelivery = async (organizationId) => {
      ok(await decideTask(org.ctxOf('dm_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
      return openLineChannel(organizationId)
    }
    expect(await deliverNotification(org.organizationId, notice.id, NOW, { openChannel: decidingWhileOpening })).toEqual({ status: 'SKIPPED', why: TASK_CLOSED })
    expect(pushTries()).toBe(tries)
    expect(pushesTo(dm).filter((m) => m.retryKey === notice.id)).toEqual([])
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ status: 'SENT', sentChannel: 'IN_APP', error: TASK_CLOSED })
  })

  it('a notice to the assignee of a task its recipient does not hold is not sent: it would show the task to someone else', async () => {
    const vp = await linkTo('vp_ops')
    const { requestId, number, task } = await submitted()
    expect(task.assigneeMemberId).toBe(org.member.dm_con)
    const before = (await messagesTo(await emailOf('vp_ops'))).length
    // The card of task.assigned, and the short text of task.reminder
    for (const templateKey of ['task.assigned', 'task.reminder']) {
      const stray = await prisma.notification.create({
        data: {
          organizationId: org.organizationId,
          recipientMemberId: org.member.vp_ops!,
          templateKey,
          urgency: 'IMMEDIATE',
          dedupeKey: `${templateKey}:stray:${randomUUID()}`,
          subjectType: 'REQUEST',
          subjectId: requestId,
          data: { subjectType: 'REQUEST', subjectId: requestId, label: number, taskId: task.id, dueAt: task.dueAt!.toISOString() },
        },
      })
      expect(await deliverNotification(org.organizationId, stray.id, NOW, withLine)).toEqual({ status: 'SKIPPED', why: TASK_CLOSED })
      expect(pushesTo(vp).filter((m) => m.retryKey === stray.id)).toEqual([])
    }
    expect(await messagesTo(await emailOf('vp_ops'))).toHaveLength(before)
  })

  it('a task waiting for the requester\'s answer (its SLA paused) is neither announced nor reminded, while an open one is', async () => {
    await linkTo('dm_con')
    const paused = await submitted()
    // The reminder made while it was open, before the approver asked the requester
    expect(await remindTaskSla(org.organizationId, paused.task.id, paused.task.remindAt!)).toEqual({ done: true })
    const reminder = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.reminder', data: { path: ['taskId'], equals: paused.task.id } } })
    ok(await requestInfo(org.ctxOf('dm_con', new Date(paused.task.remindAt!.getTime() + MS_PER_MINUTE)), { taskId: paused.task.id, question: 'ขอใบเสนอราคาเพิ่ม' }, key()))
    const tries = pushTries()
    for (const n of [paused.notice, reminder]) expect(await deliverNotification(org.organizationId, n.id, paused.task.remindAt!, withLine)).toEqual({ status: 'SKIPPED', why: TASK_CLOSED })
    expect(pushTries()).toBe(tries)
    const open = await submitted()
    expect(await deliverNotification(org.organizationId, open.notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'LINE' })
  })
})

describe('[FR-NOTI-002/AC1] an approval task goes by e-mail with its /a/<token> link when the recipient is not reached on LINE', () => {
  it('a member LINE does not reach, a channel switched off, and a member not linked all get the e-mail', async () => {
    const dm = await linkTo('dm_con')
    const cases: Array<{ setUp: () => Promise<unknown>; tearDown: () => Promise<unknown> }> = [
      { setUp: () => prisma.member.update({ where: { id: org.member.dm_con! }, data: { lineReachable: false } }), tearDown: () => linkTo('dm_con', dm) },
      {
        setUp: () => prisma.lineChannelConfig.updateMany({ where: { organizationId: org.organizationId }, data: { active: false } }),
        tearDown: () => prisma.lineChannelConfig.updateMany({ where: { organizationId: org.organizationId }, data: { active: true } }),
      },
      {
        setUp: () => prisma.channelIdentity.updateMany({ where: { organizationId: org.organizationId, memberId: org.member.dm_con!, unlinkedAt: null }, data: { unlinkedAt: NOW } }),
        tearDown: () => linkTo('dm_con', dm),
      },
    ]
    for (const { setUp, tearDown } of cases) {
      await setUp()
      try {
        const before = (await messagesTo(await emailOf('dm_con'))).length
        const tries = pushTries()
        const { notice, emailToken } = await submitted()
        expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'EMAIL' })
        expect(pushTries()).toBe(tries)
        const mails = await messagesTo(await emailOf('dm_con'))
        expect(mails).toHaveLength(before + 1)
        expect(mails.at(-1)!.Text).toContain(emailLinkPath(emailToken.id))
      } finally {
        await tearDown()
      }
    }
  })

  it('the co-assignee of an escalated task gets it as a card on LINE, and by e-mail with the action link when LINE does not reach them', async () => {
    const dm = await linkTo('dm_con')
    const { requestId, number, task, emailToken } = await submitted()
    await prisma.approvalTask.update({ where: { id: task.id }, data: { escalatedAt: NOW, overdueAt: NOW } })
    const escalated = (dedupe: string) =>
      prisma.notification.create({
        data: {
          organizationId: org.organizationId,
          recipientMemberId: org.member.dm_con!,
          templateKey: 'task.escalated',
          urgency: 'IMMEDIATE',
          dedupeKey: `task.escalated:${dedupe}`,
          subjectType: 'REQUEST',
          subjectId: requestId,
          data: { role: 'CO_ASSIGNEE', taskId: task.id, subjectType: 'REQUEST', subjectId: requestId, label: number },
        },
      })
    const onLine = await escalated(randomUUID())
    expect(await deliverNotification(org.organizationId, onLine.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'LINE' })
    const card = pushesTo(dm).find((m) => m.retryKey === onLine.id)!.messages[0]!
    expect(card.type).toBe('flex')
    expect(textOf(card)).toContain('ส่งต่อเพราะเลยกำหนด')
    expect(textOf(card)).toContain('เลยกำหนดแล้ว')

    await prisma.member.update({ where: { id: org.member.dm_con! }, data: { lineReachable: false } })
    try {
      const byEmail = await escalated(randomUUID())
      expect(await deliverNotification(org.organizationId, byEmail.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'EMAIL' })
      expect((await messagesTo(await emailOf('dm_con'))).at(-1)!.Text).toContain(emailLinkPath(emailToken.id))
    } finally {
      await linkTo('dm_con', dm)
    }
  })
})

describe('[FR-AUTH-005/AC3] a security notice reaches a member linked to LINE by e-mail only (§10.1)', () => {
  it('security.notice is never pushed to LINE', async () => {
    const dm = await linkTo('dm_con')
    const notice = await prisma.notification.create({
      data: { organizationId: org.organizationId, recipientMemberId: org.member.dm_con!, templateKey: 'security.notice', urgency: 'IMMEDIATE', dedupeKey: `security.notice:${randomUUID()}`, data: { kind: 'PIN_LOCKED' } },
    })
    expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'EMAIL' })
    expect(pushesTo(dm).filter((m) => m.retryKey === notice.id)).toEqual([])
  })
})

describe('[FR-AUTH-003/AC2] an administrator hears of a deactivated member\'s open tasks by e-mail, never on LINE, which would name the member (§10.1, BR-NOTI-01)', () => {
  it('admin.reassign_needed and the escalation notice to ORG_ADMIN go by e-mail to a linked administrator', async () => {
    const admin = await linkTo('admin')
    for (const [templateKey, data] of [
      ['admin.reassign_needed', { memberId: org.member.dm_it, name: 'ผู้ใช้ dm_it', openTasks: 2 }],
      ['task.escalated', { role: 'ADMIN', outcome: 'NO_NEXT_BAND', reason: 'NO_HIGHER_BAND', subjectType: 'REQUEST', subjectId: randomUUID(), label: 'PR-2569-00099' }],
    ] as const) {
      const notice = await prisma.notification.create({ data: { organizationId: org.organizationId, recipientMemberId: org.member.admin!, templateKey, urgency: 'IMMEDIATE', dedupeKey: `${templateKey}:${randomUUID()}`, data } })
      expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'EMAIL' })
    }
    expect(pushesTo(admin)).toEqual([])
  })
})
