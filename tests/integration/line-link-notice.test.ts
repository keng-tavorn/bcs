import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Result } from '@/core/result'
import { getEnv } from '@/lib/env'
import { setLiffVerification } from '@/server/auth/liff'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { getDefaultOutboxSender, setDefaultOutboxSender, type OutboxMessage, type OutboxSender } from '@/server/events/outbox'
import { deliverNotification } from '@/server/notifications/deliver'
import { renderNotification } from '@/server/notifications/templates'
import { openLineChannel, saveLineChannelSettings } from '@/server/services/line-channel'
import { issueLineLinkCode, linkLineAccount, unlinkMyLine } from '@/server/services/line-link'
import { newLineUserId } from '../../scripts/line-simulate'
import { createOrg } from '../support/factory'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'
import { messagesTo } from '../support/mailpit'

// ADR-049 item 10 · FR-LINE-001 AC1: linking a LINE account tells the account owner at once. Command line.link writes,
// in its own transaction, one security.notice of kind LINE_LINKED to the member — e-mail only, like every security notice
// (§10.1), with the page to undo it (/settings/line) — so a QR or link someone else opened is noticed. The notice names
// nothing of the LINE account: no LINE user id anywhere in it (NFR-SEC-09). A refused link writes none, a repeated
// request writes none again, and every new link writes its own.

const ENV = vi.hoisted(() => {
  const before = { NEXT_PUBLIC_LIFF_ID: process.env.NEXT_PUBLIC_LIFF_ID, LINE_LIFF_CHANNEL_ID: process.env.LINE_LIFF_CHANNEL_ID }
  const values = { liffId: '1650000023-NoTiCeAp', liffChannelId: '1650000023' }
  process.env.NEXT_PUBLIC_LIFF_ID = values.liffId
  process.env.LINE_LIFF_CHANNEL_ID = values.liffChannelId
  return { ...values, before }
})

const PROVIDER = '1650000021'
const CHANNEL = {
  providerId: PROVIDER,
  messagingChannelId: '1650000022',
  channelSecret: TEST_CHANNEL_SECRET,
  channelAccessToken: TEST_ACCESS_TOKEN,
  liffId: ENV.liffId,
  liffChannelId: ENV.liffChannelId,
  active: true,
}
/** What the owner is told to do: unlink on their own page (บัญชี LINE), then a new password through its ลืมรหัสผ่าน link */
const NOTICE_BODY_TH = 'ถ้าไม่ใช่คุณ ให้ยกเลิกการผูกที่หน้าบัญชี LINE แล้วกดลิงก์ ลืมรหัสผ่าน ในหน้าเดียวกันเพื่อตั้งรหัสผ่านใหม่ทันที ซึ่งจะออกจากระบบทุกอุปกรณ์'
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const line = withFakeLine()
const toInngest: OutboxMessage[] = []
let senderBefore: OutboxSender | null = null

beforeAll(() => {
  // LINE's verify endpoint is the fake's (as tests/integration/line-link.test.ts)
  setLiffVerification({ fetch: async (input, init) => fetch(String(input).replace(getEnv().LINE_API_BASE_URL, line.fake.url), init) })
  senderBefore = getDefaultOutboxSender()
  setDefaultOutboxSender(async (messages) => {
    toInngest.push(...messages)
  })
})
afterAll(() => {
  setLiffVerification(null)
  setDefaultOutboxSender(senderBefore)
  for (const [name, value] of Object.entries(ENV.before)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function ok<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.data
}

/** An organization whose ORG_ADMIN saved its LINE channel, and a member who signs in with a password */
async function scene() {
  const org = await createOrg()
  const person = async (name: string) => {
    const email = `${randomUUID()}@test.bcs.local`
    const userId = await upsertUserWithPassword({ email, name, password: 'line-notice-password-1' })
    const member = await prisma.member.create({ data: { organizationId: org.id, email, displayNameTh: name, status: 'ACTIVE', userId } })
    return { memberId: member.id, email, ctx: (): Ctx => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: member.id }, channel: 'WEB', now: new Date() }) }
  }
  const admin = await person('ผู้ดูแล LINE')
  await prisma.roleAssignment.create({ data: { organizationId: org.id, memberId: admin.memberId, role: 'ORG_ADMIN', grantedAt: new Date() } })
  ok(await saveLineChannelSettings(admin.ctx(), CHANNEL, key()))
  return { orgId: org.id, person }
}

const idTokenFor = (lineUserId: string) => line.fake.issueIdToken({ sub: lineUserId, aud: ENV.liffChannelId })
const noticesOf = (orgId: string, memberId?: string) =>
  prisma.notification.findMany({ where: { organizationId: orgId, templateKey: 'security.notice', ...(memberId ? { recipientMemberId: memberId } : {}) }, orderBy: { createdAt: 'asc' } })

describe('[FR-LINE-001/AC1] a new LINE link tells the account owner at once (ADR-049 item 10)', () => {
  it('writes exactly one security notice LINE_LINKED to the member with the link, naming nothing of the LINE account', async () => {
    const { orgId, person } = await scene()
    const member = await person('สมาชิกผูก LINE')
    const lineUserId = newLineUserId()
    const { code } = ok(await issueLineLinkCode(member.ctx()))
    const request = { code, idToken: idTokenFor(lineUserId) }
    expect(await linkLineAccount(request)).toEqual({ ok: true, data: { linked: true } })

    const identity = await prisma.channelIdentity.findFirstOrThrow({ where: { organizationId: orgId, memberId: member.memberId, unlinkedAt: null } })
    const notices = await noticesOf(orgId)
    expect(notices).toEqual([
      expect.objectContaining({
        recipientMemberId: member.memberId,
        templateKey: 'security.notice',
        data: { kind: 'LINE_LINKED' },
        urgency: 'IMMEDIATE',
        status: 'PENDING',
        dedupeKey: `security.notice:line_linked:${identity.id}`,
        subjectType: 'Member',
        subjectId: member.memberId,
      }),
    ])
    // NFR-SEC-09: neither the LINE user id nor the code nor the token is in the notice or its outbox message
    const written = JSON.stringify(notices)
    for (const secret of [lineUserId, code, request.idToken]) expect(written).not.toContain(secret)
    // Written by the link command itself: its event and the notice's delivery request leave together through the outbox
    const outbox = await prisma.outbox.findMany({ where: { organizationId: orgId, eventName: { in: ['bcs/line.linked', 'bcs/notification.requested'] } } })
    expect(outbox.map((o) => o.eventName).sort()).toEqual(['bcs/line.linked', 'bcs/notification.requested'])
    expect(outbox.find((o) => o.eventName === 'bcs/notification.requested')!.payload).toEqual({ notificationId: notices[0]!.id, organizationId: orgId })
    expect(JSON.stringify(outbox)).not.toContain(lineUserId)

    // The words the owner reads, in both languages, and the page that undoes it
    expect(renderNotification(notices[0]!, 'th')).toEqual({
      title: 'มีการผูกบัญชี LINE กับบัญชี BCS ของคุณ',
      body: NOTICE_BODY_TH,
      href: '/settings/line',
    })
    expect(renderNotification(notices[0]!, 'en')).toEqual({
      title: 'A LINE account was linked to your BCS account',
      body: 'If this was not you, unlink it on your LINE account page, then use the Forgot password link on that page to set a new password at once, which signs you out everywhere',
      href: '/settings/line',
    })

    // The same request again (a double tap) links once and tells once
    expect(await linkLineAccount(request)).toEqual({ ok: true, data: { linked: true } })
    expect(await noticesOf(orgId)).toHaveLength(1)
  })

  it('goes by e-mail only, even though LINE now reaches the member (§10.1 security.notice)', async () => {
    const { orgId, person } = await scene()
    const member = await person('สมาชิกรับอีเมลแจ้ง')
    const lineUserId = newLineUserId()
    const { code } = ok(await issueLineLinkCode(member.ctx()))
    ok(await linkLineAccount({ code, idToken: idTokenFor(lineUserId) }))
    const [notice] = await noticesOf(orgId, member.memberId)
    const pushesBefore = line.fake.messages().filter((m) => m.kind === 'push' && m.to === lineUserId).length

    expect(await deliverNotification(orgId, notice!.id, new Date(), { openChannel: openLineChannel })).toEqual({ status: 'SENT', channel: 'EMAIL' })
    // Only the welcome message of the link went to LINE; the notice did not
    expect(line.fake.messages().filter((m) => m.kind === 'push' && m.to === lineUserId)).toHaveLength(pushesBefore)
    const mails = await messagesTo(member.email)
    const mail = mails.find((m) => m.Subject === 'มีการผูกบัญชี LINE กับบัญชี BCS ของคุณ')
    expect(mail).toBeDefined()
    expect(mail!.Text).toContain(NOTICE_BODY_TH)
    expect(mail!.Text).toContain(`${getEnv().APP_URL.replace(/\/+$/, '')}/settings/line`)
    expect(`${mail!.Text}${mail!.HTML}`).not.toContain(lineUserId)
  })

  it('writes none for a refused link, and one more for every new link after an unlink', async () => {
    const { orgId, person } = await scene()
    const [first, second] = [await person('สมาชิกคนแรก'), await person('สมาชิกคนที่สอง')]
    const lineUserId = newLineUserId()
    ok(await linkLineAccount({ code: ok(await issueLineLinkCode(first.ctx())).code, idToken: idTokenFor(lineUserId) }))
    // The same LINE account for another member of the organization is refused (FR-LINE-001 AC3): nobody is told of a link
    expect(await linkLineAccount({ code: ok(await issueLineLinkCode(second.ctx())).code, idToken: idTokenFor(lineUserId) })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'ACCOUNT_LINKED_TO_ANOTHER_MEMBER' } },
    })
    expect(await noticesOf(orgId, second.memberId)).toEqual([])

    // Unlinked and linked again: a second link, a second notice (one per link)
    ok(await unlinkMyLine(first.ctx(), {}, key()))
    ok(await linkLineAccount({ code: ok(await issueLineLinkCode(first.ctx())).code, idToken: idTokenFor(newLineUserId()) }))
    const notices = await noticesOf(orgId, first.memberId)
    expect(notices).toHaveLength(2)
    expect(new Set(notices.map((n) => n.dedupeKey)).size).toBe(2)
    expect(notices.every((n) => JSON.stringify(n.data) === JSON.stringify({ kind: 'LINE_LINKED' }))).toBe(true)
    // Unlinking itself is not a link: no notice of its own
    expect(await prisma.notification.count({ where: { organizationId: orgId, recipientMemberId: first.memberId } })).toBe(2)
  })
})
