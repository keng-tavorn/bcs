import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getEnv } from '@/lib/env'
import { STORED_ROLES } from '@/server/authz/permissions'
import { makeCtx, systemCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { LINE_CHANNEL_KEY_PATTERN } from '@/server/queries/line-channel'
import {
  describeLineSeed,
  getLineChannelSettings,
  lockLineChannelForLinking,
  saveLineChannelSettings,
  seedLineChannel,
  type LineSeedEnv,
} from '@/server/services/line-channel'
import { openLineSecret } from '@/server/services/line-channel/secrets'
import { createMember, createOrg } from '../support/factory'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET } from '../support/fake-line'

// S5-01 · FR-ADM-006 AC2: an ORG_ADMIN enters the organization's LINE channel; the channel secret and the access token
// are sealed with AES-256-GCM before they are stored, shown masked afterwards, and never written into an event, the
// command log or the outbox. Every other role is refused. The demo seed creates the channel from the LINE_* values of
// .env through the same command.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const OTHER_TOKEN = 'test-only-other-channel-access-token-1111111111'

const VALID = {
  providerId: '1650000001',
  messagingChannelId: '1650000002',
  channelSecret: TEST_CHANNEL_SECRET,
  channelAccessToken: TEST_ACCESS_TOKEN,
  liffId: '1650000003-AbCdEfGh',
  liffChannelId: '1650000003',
  active: true,
}

async function orgWithAdmin() {
  const org = await createOrg()
  const admin = await createMember(org.id, 'ผู้ดูแล')
  await prisma.roleAssignment.create({ data: { organizationId: org.id, memberId: admin.id, role: 'ORG_ADMIN', grantedAt: NOW } })
  const ctxOf = (memberId: string): Ctx => makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId }, channel: 'WEB', now: NOW })
  return { orgId: org.id, adminId: admin.id, admin: ctxOf(admin.id), ctxOf }
}

const stored = (orgId: string) => prisma.lineChannelConfig.findUnique({ where: { organizationId: orgId } })
const lineEvents = async (orgId: string) =>
  (await prisma.event.findMany({ where: { organizationId: orgId, type: 'organization.settings_updated' }, orderBy: { seq: 'asc' } })).map((e) => ({
    data: e.data,
    actor: e.actorMemberId,
    channel: e.channel,
  }))

/** Resolves once another connection of this database waits for a row lock (the save blocked behind the link) */
async function waitUntilSomeoneWaitsForALock(timeoutMs = 2_500): Promise<void> {
  const until = performance.now() + timeoutMs
  while (performance.now() < until) {
    const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if ((row?.waiting ?? 0) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('the provider change never waited for the lock the link holds')
}

/** Every place a value of a command can end up in the database, as text */
async function everythingWritten(orgId: string): Promise<string> {
  const [events, commands, outbox, config] = await Promise.all([
    prisma.event.findMany({ where: { organizationId: orgId } }),
    prisma.commandLog.findMany({ where: { organizationId: orgId } }),
    prisma.outbox.findMany({ where: { organizationId: orgId } }),
    prisma.lineChannelConfig.findMany({ where: { organizationId: orgId } }),
  ])
  return JSON.stringify([events, commands, outbox, config], (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
}

describe('[FR-ADM-006/AC2] an ORG_ADMIN saves the LINE channel; the secret and the token are sealed', () => {
  it('stores them sealed (AES-256-GCM, bound to the organization), makes the channel key once and records only field names', async () => {
    const { orgId, adminId, admin } = await orgWithAdmin()
    const saved = await saveLineChannelSettings(admin, VALID, key())
    expect(saved).toMatchObject({ ok: true, data: { created: true, version: 0 } })
    if (!saved.ok) throw new Error('refused')
    expect(saved.data.channelKey).toMatch(LINE_CHANNEL_KEY_PATTERN)
    expect(saved.data.changed).toEqual(['providerId', 'messagingChannelId', 'channelSecret', 'channelAccessToken', 'liffId', 'liffChannelId', 'active'])

    const row = (await stored(orgId))!
    expect(row).toMatchObject({ providerId: VALID.providerId, messagingChannelId: VALID.messagingChannelId, liffId: VALID.liffId, liffChannelId: VALID.liffChannelId, active: true })
    for (const [field, plain] of [['channelSecret', TEST_CHANNEL_SECRET], ['channelAccessToken', TEST_ACCESS_TOKEN]] as const) {
      const sealed = field === 'channelSecret' ? row.channelSecretEnc : row.channelAccessTokenEnc
      expect(sealed).toMatch(/^v1\.[0-9a-f]{8}\./)
      expect(sealed).not.toContain(plain)
      expect(openLineSecret(orgId, field, sealed)).toBe(plain)
    }

    expect(await lineEvents(orgId)).toEqual([{ data: { section: 'lineChannel', created: true, changed: saved.data.changed }, actor: adminId, channel: 'WEB' }])
    const written = await everythingWritten(orgId)
    // The sealed values are in LineChannelConfig; the plaintext is nowhere: not in the event, the command log or the outbox
    expect(written).not.toContain(TEST_CHANNEL_SECRET)
    expect(written).not.toContain(TEST_ACCESS_TOKEN)
  })

  it('shows the secret and the token masked (the last 4 characters) with the webhook URL to give LINE', async () => {
    const { admin } = await orgWithAdmin()
    expect(await getLineChannelSettings(admin)).toMatchObject({ ok: true, data: { configured: false, channelSecret: { set: false }, channelAccessToken: { set: false }, webhookUrl: null } })
    const saved = await saveLineChannelSettings(admin, VALID, key())
    if (!saved.ok) throw new Error('refused')
    const view = await getLineChannelSettings(admin)
    expect(view).toEqual({
      ok: true,
      data: {
        configured: true,
        channelKey: saved.data.channelKey,
        webhookUrl: `${getEnv().APP_URL.replace(/\/+$/, '')}/api/webhooks/line/${saved.data.channelKey}`,
        providerId: VALID.providerId,
        messagingChannelId: VALID.messagingChannelId,
        channelSecret: { set: true, readable: true, masked: `••••${TEST_CHANNEL_SECRET.slice(-4)}` },
        channelAccessToken: { set: true, readable: true, masked: `••••${TEST_ACCESS_TOKEN.slice(-4)}` },
        liffId: VALID.liffId,
        liffChannelId: VALID.liffChannelId,
        richMenuLinkedId: null,
        richMenuUnlinkedId: null,
        active: true,
        version: 0,
        updatedAt: expect.any(String),
      },
    })
    expect(JSON.stringify(view)).not.toContain(TEST_CHANNEL_SECRET.slice(0, 28))
    expect(JSON.stringify(view)).not.toContain(TEST_ACCESS_TOKEN.slice(0, 40))
  })

  it('keeps a secret left empty, records only what changed, keeps the channel key, and refuses a save that changes nothing', async () => {
    const { orgId, admin } = await orgWithAdmin()
    const first = await saveLineChannelSettings(admin, VALID, key())
    if (!first.ok) throw new Error('refused')

    const keep = { ...VALID, channelSecret: '', channelAccessToken: undefined, expectedVersion: 0 }
    expect(await saveLineChannelSettings(admin, keep, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NO_CHANGE' } } })
    // Typing the same secret again is not a change either
    expect(await saveLineChannelSettings(admin, { ...VALID, expectedVersion: 0 }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NO_CHANGE' } } })

    const newToken = await saveLineChannelSettings(admin, { ...keep, channelAccessToken: OTHER_TOKEN }, key())
    expect(newToken).toMatchObject({ ok: true, data: { created: false, version: 1, channelKey: first.data.channelKey, changed: ['channelAccessToken'] } })
    const row = (await stored(orgId))!
    expect(openLineSecret(orgId, 'channelSecret', row.channelSecretEnc)).toBe(TEST_CHANNEL_SECRET)
    expect(openLineSecret(orgId, 'channelAccessToken', row.channelAccessTokenEnc)).toBe(OTHER_TOKEN)

    // LIFF fields: left out keeps, empty clears
    const noLiffChange = await saveLineChannelSettings(admin, { providerId: VALID.providerId, messagingChannelId: VALID.messagingChannelId, active: false, expectedVersion: 1 }, key())
    expect(noLiffChange).toMatchObject({ ok: true, data: { changed: ['active'] } })
    expect(await stored(orgId)).toMatchObject({ liffId: VALID.liffId, active: false })
    const cleared = await saveLineChannelSettings(admin, { ...keep, liffId: '', liffChannelId: null, active: false, expectedVersion: 2 }, key())
    expect(cleared).toMatchObject({ ok: true, data: { changed: ['liffId', 'liffChannelId'], version: 3 } })
    expect(await stored(orgId)).toMatchObject({ liffId: null, liffChannelId: null, channelKey: first.data.channelKey })

    expect((await lineEvents(orgId)).map((e) => e.data)).toEqual([
      { section: 'lineChannel', created: true, changed: first.data.changed },
      { section: 'lineChannel', created: false, changed: ['channelAccessToken'] },
      { section: 'lineChannel', created: false, changed: ['active'] },
      { section: 'lineChannel', created: false, changed: ['liffId', 'liffChannelId'] },
    ])
    const written = await everythingWritten(orgId)
    expect(written).not.toContain(OTHER_TOKEN)
  })

  it('refuses a save over someone else save (CONFLICT_VERSION)', async () => {
    const { orgId, admin } = await orgWithAdmin()
    await saveLineChannelSettings(admin, VALID, key())
    expect(await saveLineChannelSettings(admin, { ...VALID, active: false, expectedVersion: 0 }, key())).toMatchObject({ ok: true })
    expect(await saveLineChannelSettings(admin, { ...VALID, providerId: '1650000009', expectedVersion: 0 }, key())).toMatchObject({ ok: false, error: { code: 'CONFLICT_VERSION', details: { current: 1 } } })
    expect(await stored(orgId)).toMatchObject({ providerId: VALID.providerId, version: 1 })
  })

  it('checks the version on every save (INV-PLT-02): none once a channel is saved, or one before it is, is CONFLICT_VERSION', async () => {
    const { orgId, admin } = await orgWithAdmin()
    // A first save with a version: the screen showed a channel that is not there
    expect(await saveLineChannelSettings(admin, { ...VALID, expectedVersion: 0 }, key())).toMatchObject({ ok: false, error: { code: 'CONFLICT_VERSION', details: { current: null } } })
    // The screen showed no saved channel: null (the DTO's version) or nothing
    expect(await saveLineChannelSettings(admin, { ...VALID, expectedVersion: null }, key())).toMatchObject({ ok: true, data: { created: true, version: 0 } })
    // Someone saved first while this screen still showed "not configured": its save without a version is refused
    for (const expectedVersion of [undefined, null]) {
      expect(await saveLineChannelSettings(admin, { ...VALID, active: false, expectedVersion }, key()), String(expectedVersion)).toMatchObject({
        ok: false,
        error: { code: 'CONFLICT_VERSION', details: { current: 0 } },
      })
    }
    expect(await stored(orgId)).toMatchObject({ active: true, version: 0 })
    expect(await lineEvents(orgId)).toHaveLength(1)
  })

  it('refuses values in the wrong format, naming the field and never the value, and a first save without the secrets', async () => {
    const { orgId, admin } = await orgWithAdmin()
    const cases: Array<[string, Record<string, unknown>]> = [
      ['channelSecret', { channelSecret: 'not-a-hex-secret-0123456789abcdef' }],
      ['channelAccessToken', { channelAccessToken: 'has spaces in the token value' }],
      ['liffId', { liffId: 'liff-without-channel' }],
      ['messagingChannelId', { messagingChannelId: 'channel-abc' }],
      ['providerId', { providerId: 'provider with spaces' }],
    ]
    for (const [field, change] of cases) {
      const result = await saveLineChannelSettings(admin, { ...VALID, ...change } as typeof VALID, key())
      expect(result, field).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field } } })
      expect(JSON.stringify(result)).not.toContain(String(Object.values(change)[0]))
    }
    expect(await saveLineChannelSettings(admin, { ...VALID, channelSecret: '' }, key())).toMatchObject({ ok: false, error: { details: { field: 'channelSecret', reason: 'REQUIRED' } } })
    expect(await saveLineChannelSettings(admin, { ...VALID, channelAccessToken: undefined }, key())).toMatchObject({ ok: false, error: { details: { field: 'channelAccessToken', reason: 'REQUIRED' } } })
    expect(await saveLineChannelSettings(admin, { ...VALID, channelKey: 'mine' } as typeof VALID, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await stored(orgId)).toBeNull()
    expect(await lineEvents(orgId)).toEqual([])
  })

  it('keeps the provider while members are linked: LINE user ids differ per provider (§9.2)', async () => {
    const { orgId, admin } = await orgWithAdmin()
    await saveLineChannelSettings(admin, VALID, key())
    const member = await createMember(orgId, 'ผู้ผูก LINE')
    const identity = await prisma.channelIdentity.create({
      data: { organizationId: orgId, memberId: member.id, channel: 'LINE', providerKey: VALID.providerId, externalUserId: `U${randomUUID().replace(/-/g, '')}`, linkedAt: NOW },
    })
    expect(await saveLineChannelSettings(admin, { ...VALID, providerId: '1650000099', expectedVersion: 0 }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'providerId', reason: 'PROVIDER_IN_USE', linked: 1 } },
    })
    await prisma.channelIdentity.update({ where: { id: identity.id }, data: { unlinkedAt: NOW } })
    expect(await saveLineChannelSettings(admin, { ...VALID, providerId: '1650000099', expectedVersion: 0 }, key())).toMatchObject({ ok: true, data: { changed: ['providerId'] } })
  })

  it('a link that holds the channel lock (lockLineChannelForLinking) makes a provider change wait, which then counts the new link', async () => {
    const { orgId, admin } = await orgWithAdmin()
    await saveLineChannelSettings(admin, VALID, key())
    const member = await createMember(orgId, 'ผู้ผูก LINE')
    let change: ReturnType<typeof saveLineChannelSettings> | undefined
    await forTenant(orgId).$transaction(
      async (tx) => {
        // The link command (S5-04): lock, read the provider, write the identity under it
        const channel = await lockLineChannelForLinking(tx, orgId)
        expect(channel).toEqual({ providerId: VALID.providerId, active: true })
        change = saveLineChannelSettings(admin, { ...VALID, providerId: '1650000099', expectedVersion: 0 }, key())
        await waitUntilSomeoneWaitsForALock()
        await tx.channelIdentity.create({
          data: { organizationId: orgId, memberId: member.id, channel: 'LINE', providerKey: channel!.providerId, externalUserId: `U${randomUUID().replace(/-/g, '')}`, linkedAt: NOW },
        })
      },
      { timeout: 10_000 },
    )
    // Without the shared lock the change could have counted no identity and moved the provider under the new link
    expect(await change).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'providerId', reason: 'PROVIDER_IN_USE', linked: 1 } } })
    expect(await stored(orgId)).toMatchObject({ providerId: VALID.providerId, version: 0 })
    // An organization without a channel: nothing to link to
    const bare = await orgWithAdmin()
    expect(await forTenant(bare.orgId).$transaction((tx) => lockLineChannelForLinking(tx, bare.orgId))).toBeNull()
  })

  it('a sealed value copied from another organization does not open there', async () => {
    const a = await orgWithAdmin()
    const b = await orgWithAdmin()
    await saveLineChannelSettings(a.admin, VALID, key())
    await saveLineChannelSettings(b.admin, { ...VALID, channelAccessToken: OTHER_TOKEN }, key())
    const fromA = (await stored(a.orgId))!
    await prisma.lineChannelConfig.update({ where: { organizationId: b.orgId }, data: { channelAccessTokenEnc: fromA.channelAccessTokenEnc } })
    expect(await getLineChannelSettings(b.admin)).toMatchObject({ ok: true, data: { channelAccessToken: { set: true, readable: false, masked: null }, channelSecret: { readable: true } } })
  })
})

describe('[FR-ADM-006/AC2] only an ORG_ADMIN of the organization may read or save its LINE channel (BR-AUTH-05)', () => {
  it('refuses every other role, a deactivated admin, an admin of another organization, the BCS team and the system', async () => {
    const { orgId, admin, ctxOf } = await orgWithAdmin()
    await saveLineChannelSettings(admin, VALID, key())
    const outboxBefore = await prisma.outbox.count({ where: { organizationId: orgId } })

    const actors: Array<[string, Ctx]> = []
    for (const role of STORED_ROLES.filter((r) => r !== 'ORG_ADMIN')) {
      const member = await createMember(orgId, role)
      await prisma.roleAssignment.create({ data: { organizationId: orgId, memberId: member.id, role, grantedAt: NOW } })
      actors.push([role, ctxOf(member.id)])
    }
    actors.push(['REQUESTER', ctxOf((await createMember(orgId, 'ผู้ขอ')).id)])
    const deactivated = await createMember(orgId, 'ผู้ดูแลที่ปิดใช้งาน')
    await prisma.roleAssignment.create({ data: { organizationId: orgId, memberId: deactivated.id, role: 'ORG_ADMIN', grantedAt: NOW } })
    await prisma.member.update({ where: { id: deactivated.id }, data: { status: 'DEACTIVATED' } })
    actors.push(['deactivated ORG_ADMIN', ctxOf(deactivated.id)])
    const other = await orgWithAdmin()
    actors.push(['ORG_ADMIN of another organization', makeCtx({ organizationId: orgId, actor: { type: 'USER', memberId: other.adminId }, channel: 'WEB', now: NOW })])
    actors.push(['PLATFORM_ADMIN', makeCtx({ organizationId: orgId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: randomUUID() }, channel: 'WEB', now: NOW })])
    actors.push(['SYSTEM', systemCtx(orgId, NOW, 'line-test')])

    for (const [who, ctx] of actors) {
      expect(await saveLineChannelSettings(ctx, { ...VALID, active: false, channelAccessToken: OTHER_TOKEN }, key()), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await getLineChannelSettings(ctx), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await stored(orgId)).toMatchObject({ active: true, version: 0 })
    expect(openLineSecret(orgId, 'channelAccessToken', (await stored(orgId))!.channelAccessTokenEnc)).toBe(TEST_ACCESS_TOKEN)
    // The refused saves wrote nothing: no event, no command log, no outbox row
    expect(await lineEvents(orgId)).toHaveLength(1)
    expect(await prisma.commandLog.count({ where: { organizationId: orgId } })).toBe(1)
    expect(await prisma.outbox.count({ where: { organizationId: orgId } })).toBe(outboxBefore)
  })
})

describe('[FR-ADM-006/AC2] the demo seed creates the channel from the LINE_* values of .env through the same command', () => {
  const envOf = (over: Partial<LineSeedEnv> = {}): LineSeedEnv => ({
    APP_ENV: 'local',
    LINE_PROVIDER_ID: VALID.providerId,
    LINE_MESSAGING_CHANNEL_ID: VALID.messagingChannelId,
    LINE_MESSAGING_CHANNEL_SECRET: TEST_CHANNEL_SECRET,
    LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: TEST_ACCESS_TOKEN,
    LINE_LIFF_CHANNEL_ID: VALID.liffChannelId,
    NEXT_PUBLIC_LIFF_ID: VALID.liffId,
    ...over,
  })

  it('creates it once, sealed, as the organization admin on channel SYSTEM, and leaves it alone afterwards', async () => {
    const { orgId, adminId } = await orgWithAdmin()
    const created = await seedLineChannel(orgId, envOf(), NOW)
    expect(created).toMatchObject({ status: 'CREATED' })
    expect(describeLineSeed(created)).not.toContain(TEST_CHANNEL_SECRET)
    const row = (await stored(orgId))!
    expect(row).toMatchObject({ providerId: VALID.providerId, liffId: VALID.liffId, liffChannelId: VALID.liffChannelId, active: true })
    expect(openLineSecret(orgId, 'channelSecret', row.channelSecretEnc)).toBe(TEST_CHANNEL_SECRET)
    expect(await lineEvents(orgId)).toEqual([{ data: { section: 'lineChannel', created: true, changed: expect.any(Array) }, actor: adminId, channel: 'SYSTEM' }])
    // The seed writes nothing for Inngest to send
    expect(await prisma.outbox.count({ where: { organizationId: orgId, suppressed: false } })).toBe(0)

    expect(await seedLineChannel(orgId, envOf({ LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: OTHER_TOKEN }), NOW)).toEqual({ status: 'EXISTS' })
    expect(openLineSecret(orgId, 'channelAccessToken', (await stored(orgId))!.channelAccessTokenEnc)).toBe(TEST_ACCESS_TOKEN)
    expect(await lineEvents(orgId)).toHaveLength(1)
  })

  it('does nothing without the values, names the missing or malformed variable, and runs in local and staging only', async () => {
    const { orgId } = await orgWithAdmin()
    const none = { LINE_PROVIDER_ID: undefined, LINE_MESSAGING_CHANNEL_ID: undefined, LINE_MESSAGING_CHANNEL_SECRET: undefined, LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: undefined }
    expect(await seedLineChannel(orgId, envOf(none), NOW)).toEqual({ status: 'NOT_SET' })
    expect(await seedLineChannel(orgId, envOf({ LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: undefined }), NOW)).toEqual({ status: 'INCOMPLETE', missing: ['LINE_MESSAGING_CHANNEL_ACCESS_TOKEN'] })
    const refused = await seedLineChannel(orgId, envOf({ LINE_MESSAGING_CHANNEL_SECRET: 'not-hex-0000000000000000000000000' }), NOW)
    expect(refused).toEqual({ status: 'REFUSED', code: 'VALIDATION_FAILED', variable: 'LINE_MESSAGING_CHANNEL_SECRET' })
    expect(describeLineSeed(refused)).toContain('LINE_MESSAGING_CHANNEL_SECRET')
    expect(describeLineSeed(refused)).not.toContain('not-hex')
    expect(await stored(orgId)).toBeNull()
    await expect(seedLineChannel(orgId, envOf({ APP_ENV: 'production' }), NOW)).rejects.toThrow(/local and staging/)

    const lonely = await createOrg()
    expect(await seedLineChannel(lonely.id, envOf(), NOW)).toEqual({ status: 'NO_ADMIN' })
  })
})
