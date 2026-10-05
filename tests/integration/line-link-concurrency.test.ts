import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as linkRoute } from '@/app/api/liff/link/route'
import type { Result } from '@/core/result'
import { getEnv } from '@/lib/env'
import { setLiffVerification } from '@/server/auth/liff'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { getDefaultOutboxSender, setDefaultOutboxSender, type OutboxSender } from '@/server/events/outbox'
import { saveLineChannelSettings } from '@/server/services/line-channel'
import { issueLineLinkCode, unlinkMyLine } from '@/server/services/line-link'
import { deactivateMember } from '@/server/services/members'
import { newLineUserId } from '../../scripts/line-simulate'
import { createOrg } from '../support/factory'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'

// S5-04 · FR-LINE-001 with real Postgres and requests at the same moment: one LINE account per member of an
// organization and one per member (AC3) hold when two links race (the Organization row lock of the link, the member row
// lock, and the partial unique indexes of ChannelIdentity behind them); a code is spent once when it is sent twice at
// once (AC1); a link and a change of the channel's provider never interleave (unit a's lockLineChannelForLinking).

const ENV = vi.hoisted(() => {
  const before = { NEXT_PUBLIC_LIFF_ID: process.env.NEXT_PUBLIC_LIFF_ID, LINE_LIFF_CHANNEL_ID: process.env.LINE_LIFF_CHANNEL_ID }
  const values = { liffId: '1650000033-CoNcUrRe', liffChannelId: '1650000033' }
  process.env.NEXT_PUBLIC_LIFF_ID = values.liffId
  process.env.LINE_LIFF_CHANNEL_ID = values.liffChannelId
  return { ...values, before }
})

const PROVIDER = '1650000031'
const NEXT_PROVIDER = '1650000039'
const CHANNEL = {
  providerId: PROVIDER,
  messagingChannelId: '1650000032',
  channelSecret: TEST_CHANNEL_SECRET,
  channelAccessToken: TEST_ACCESS_TOKEN,
  liffId: ENV.liffId,
  liffChannelId: ENV.liffChannelId,
}
const ROUNDS = 4
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

const line = withFakeLine()
let senderBefore: OutboxSender | null = null
beforeAll(() => {
  setLiffVerification({ fetch: (input, init) => fetch(String(input).replace(getEnv().LINE_API_BASE_URL, line.fake.url), init) })
  senderBefore = getDefaultOutboxSender()
  setDefaultOutboxSender(async () => {})
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

async function person(orgId: string, roles: Array<'ORG_ADMIN'> = []) {
  const email = `${randomUUID()}@test.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: 'ผู้ใช้ LINE', password: 'concurrent-password-1' })
  const member = await prisma.member.create({ data: { organizationId: orgId, email, displayNameTh: 'ผู้ใช้ LINE', status: 'ACTIVE', userId } })
  for (const role of roles) await prisma.roleAssignment.create({ data: { organizationId: orgId, memberId: member.id, role, grantedAt: new Date() } })
  return { memberId: member.id, ctx: (channel: Ctx['channel'] = 'WEB') => makeCtx({ organizationId: orgId, actor: { type: 'USER', memberId: member.id }, channel, now: new Date() }) }
}

async function lineOrg() {
  const org = await createOrg()
  const admin = await person(org.id, ['ORG_ADMIN'])
  ok(await saveLineChannelSettings(admin.ctx(), { ...CHANNEL, active: true }, key()))
  return { orgId: org.id, admin }
}

const codeOf = async (p: Awaited<ReturnType<typeof person>>) => ok(await issueLineLinkCode(p.ctx())).code

async function postLink(code: string, lineUserId: string) {
  const env = getEnv()
  const response = await linkRoute(
    new Request(`${env.APP_URL.replace(/\/+$/, '')}/api/liff/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: new URL(env.APP_URL).origin },
      body: JSON.stringify({ code, idToken: line.fake.issueIdToken({ sub: lineUserId, aud: ENV.liffChannelId }) }),
    }),
  )
  const body = (await response.json()) as { code?: string; reason?: string }
  return { status: response.status, code: body.code ?? null, reason: body.reason ?? null }
}

const byStatus = (answers: Array<{ status: number }>) => [...answers].sort((a, b) => a.status - b.status)

describe('[FR-LINE-001/AC3] one member per LINE account and one LINE account per member, whatever arrives at the same moment', () => {
  it('two members linking one LINE account at once: one is linked, the other is told the account is taken', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const org = await lineOrg()
      const [a, b] = [await person(org.orgId), await person(org.orgId)]
      const lineUserId = newLineUserId()
      const answers = await Promise.all([postLink(await codeOf(a), lineUserId), postLink(await codeOf(b), lineUserId)])
      expect(byStatus(answers)).toEqual([
        { status: 200, code: null, reason: null },
        { status: 409, code: 'INVALID_STATE_TRANSITION', reason: 'ACCOUNT_LINKED_TO_ANOTHER_MEMBER' },
      ])
      expect(await prisma.channelIdentity.count({ where: { organizationId: org.orgId, externalUserId: lineUserId, unlinkedAt: null } })).toBe(1)
    }
  })

  it('one member linking two LINE accounts at once: one is linked, the other is refused', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const org = await lineOrg()
      const member = await person(org.orgId)
      const [first, second] = [await codeOf(member), await codeOf(member)]
      const answers = await Promise.all([postLink(first, newLineUserId()), postLink(second, newLineUserId())])
      expect(byStatus(answers)).toEqual([
        { status: 200, code: null, reason: null },
        { status: 409, code: 'INVALID_STATE_TRANSITION', reason: 'MEMBER_LINKED_TO_ANOTHER_ACCOUNT' },
      ])
      expect(await prisma.channelIdentity.count({ where: { organizationId: org.orgId, memberId: member.memberId, unlinkedAt: null } })).toBe(1)
    }
  })

  it('an unlink and a deactivation of the member at once: the link ends once, with one line.unlinked', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const org = await lineOrg()
      const member = await person(org.orgId)
      expect((await postLink(await codeOf(member), newLineUserId())).status).toBe(200)
      const identity = await prisma.channelIdentity.findFirstOrThrow({ where: { memberId: member.memberId, unlinkedAt: null } })
      const [unlinked, deactivated] = await Promise.all([unlinkMyLine(member.ctx(), {}, key()), deactivateMember(org.admin.ctx(), { memberId: member.memberId, reason: 'ลาออก' }, key())])
      expect(deactivated).toMatchObject({ ok: true })
      // Whichever came second found nothing to end: NOT_LINKED, or FORBIDDEN once the member was deactivated
      if (!unlinked.ok) expect(['INVALID_STATE_TRANSITION', 'FORBIDDEN']).toContain(unlinked.error.code)
      expect(await prisma.event.count({ where: { organizationId: org.orgId, type: 'line.unlinked', aggregateId: identity.id } })).toBe(1)
      expect((await prisma.channelIdentity.findUniqueOrThrow({ where: { id: identity.id } })).unlinkedAt).toBeInstanceOf(Date)
    }
  })
})

describe('[FR-LINE-001/AC1] a code links once even when it is sent twice at the same moment', () => {
  it('from two LINE accounts at once: one link, the other TOKEN_USED', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const org = await lineOrg()
      const member = await person(org.orgId)
      const code = await codeOf(member)
      const answers = await Promise.all([postLink(code, newLineUserId()), postLink(code, newLineUserId())])
      expect(byStatus(answers)).toEqual([
        { status: 200, code: null, reason: null },
        { status: 409, code: 'TOKEN_USED', reason: null },
      ])
      expect(await prisma.channelIdentity.count({ where: { organizationId: org.orgId } })).toBe(1)
      expect(await prisma.channelLinkCode.count({ where: { organizationId: org.orgId } })).toBe(1)
    }
  })

  it('the same request twice at once (a double tap): both answered ok, linked once with one line.linked', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const org = await lineOrg()
      const member = await person(org.orgId)
      const code = await codeOf(member)
      const lineUserId = newLineUserId()
      const answers = await Promise.all([postLink(code, lineUserId), postLink(code, lineUserId)])
      expect(answers.map((a) => a.status)).toEqual([200, 200])
      expect(await prisma.channelIdentity.count({ where: { organizationId: org.orgId } })).toBe(1)
      expect(await prisma.event.count({ where: { organizationId: org.orgId, type: 'line.linked' } })).toBe(1)
    }
  })
})

describe('[FR-LINE-001/AC3] a link and a change of the channel’s provider never interleave', () => {
  it('never leaves a live link under a provider the channel no longer uses (LINE user ids differ per provider, §9.2)', async () => {
    const outcomes = new Set<string>()
    for (let round = 0; round < ROUNDS; round++) {
      const org = await lineOrg()
      const member = await person(org.orgId)
      const code = await codeOf(member)
      const { version } = await prisma.lineChannelConfig.findFirstOrThrow({ where: { organizationId: org.orgId } })
      const [linked, saved] = await Promise.all([
        postLink(code, newLineUserId()),
        saveLineChannelSettings(org.admin.ctx(), { ...CHANNEL, providerId: NEXT_PROVIDER, channelSecret: '', channelAccessToken: '', active: true, expectedVersion: version }, key()),
      ])
      expect(linked.status).toBe(200)
      const config = await prisma.lineChannelConfig.findFirstOrThrow({ where: { organizationId: org.orgId } })
      const live = await prisma.channelIdentity.findMany({ where: { organizationId: org.orgId, unlinkedAt: null } })
      expect(live).toHaveLength(1)
      expect(live[0]!.providerKey).toBe(config.providerId)
      if (saved.ok) outcomes.add('provider changed first')
      else {
        expect(saved.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'providerId', reason: 'PROVIDER_IN_USE' } })
        outcomes.add('link first')
      }
    }
    expect(outcomes.size).toBeGreaterThan(0)
  })
})
