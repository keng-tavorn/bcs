import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { maxDuration, POST } from '@/app/api/webhooks/line/[channelKey]/route'
import { MS_PER_HOUR, MS_PER_SECOND } from '@/lib/constants'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { getDefaultOutboxSender, setDefaultOutboxSender, type OutboxMessage, type OutboxSender } from '@/server/events/outbox'
import { lineWebhookRun, processQueuedLineWebhookEvents, receiveLineWebhook, type LineWebhookJobStep } from '@/server/jobs/line-webhook'
import {
  LINE_WEBHOOK_ANSWER_WITHIN_MS,
  LINE_WEBHOOK_INLINE_BUDGET_MS,
  LINE_WEBHOOK_JOB_ROUNDS,
  LINE_WEBHOOK_QUEUE_EVENT,
  LINE_WEBHOOK_QUEUED_GIVE_UP_MS,
  LINE_WEBHOOK_REQUEST_ENDED_MS,
  LINE_WEBHOOK_ROUND_DELAY_MS,
  LINE_WEBHOOK_ROUTE_MAX_DURATION_MS,
  linePostbackActions,
  receiveLineWebhook as receiveWith,
  registerLinePostbackHandler,
  settleFailedLineWebhookRun,
  sweepLineWebhookEvents,
  type LinePostbackContext,
  type LinePostbackRequest,
  type LineWebhookQueuePayload,
} from '@/server/line/webhook'
import { openLineChannel, saveLineChannelSettings } from '@/server/services/line-channel'
import { buildLineWebhook, lineEvents, newLineUserId, redelivered, signLineWebhook, type LineWebhookEventJson } from '../../scripts/line-simulate'
import { createMember, createOrg } from '../support/factory'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'

// S5-02 · FR-LINE-005: POST /api/webhooks/line/<channelKey> with webhooks built and signed by pnpm line:simulate
// (scripts/line-simulate.ts). AC1: a wrong or missing x-line-signature is 401 and nothing is recorded or processed.
// AC2: an event delivered again (same webhookEventId, or isRedelivery) is not processed again — unless its request
// dropped it. AC3: the answer is 200 within 2 seconds even while processing is slow — what does not fit the inline
// budget goes to the line-webhook job, and nothing recorded is left behind (the job's further runs and the sweep).
// Also: follow and unfollow (BR-LINE-08, BR-LINE-07) and the postback dispatcher (BR-TOK-02). LINE itself is the fake
// LINE server of the repo; replies are read back from it.

const OTHER_SECRET = 'fedcba9876543210fedcba9876543210'
const PROVIDER = '1650000001'
const LIFF_ID = '1650000003-AbCdEfGh'
const CHANNEL = {
  providerId: PROVIDER,
  messagingChannelId: '1650000002',
  channelSecret: TEST_CHANNEL_SECRET,
  channelAccessToken: TEST_ACCESS_TOKEN,
  liffId: LIFF_ID,
  liffChannelId: '1650000003',
}

const line = withFakeLine()

/** What the route handed to Inngest (the default outbox sender is replaced for this file) */
const toInngest: OutboxMessage[] = []
let inngestBefore: OutboxSender | null = null
beforeAll(() => {
  inngestBefore = getDefaultOutboxSender()
  setDefaultOutboxSender(async (messages) => {
    toInngest.push(...messages)
  })
})
afterAll(() => setDefaultOutboxSender(inngestBefore))

/** An organization whose ORG_ADMIN saved its LINE channel (switched on unless said otherwise) */
async function lineOrg(active = true) {
  const org = await createOrg()
  const admin = await createMember(org.id, 'ผู้ดูแล')
  await prisma.roleAssignment.create({ data: { organizationId: org.id, memberId: admin.id, role: 'ORG_ADMIN', grantedAt: new Date() } })
  const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: admin.id }, channel: 'WEB', now: new Date() })
  const saved = await saveLineChannelSettings(ctx, { ...CHANNEL, active }, { idempotencyKey: randomUUID(), sender: null })
  if (!saved.ok) throw new Error(`channel not saved: ${saved.error.code}`)
  return { orgId: org.id, channelKey: saved.data.channelKey }
}

/** A member linked to a LINE user (a live ChannelIdentity, as the link of S5-04 makes) */
async function linkedMember(orgId: string, options: { providerKey?: string; unlinked?: boolean; deactivated?: boolean } = {}) {
  const member = await createMember(orgId, 'ผู้ใช้ LINE')
  if (options.deactivated) await prisma.member.update({ where: { id: member.id }, data: { status: 'DEACTIVATED' } })
  const lineUserId = newLineUserId()
  await prisma.channelIdentity.create({
    data: {
      organizationId: orgId,
      memberId: member.id,
      channel: 'LINE',
      providerKey: options.providerKey ?? PROVIDER,
      externalUserId: lineUserId,
      linkedAt: new Date(),
      ...(options.unlinked ? { unlinkedAt: new Date() } : {}),
    },
  })
  return { memberId: member.id, lineUserId }
}

/** Posts the body to the route as LINE does: signed with the channel secret unless another signature (or none) is given */
async function deliver(channelKey: string, body: string, signature: string | null = signLineWebhook(TEST_CHANNEL_SECRET, body)) {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'LineBotWebhook/2.0' }
  if (signature !== null) headers['x-line-signature'] = signature
  const started = performance.now()
  const response = await POST(new Request(`http://localhost:3000/api/webhooks/line/${encodeURIComponent(channelKey)}`, { method: 'POST', headers, body }), {
    params: Promise.resolve({ channelKey }),
  })
  return { status: response.status, ms: performance.now() - started, text: await response.text() }
}

/** The webhook as the route calls it, signed as LINE signs it, with the test's own options */
const signed = (channelKey: string, events: readonly LineWebhookEventJson[]) => {
  const { body } = buildLineWebhook(events)
  return { channelKey, rawBody: new TextEncoder().encode(body), signature: signLineWebhook(TEST_CHANNEL_SECRET, body) }
}

const rows = (orgId: string) => prisma.lineWebhookEvent.findMany({ where: { organizationId: orgId }, orderBy: { id: 'asc' } })
const rowOf = async (orgId: string, event: LineWebhookEventJson) => prisma.lineWebhookEvent.findUniqueOrThrow({ where: { organizationId_webhookEventId: { organizationId: orgId, webhookEventId: event.webhookEventId } } })
const reachable = async (memberId: string) => (await prisma.member.findUniqueOrThrow({ where: { id: memberId } })).lineReachable
const repliesTo = (event: LineWebhookEventJson) => line.fake.messages().filter((m) => m.kind === 'reply' && m.replyToken === event.replyToken)
const pushesTo = (lineUserId: string) => line.fake.messages().filter((m) => m.kind === 'push' && m.to === lineUserId)
const queuedOutbox = (orgId: string) => prisma.outbox.findMany({ where: { organizationId: orgId, eventName: LINE_WEBHOOK_QUEUE_EVENT }, orderBy: { createdAt: 'asc' } })

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const until = performance.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || performance.now() > until) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** A promise the test resolves when it wants a handler to go on */
function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

/** Inngest's step for a run of line-webhook, keeping what the run asked for */
function recordingStep() {
  const calls: string[] = []
  const step: LineWebhookJobStep = {
    run: async <T>(id: string, fn: () => Promise<T>) => {
      calls.push(`run ${id}`)
      return fn()
    },
    sleepUntil: async (id: string, at: string) => {
      calls.push(`sleep ${id} until ${at}`)
    },
  }
  return { calls, step }
}

/** A sender standing in for Inngest that keeps what it was given */
function keepingSender() {
  const sent: OutboxMessage[] = []
  const sender: OutboxSender = async (messages) => {
    sent.push(...messages)
  }
  return { sent, sender }
}

describe('[FR-LINE-005/AC1] a webhook with a wrong or missing x-line-signature is refused with 401 and nothing is processed', () => {
  it('refuses no signature, another channel’s secret, a changed body and malformed signatures, then takes the signed one', async () => {
    const { orgId, channelKey } = await lineOrg()
    const linked = await linkedMember(orgId)
    const stranger = lineEvents.follow({ userId: newLineUserId() })
    const { body } = buildLineWebhook([lineEvents.unfollow({ userId: linked.lineUserId }), stranger])
    const signature = signLineWebhook(TEST_CHANNEL_SECRET, body)
    const otherUser = newLineUserId()

    const refusals = [
      await deliver(channelKey, body, null),
      await deliver(channelKey, body, signLineWebhook(OTHER_SECRET, body)),
      // the body changed after LINE signed it (another user id): the signature no longer matches
      await deliver(channelKey, body.replace(linked.lineUserId, otherUser), signature),
      await deliver(channelKey, body, ''),
      await deliver(channelKey, body, 'not-a-signature'),
      await deliver(channelKey, body, `${signature.slice(0, -4)}AAA=`),
      await deliver(channelKey, body, signature.toLowerCase()),
    ]
    for (const refused of refusals) expect(refused).toMatchObject({ status: 401, text: '' })

    // Nothing recorded, nothing processed, nothing said to LINE
    expect(await rows(orgId)).toEqual([])
    expect(await reachable(linked.memberId)).toBe(true)
    expect(repliesTo(stranger)).toEqual([])

    expect((await deliver(channelKey, body, signature)).status).toBe(200)
    expect((await rows(orgId)).map((r) => [r.type, r.status])).toEqual([
      ['unfollow', 'PROCESSED'],
      ['follow', 'PROCESSED'],
    ])
    expect(await reachable(linked.memberId)).toBe(false)
  })

  it('answers 404 without a word to a channel key nobody has, whatever the signature', async () => {
    const { channelKey } = await lineOrg()
    const { body } = buildLineWebhook([lineEvents.follow({ userId: newLineUserId() })])
    const unknown = channelKey.startsWith('A') ? `B${channelKey.slice(1)}` : `A${channelKey.slice(1)}`
    for (const key of [unknown, 'short', '../../api/auth/sign-in', `${channelKey}x`]) expect(await deliver(key, body)).toMatchObject({ status: 404, text: '' })
  })

  it('answers 200 to a signed body with no events (LINE’s verify) or that is not JSON, and records nothing', async () => {
    const { orgId, channelKey } = await lineOrg()
    expect((await deliver(channelKey, buildLineWebhook([]).body)).status).toBe(200)
    expect((await deliver(channelKey, 'this is not json')).status).toBe(200)
    expect((await deliver(channelKey, '{"destination":"U0"}')).status).toBe(200)
    // events without a webhookEventId cannot be told from a redelivery: dropped, the others kept
    const kept = lineEvents.follow({ userId: newLineUserId() })
    const { webhookEventId: _dropped, ...withoutId } = lineEvents.follow({ userId: newLineUserId() })
    expect((await deliver(channelKey, JSON.stringify({ destination: 'U0', events: [withoutId, kept] }))).status).toBe(200)
    expect((await rows(orgId)).map((r) => r.webhookEventId)).toEqual([kept.webhookEventId])
  })

  it('takes the events of a channel that is switched off without recording or answering them (200)', async () => {
    const { orgId, channelKey } = await lineOrg(false)
    const linked = await linkedMember(orgId)
    const follow = lineEvents.follow({ userId: newLineUserId() })
    expect((await deliver(channelKey, buildLineWebhook([lineEvents.unfollow({ userId: linked.lineUserId }), follow]).body)).status).toBe(200)
    expect(await rows(orgId)).toEqual([])
    expect(await reachable(linked.memberId)).toBe(true)
    expect(repliesTo(follow)).toEqual([])
    // and refuses a wrong signature all the same
    expect((await deliver(channelKey, buildLineWebhook([]).body, signLineWebhook(OTHER_SECRET, buildLineWebhook([]).body))).status).toBe(401)
  })
})

describe('[FR-LINE-005/AC2] an event LINE delivers again is not processed again', () => {
  it('records each webhookEventId once: the same body twice is processed once and answered once', async () => {
    const { orgId, channelKey } = await lineOrg()
    const linked = await linkedMember(orgId)
    const follow = lineEvents.follow({ userId: newLineUserId() })
    const { body } = buildLineWebhook([follow, lineEvents.unfollow({ userId: linked.lineUserId })])
    expect((await deliver(channelKey, body)).status).toBe(200)
    expect(await reachable(linked.memberId)).toBe(false)
    // Were the unfollow processed again, the member would be unreachable again
    await prisma.member.update({ where: { id: linked.memberId }, data: { lineReachable: true } })

    expect((await deliver(channelKey, body)).status).toBe(200)
    expect(await rows(orgId)).toHaveLength(2)
    expect(await reachable(linked.memberId)).toBe(true)
    expect(repliesTo(follow)).toHaveLength(1)
  })

  it('skips a redelivery (isRedelivery) of an event it has, and processes a redelivered event it never received', async () => {
    const { orgId, channelKey } = await lineOrg()
    const first = await linkedMember(orgId)
    const second = await linkedMember(orgId)
    const unfollow = lineEvents.unfollow({ userId: first.lineUserId })
    expect((await deliver(channelKey, buildLineWebhook([unfollow]).body)).status).toBe(200)
    await prisma.member.update({ where: { id: first.memberId }, data: { lineReachable: true } })

    expect((await deliver(channelKey, buildLineWebhook([redelivered(unfollow)]).body)).status).toBe(200)
    expect(await reachable(first.memberId)).toBe(true)

    // LINE redelivers what BCS never answered: that one is new here and is processed (BR-LINE-04: skip only what was done)
    const missed = redelivered(lineEvents.unfollow({ userId: second.lineUserId }))
    expect((await deliver(channelKey, buildLineWebhook([missed]).body)).status).toBe(200)
    expect(await reachable(second.memberId)).toBe(false)
    expect(await rowOf(orgId, missed)).toMatchObject({ status: 'PROCESSED', payload: { redelivery: true } })
    expect(await rows(orgId)).toHaveLength(2)
  })

  it('processes each event once when the same body arrives twice at the same moment', async () => {
    const { orgId, channelKey } = await lineOrg()
    const follows = [lineEvents.follow({ userId: newLineUserId() }), lineEvents.follow({ userId: newLineUserId() })]
    const { body } = buildLineWebhook(follows)
    const answers = await Promise.all([deliver(channelKey, body), deliver(channelKey, body), deliver(channelKey, body)])
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200])
    expect((await rows(orgId)).map((r) => r.status)).toEqual(['PROCESSED', 'PROCESSED'])
    for (const follow of follows) expect(repliesTo(follow)).toHaveLength(1)
  })

  it('takes up a delivered-again event whose request dropped it: handed to the job once that request has surely ended, not before', async () => {
    const { orgId, channelKey } = await lineOrg()
    const linked = await linkedMember(orgId)
    const events = [lineEvents.unfollow({ userId: linked.lineUserId }), lineEvents.follow({ userId: newLineUserId() })]
    const arrived = new Date()
    // The first delivery is recorded, but its hand-over fails (the database went away): 500, the events stay RECEIVED
    const failing = await receiveWith(
      signed(channelKey, events),
      {
        openChannel: openLineChannel,
        handOver: async () => {
          throw new Error('the database went away')
        },
      },
      { now: arrived, budgetMs: 0, sender: null },
    )
    expect(failing).toEqual({ status: 500 })
    expect((await rows(orgId)).map((r) => r.status)).toEqual(['RECEIVED', 'RECEIVED'])
    const receivedAt = (await rowOf(orgId, events[0]!)).receivedAt.getTime()

    // Delivered again while the first request might still be at work: a duplicate, left alone
    const { sent, sender } = keepingSender()
    const early = await receiveLineWebhook(signed(channelKey, events.map(redelivered)), { now: new Date(receivedAt + LINE_WEBHOOK_ROUTE_MAX_DURATION_MS), sender })
    expect(early).toMatchObject({ status: 200, recorded: 0, duplicates: 2, recovered: 0, queued: 0 })
    expect((await rows(orgId)).map((r) => r.status)).toEqual(['RECEIVED', 'RECEIVED'])

    // Delivered again once that request has surely ended: not done, so it goes to the job, in the order LINE sent it
    const late = await receiveLineWebhook(signed(channelKey, events.map(redelivered)), { now: new Date(receivedAt + LINE_WEBHOOK_REQUEST_ENDED_MS + 1), sender })
    expect(late).toMatchObject({ status: 200, recorded: 0, duplicates: 2, recovered: 2 })
    const recovered = await Promise.all(events.map((e) => rowOf(orgId, e)))
    expect(recovered.map((r) => [r.status, r.error])).toEqual([
      ['QUEUED', 'RECOVERED'],
      ['QUEUED', 'RECOVERED'],
    ])
    const ids = recovered.map((r) => r.id)
    expect(await eventually(async () => sent.map((m) => m.data), (d) => d.length === 1)).toEqual([{ organizationId: orgId, eventIds: ids }])
    expect(await processQueuedLineWebhookEvents(orgId, ids, new Date(receivedAt + LINE_WEBHOOK_REQUEST_ENDED_MS + 2))).toEqual({ processed: 2, skipped: 0, failed: 0, notQueued: 0 })
    expect(await reachable(linked.memberId)).toBe(false)
    // Done now: a further redelivery is a plain duplicate
    expect(await receiveLineWebhook(signed(channelKey, events.map(redelivered)), { now: new Date(receivedAt + 2 * LINE_WEBHOOK_REQUEST_ENDED_MS), sender })).toMatchObject({ duplicates: 2, recovered: 0 })
  })
})

describe('[FR-LINE-005/AC3] the webhook answers 200 within 2 seconds; what does not fit the inline budget goes to the queue', () => {
  it('answers in time while a postback is still running; it is queued with the events behind it, and the job waits until that request has surely ended', async () => {
    const { orgId, channelKey } = await lineOrg()
    const linked = await linkedMember(orgId)
    const slow = gate()
    const seen: LinePostbackRequest[] = []
    const unregister = registerLinePostbackHandler('slowtest', async (request) => {
      seen.push(request)
      await slow.opened
      return { status: 'PROCESSED', reason: 'INLINE_DONE' }
    })
    try {
      const postback = lineEvents.postback({ userId: linked.lineUserId, data: 'v=1&a=slowtest&k=1' })
      const follow = lineEvents.follow({ userId: newLineUserId() })
      const unfollow = lineEvents.unfollow({ userId: linked.lineUserId })
      const answer = await deliver(channelKey, buildLineWebhook([postback, follow, unfollow]).body)
      expect(answer.status).toBe(200)
      expect(answer.ms).toBeLessThan(LINE_WEBHOOK_ANSWER_WITHIN_MS)
      expect(answer.ms).toBeGreaterThanOrEqual(LINE_WEBHOOK_INLINE_BUDGET_MS - 50)

      // The postback still runs, and is queued too, before the two events behind it: one outbox row, in order, that
      // tells the job to wait until the request has surely ended
      expect(seen).toHaveLength(1)
      const [postbackRow, followRow, unfollowRow] = [await rowOf(orgId, postback), await rowOf(orgId, follow), await rowOf(orgId, unfollow)]
      expect([postbackRow.status, followRow.status, unfollowRow.status]).toEqual(['QUEUED', 'QUEUED', 'QUEUED'])
      const [outbox, ...more] = await queuedOutbox(orgId)
      expect(more).toEqual([])
      const payload = outbox!.payload as LineWebhookQueuePayload
      expect(payload).toEqual({
        organizationId: orgId,
        eventIds: [postbackRow.id, followRow.id, unfollowRow.id],
        notBefore: new Date(postbackRow.receivedAt.getTime() + LINE_WEBHOOK_REQUEST_ENDED_MS).toISOString(),
      })
      // Inngest is told after the answer
      const told = await eventually(
        async () => toInngest.filter((m) => m.id === outbox!.id),
        (m) => m.length === 1,
      )
      expect(told).toEqual([{ id: outbox!.id, name: LINE_WEBHOOK_QUEUE_EVENT, data: payload }])
      expect(await reachable(linked.memberId)).toBe(true)

      // The postback that ran past the answer finishes on its own
      slow.open()
      const finished = await eventually(
        () => rowOf(orgId, postback),
        (r) => r.status === 'PROCESSED',
      )
      expect(finished).toMatchObject({ status: 'PROCESSED', error: 'INLINE_DONE' })

      // The run waits first, then processes what still waits, in order; the follow's reply token is still fresh
      const { calls, step } = recordingStep()
      expect(await lineWebhookRun({ now: () => new Date() })({ data: payload }, step)).toEqual({ processed: 2, skipped: 0, failed: 0, notQueued: 1 })
      expect(calls).toEqual([`sleep until-request-ended until ${payload.notBefore}`, 'run process'])
      expect(seen).toHaveLength(1)
      expect((await rowOf(orgId, follow)).status).toBe('PROCESSED')
      expect(await reachable(linked.memberId)).toBe(false)
      expect(repliesTo(follow)).toHaveLength(1)
      // A repeated run does nothing twice
      expect(await processQueuedLineWebhookEvents(orgId, payload.eventIds, new Date())).toEqual({ processed: 0, skipped: 0, failed: 0, notQueued: 3 })
    } finally {
      slow.open()
      unregister()
    }
  })

  it('finishes in the job an event whose request was cut before it ended: the job’s outcome stands', async () => {
    const { orgId, channelKey } = await lineOrg()
    const linked = await linkedMember(orgId)
    const cut = gate()
    let calls = 0
    let requestRunEnded = false
    const unregister = registerLinePostbackHandler('cuttest', async () => {
      const call = ++calls
      // The first run is the request's, which the platform cuts: it never gets past here while the test looks
      if (call === 1) {
        await cut.opened
        requestRunEnded = true
      }
      return { status: 'PROCESSED', reason: call === 1 ? 'FROM_THE_REQUEST' : 'FROM_THE_JOB' }
    })
    try {
      const postback = lineEvents.postback({ userId: linked.lineUserId, data: 'v=1&a=cuttest&k=1' })
      expect(await receiveLineWebhook(signed(channelKey, [postback]), { budgetMs: 50, sender: null })).toMatchObject({ status: 200, inline: 0, inFlight: 1, queued: 1 })
      const row = await rowOf(orgId, postback)
      expect(row.status).toBe('QUEUED')

      // The job's turn comes once the request has surely ended; it was cut, so the event still waits
      expect(await processQueuedLineWebhookEvents(orgId, [row.id], new Date(row.receivedAt.getTime() + LINE_WEBHOOK_REQUEST_ENDED_MS))).toEqual({ processed: 1, skipped: 0, failed: 0, notQueued: 0 })
      expect(await rowOf(orgId, postback)).toMatchObject({ status: 'PROCESSED', error: 'FROM_THE_JOB' })

      // Should the request come back to life after all, its late outcome changes nothing
      cut.open()
      await eventually(
        async () => requestRunEnded,
        (ended) => ended,
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(calls).toBe(2)
      expect(await rowOf(orgId, postback)).toMatchObject({ status: 'PROCESSED', error: 'FROM_THE_JOB' })
    } finally {
      cut.open()
      unregister()
    }
  })

  it('processes everything inline when it fits, without handing anything over', async () => {
    const { orgId, channelKey } = await lineOrg()
    const linked = await linkedMember(orgId)
    const answer = await deliver(channelKey, buildLineWebhook([lineEvents.follow({ userId: newLineUserId() }), lineEvents.unfollow({ userId: linked.lineUserId })]).body)
    expect(answer.status).toBe(200)
    expect(answer.ms).toBeLessThan(LINE_WEBHOOK_ANSWER_WITHIN_MS)
    expect((await rows(orgId)).map((r) => r.status)).toEqual(['PROCESSED', 'PROCESSED'])
    expect(await queuedOutbox(orgId)).toEqual([])
  })

  it('hands every event to the job when the budget is used up, and an event that failed inline as well', async () => {
    const { orgId, channelKey } = await lineOrg()
    const linked = await linkedMember(orgId)
    let calls = 0
    const unregister = registerLinePostbackHandler('flakytest', async () => {
      calls++
      if (calls === 1) throw new Error('the database went away for a moment')
      return { status: 'PROCESSED' }
    })
    try {
      const { sent, sender } = keepingSender()
      // Fails inline: handed over instead of lost
      const flaky = lineEvents.postback({ userId: linked.lineUserId, data: 'v=1&a=flakytest&k=2' })
      const first = await receiveLineWebhook(signed(channelKey, [flaky]), { sender })
      expect(first).toMatchObject({ status: 200, recorded: 1, inline: 0, inFlight: 0, queued: 1 })
      const flakyRow = await rowOf(orgId, flaky)
      expect(flakyRow.status).toBe('QUEUED')
      expect(await eventually(async () => sent.map((m) => m.data), (d) => d.length === 1)).toEqual([{ organizationId: orgId, eventIds: [flakyRow.id] }])

      // No budget left: nothing inline, everything handed over
      const late = [lineEvents.follow({ userId: newLineUserId() }), lineEvents.unfollow({ userId: linked.lineUserId })]
      const second = await receiveLineWebhook(signed(channelKey, late), { sender, budgetMs: 0 })
      expect(second).toMatchObject({ status: 200, recorded: 2, inline: 0, inFlight: 0, queued: 2 })
      const lateIds = [(await rowOf(orgId, late[0]!)).id, (await rowOf(orgId, late[1]!)).id]

      expect(await processQueuedLineWebhookEvents(orgId, [flakyRow.id, ...lateIds], new Date())).toEqual({ processed: 3, skipped: 0, failed: 0, notQueued: 0 })
      expect(calls).toBe(2)
      expect((await rows(orgId)).map((r) => r.status)).toEqual(['PROCESSED', 'PROCESSED', 'PROCESSED'])
      expect(await reachable(linked.memberId)).toBe(false)
    } finally {
      unregister()
    }
  })

  it('keeps a LINE user’s events in order: once one is handed over, the user’s later events follow it to the job', async () => {
    const { orgId, channelKey } = await lineOrg()
    const linked = await linkedMember(orgId)
    let calls = 0
    const unregister = registerLinePostbackHandler('ordertest', async () => {
      calls++
      if (calls === 1) throw new Error('the database went away for a moment')
      return { status: 'PROCESSED' }
    })
    try {
      const postback = lineEvents.postback({ userId: linked.lineUserId, data: 'v=1&a=ordertest&k=3' })
      const unfollow = lineEvents.unfollow({ userId: linked.lineUserId })
      const stranger = lineEvents.follow({ userId: newLineUserId() })
      const answer = await receiveLineWebhook(signed(channelKey, [postback, unfollow, stranger]), { sender: null })
      // The budget was not used up: the other user's follow ran inline, this user's unfollow waits behind the postback
      expect(answer).toMatchObject({ status: 200, inline: 1, inFlight: 0, queued: 2 })
      expect([(await rowOf(orgId, postback)).status, (await rowOf(orgId, unfollow)).status, (await rowOf(orgId, stranger)).status]).toEqual(['QUEUED', 'QUEUED', 'PROCESSED'])
      expect(await reachable(linked.memberId)).toBe(true)
      const [outbox] = await queuedOutbox(orgId)
      const payload = outbox!.payload as LineWebhookQueuePayload
      expect(payload.eventIds).toEqual([(await rowOf(orgId, postback)).id, (await rowOf(orgId, unfollow)).id])
      expect(payload.notBefore).toBeUndefined()
      expect(await processQueuedLineWebhookEvents(orgId, payload.eventIds, new Date())).toEqual({ processed: 2, skipped: 0, failed: 0, notQueued: 0 })
      expect(await reachable(linked.memberId)).toBe(false)
    } finally {
      unregister()
    }
  })

  it('the job skips queued events of a channel switched off in the meantime', async () => {
    const { orgId, channelKey } = await lineOrg()
    const answer = await receiveLineWebhook(signed(channelKey, [lineEvents.follow({ userId: newLineUserId() })]), { sender: null, budgetMs: 0 })
    expect(answer).toMatchObject({ status: 200, queued: 1 })
    await prisma.lineChannelConfig.update({ where: { organizationId: orgId }, data: { active: false } })
    const [row] = await rows(orgId)
    expect(await processQueuedLineWebhookEvents(orgId, [row!.id], new Date())).toEqual({ processed: 0, skipped: 1, failed: 0, notQueued: 0 })
    expect(await rows(orgId)).toMatchObject([{ status: 'SKIPPED', error: 'CHANNEL_INACTIVE' }])
  })

  it('the job reads the time per event: a reply token that ran out while an earlier event was processed is not used', async () => {
    const { orgId, channelKey } = await lineOrg()
    const unregister = registerLinePostbackHandler('slowjobtest', async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      return { status: 'PROCESSED' }
    })
    try {
      const arrived = new Date()
      const postback = lineEvents.postback({ userId: newLineUserId(), data: 'v=1&a=slowjobtest' })
      const late = lineEvents.follow({ userId: newLineUserId() })
      const alone = lineEvents.follow({ userId: newLineUserId() })
      await receiveLineWebhook(signed(channelKey, [postback, late]), { now: arrived, budgetMs: 0, sender: null })
      await receiveLineWebhook(signed(channelKey, [alone]), { now: arrived, budgetMs: 0, sender: null })
      // The run starts 300 ms before the reply tokens run out (LINE_REPLY_TOKEN_TTL_MS = 1 minute after arrival)
      const start = new Date(arrived.getTime() + 59_700)
      const ids = [(await rowOf(orgId, postback)).id, (await rowOf(orgId, late)).id]
      expect(await processQueuedLineWebhookEvents(orgId, ids, start)).toEqual({ processed: 2, skipped: 0, failed: 0, notQueued: 0 })
      // Behind a 600 ms postback the token is past its minute: no reply, and the row says why
      expect(repliesTo(late)).toEqual([])
      expect(await rowOf(orgId, late)).toMatchObject({ status: 'PROCESSED', error: 'REPLY_TOKEN_EXPIRED' })
      // The same moment without anything before it: still in time, answered by reply
      expect(await processQueuedLineWebhookEvents(orgId, [(await rowOf(orgId, alone)).id], start)).toMatchObject({ processed: 1 })
      expect(repliesTo(alone)).toHaveLength(1)
    } finally {
      unregister()
    }
  })

  it('keeps the route’s maxDuration, the job’s wait for a running event and the day-long give-up consistent', () => {
    expect(maxDuration * MS_PER_SECOND).toBe(LINE_WEBHOOK_ROUTE_MAX_DURATION_MS)
    expect(LINE_WEBHOOK_REQUEST_ENDED_MS).toBeGreaterThan(LINE_WEBHOOK_ROUTE_MAX_DURATION_MS)
    expect(LINE_WEBHOOK_QUEUED_GIVE_UP_MS).toBeGreaterThan(LINE_WEBHOOK_JOB_ROUNDS * LINE_WEBHOOK_ROUND_DELAY_MS * LINE_WEBHOOK_JOB_ROUNDS)
  })
})

describe('[FR-LINE-005/AC3] nothing the webhook recorded is left behind: what nobody finishes goes to the job, or is given up with an alert', () => {
  it('answers 500 when the events cannot be handed to the job, so LINE may deliver them again; the sweep hands them over once the request has surely ended', async () => {
    const { orgId, channelKey } = await lineOrg()
    const linked = await linkedMember(orgId)
    const arrived = new Date()
    const events = [lineEvents.unfollow({ userId: linked.lineUserId }), lineEvents.follow({ userId: newLineUserId() })]
    const failing = await receiveWith(
      signed(channelKey, events),
      {
        openChannel: openLineChannel,
        handOver: async () => {
          throw new Error('the database went away')
        },
      },
      { now: arrived, budgetMs: 0, sender: null },
    )
    expect(failing).toEqual({ status: 500 })
    const receivedAt = (await rowOf(orgId, events[0]!)).receivedAt.getTime()

    const { sent, sender } = keepingSender()
    // Too early: the request that recorded them may still be at work
    expect(await sweepLineWebhookEvents(new Date(receivedAt + LINE_WEBHOOK_ROUTE_MAX_DURATION_MS), { organizationIds: [orgId], sender })).toEqual({ organizations: 1, recovered: 0, gaveUp: 0, failed: 0 })
    expect((await rows(orgId)).map((r) => r.status)).toEqual(['RECEIVED', 'RECEIVED'])

    const after = new Date(receivedAt + LINE_WEBHOOK_REQUEST_ENDED_MS + 1)
    expect(await sweepLineWebhookEvents(after, { organizationIds: [orgId], sender })).toEqual({ organizations: 1, recovered: 2, gaveUp: 0, failed: 0 })
    const ids = (await Promise.all(events.map((e) => rowOf(orgId, e)))).map((r) => r.id)
    expect((await rows(orgId)).map((r) => [r.status, r.error])).toEqual([
      ['QUEUED', 'RECOVERED'],
      ['QUEUED', 'RECOVERED'],
    ])
    expect(sent.map((m) => m.data)).toEqual([{ organizationId: orgId, eventIds: ids }])
    // A sweep again changes nothing
    expect(await sweepLineWebhookEvents(after, { organizationIds: [orgId], sender })).toMatchObject({ recovered: 0, gaveUp: 0 })
    expect(await processQueuedLineWebhookEvents(orgId, ids, after)).toEqual({ processed: 2, skipped: 0, failed: 0, notQueued: 0 })
    expect(await reachable(linked.memberId)).toBe(false)
  })

  it('gives up, with an alert, what still waits a day after it arrived, whether the request or the job dropped it', async () => {
    const { orgId, channelKey } = await lineOrg()
    const arrived = new Date()
    const dropped = lineEvents.follow({ userId: newLineUserId() })
    const waiting = lineEvents.follow({ userId: newLineUserId() })
    await receiveWith(
      signed(channelKey, [dropped]),
      {
        openChannel: openLineChannel,
        handOver: async () => {
          throw new Error('the database went away')
        },
      },
      { now: arrived, budgetMs: 0, sender: null },
    )
    await receiveLineWebhook(signed(channelKey, [waiting]), { now: arrived, budgetMs: 0, sender: null })
    expect([(await rowOf(orgId, dropped)).status, (await rowOf(orgId, waiting)).status]).toEqual(['RECEIVED', 'QUEUED'])

    // Before the day is over nothing is given up; the dropped one goes to the job instead
    const earliest = Math.min((await rowOf(orgId, dropped)).receivedAt.getTime(), (await rowOf(orgId, waiting)).receivedAt.getTime())
    expect(await sweepLineWebhookEvents(new Date(earliest + LINE_WEBHOOK_QUEUED_GIVE_UP_MS - MS_PER_SECOND), { organizationIds: [orgId], sender: null })).toEqual({ organizations: 1, recovered: 1, gaveUp: 0, failed: 0 })
    expect([(await rowOf(orgId, dropped)).status, (await rowOf(orgId, waiting)).status]).toEqual(['QUEUED', 'QUEUED'])

    // Still waiting a day after: no run finished them, so they are given up rather than left waiting
    const latest = Math.max((await rowOf(orgId, dropped)).receivedAt.getTime(), (await rowOf(orgId, waiting)).receivedAt.getTime())
    const dayLater = new Date(latest + LINE_WEBHOOK_QUEUED_GIVE_UP_MS + 1)
    expect(await sweepLineWebhookEvents(dayLater, { organizationIds: [orgId], sender: null })).toEqual({ organizations: 1, recovered: 0, gaveUp: 2, failed: 0 })
    expect((await rows(orgId)).map((r) => [r.status, r.error])).toEqual([
      ['FAILED', 'GAVE_UP'],
      ['FAILED', 'GAVE_UP'],
    ])
    // A run that comes after all finds nothing to do
    const ids = (await rows(orgId)).map((r) => r.id)
    expect(await processQueuedLineWebhookEvents(orgId, ids, dayLater)).toEqual({ processed: 0, skipped: 0, failed: 0, notQueued: 2 })
  })

  it('a run Inngest gave up hands what still waits to the next run, later each time, and after the last run gives it up', async () => {
    const { orgId, channelKey } = await lineOrg()
    const events = [lineEvents.follow({ userId: newLineUserId() }), lineEvents.follow({ userId: newLineUserId() })]
    await receiveLineWebhook(signed(channelKey, events), { budgetMs: 0, sender: null })
    const [firstRun] = await queuedOutbox(orgId)
    const first = firstRun!.payload as LineWebhookQueuePayload
    // The run did one event before it failed for good
    const [doneId, waitingId] = first.eventIds
    expect(await processQueuedLineWebhookEvents(orgId, [doneId!], new Date())).toMatchObject({ processed: 1 })

    const { sent, sender } = keepingSender()
    const now = new Date()
    let payload = first
    for (let round = 1; round < LINE_WEBHOOK_JOB_ROUNDS; round++) {
      expect(await settleFailedLineWebhookRun(payload, now, { sender })).toEqual({ round, requeued: 1, gaveUp: 0 })
      payload = sent.at(-1)!.data as LineWebhookQueuePayload
      expect(payload).toEqual({ organizationId: orgId, eventIds: [waitingId], round, notBefore: new Date(now.getTime() + LINE_WEBHOOK_ROUND_DELAY_MS * round).toISOString() })
      expect((await prisma.lineWebhookEvent.findUniqueOrThrow({ where: { id: waitingId! } })).status).toBe('QUEUED')
    }
    // The last run failed too: given up, not left waiting; the event that was done stays done
    expect(await settleFailedLineWebhookRun(payload, now, { sender })).toEqual({ round: LINE_WEBHOOK_JOB_ROUNDS, requeued: 0, gaveUp: 1 })
    expect(await prisma.lineWebhookEvent.findUniqueOrThrow({ where: { id: waitingId! } })).toMatchObject({ status: 'FAILED', error: 'GAVE_UP' })
    expect(await prisma.lineWebhookEvent.findUniqueOrThrow({ where: { id: doneId! } })).toMatchObject({ status: 'PROCESSED' })
    expect(sent).toHaveLength(LINE_WEBHOOK_JOB_ROUNDS - 1)
  })
})

describe('[BR-LINE-08] follow and unfollow keep Member.lineReachable; a follow is answered by reply, never by push (BR-LINE-07)', () => {
  it('an unfollow makes a linked member unreachable; a follow makes them reachable again and welcomes them back', async () => {
    const { orgId, channelKey } = await lineOrg()
    const linked = await linkedMember(orgId)
    expect((await deliver(channelKey, buildLineWebhook([lineEvents.unfollow({ userId: linked.lineUserId })]).body)).status).toBe(200)
    expect(await reachable(linked.memberId)).toBe(false)

    const follow = lineEvents.follow({ userId: linked.lineUserId, unblocked: true })
    expect((await deliver(channelKey, buildLineWebhook([follow]).body)).status).toBe(200)
    expect(await reachable(linked.memberId)).toBe(true)
    const [reply] = repliesTo(follow)
    expect(reply!.messages).toEqual([{ type: 'text', text: expect.stringContaining('ยินดีต้อนรับกลับ') }])
    expect(pushesTo(linked.lineUserId)).toEqual([])
    expect(await rowOf(orgId, follow)).toMatchObject({ status: 'PROCESSED', error: null, payload: { unblocked: true, userId: linked.lineUserId } })
  })

  it('lets the last follow or unfollow LINE sent decide, whatever order they arrive and are processed in', async () => {
    const { orgId, channelKey } = await lineOrg()
    const linked = await linkedMember(orgId)
    const t = Date.now()
    await prisma.member.update({ where: { id: linked.memberId }, data: { lineReachable: false } })
    // The user blocked the account, then unblocked it; LINE delivers the follow first and the unfollow late
    const follow = lineEvents.follow({ userId: linked.lineUserId, unblocked: true, timestamp: t - 2 * MS_PER_SECOND })
    const unfollow = lineEvents.unfollow({ userId: linked.lineUserId, timestamp: t - 5 * MS_PER_SECOND })
    expect((await deliver(channelKey, buildLineWebhook([follow]).body)).status).toBe(200)
    expect(await reachable(linked.memberId)).toBe(true)
    expect((await deliver(channelKey, buildLineWebhook([redelivered(unfollow)]).body)).status).toBe(200)
    expect(await reachable(linked.memberId)).toBe(true)
    expect(await rowOf(orgId, unfollow)).toMatchObject({ status: 'PROCESSED', error: 'SUPERSEDED' })

    // An older follow that comes even later changes nothing and says nothing
    const olderFollow = lineEvents.follow({ userId: linked.lineUserId, timestamp: t - 9 * MS_PER_SECOND })
    await prisma.member.update({ where: { id: linked.memberId }, data: { lineReachable: false } })
    expect((await deliver(channelKey, buildLineWebhook([olderFollow]).body)).status).toBe(200)
    expect(await reachable(linked.memberId)).toBe(false)
    expect(repliesTo(olderFollow)).toEqual([])
    await prisma.member.update({ where: { id: linked.memberId }, data: { lineReachable: true } })

    // The job may meet them out of order (separate runs): the later one still decides
    const unblock = lineEvents.follow({ userId: linked.lineUserId, timestamp: t - MS_PER_SECOND })
    const block = lineEvents.unfollow({ userId: linked.lineUserId, timestamp: t })
    await receiveLineWebhook(signed(channelKey, [unblock, block]), { budgetMs: 0, sender: null })
    await processQueuedLineWebhookEvents(orgId, [(await rowOf(orgId, block)).id], new Date())
    await processQueuedLineWebhookEvents(orgId, [(await rowOf(orgId, unblock)).id], new Date())
    expect(await reachable(linked.memberId)).toBe(false)
    expect(await rowOf(orgId, unblock)).toMatchObject({ status: 'PROCESSED', error: 'SUPERSEDED' })
    expect(repliesTo(unblock)).toEqual([])

    // A later one in another mode, or in a group, is not the user's own chat with the account: it decides nothing
    const standbyLater = lineEvents.follow({ userId: linked.lineUserId, timestamp: t + MS_PER_HOUR, mode: 'standby' })
    const unfollowNow = lineEvents.unfollow({ userId: linked.lineUserId, timestamp: t + MS_PER_SECOND })
    await prisma.member.update({ where: { id: linked.memberId }, data: { lineReachable: true } })
    expect((await deliver(channelKey, buildLineWebhook([standbyLater, unfollowNow]).body)).status).toBe(200)
    expect(await reachable(linked.memberId)).toBe(false)
  })

  it('shows someone who is not linked how to link, with the LIFF link page, and changes no member', async () => {
    const { orgId, channelKey } = await lineOrg()
    const before = await prisma.member.findMany({ where: { organizationId: orgId }, orderBy: { id: 'asc' } })
    const follow = lineEvents.follow({ userId: newLineUserId() })
    const unfollow = lineEvents.unfollow({ userId: newLineUserId() })
    expect((await deliver(channelKey, buildLineWebhook([follow, unfollow]).body)).status).toBe(200)
    const [reply] = repliesTo(follow)
    expect((reply!.messages[0] as { text: string }).text).toContain(`https://liff.line.me/${LIFF_ID}/link`)
    expect(await rowOf(orgId, unfollow)).toMatchObject({ status: 'SKIPPED', error: 'NOT_LINKED' })
    expect(await prisma.member.findMany({ where: { organizationId: orgId }, orderBy: { id: 'asc' } })).toEqual(before)
  })

  it('counts a link under another provider, an ended link or a deactivated member as not linked', async () => {
    const { orgId, channelKey } = await lineOrg()
    const others = [await linkedMember(orgId, { providerKey: '1999999999' }), await linkedMember(orgId, { unlinked: true }), await linkedMember(orgId, { deactivated: true })]
    const unfollows = others.map((o) => lineEvents.unfollow({ userId: o.lineUserId }))
    expect((await deliver(channelKey, buildLineWebhook(unfollows).body)).status).toBe(200)
    for (const o of others) expect(await reachable(o.memberId)).toBe(true)
    expect((await rows(orgId)).map((r) => r.error)).toEqual(['NOT_LINKED', 'NOT_LINKED', 'NOT_LINKED'])
  })

  it('does not act on messages (and keeps no text), group chats or the standby mode', async () => {
    const { orgId, channelKey } = await lineOrg()
    const linked = await linkedMember(orgId)
    const message = lineEvents.message({ userId: linked.lineUserId, text: 'รหัสผ่านของฉันคือ hunter2' })
    const group = lineEvents.unfollow({ userId: linked.lineUserId, groupId: 'C0123456789abcdef0123456789abcdef' })
    const standby = lineEvents.unfollow({ userId: linked.lineUserId, mode: 'standby' })
    expect((await deliver(channelKey, buildLineWebhook([message, group, standby]).body)).status).toBe(200)
    expect((await rows(orgId)).map((r) => [r.type, r.status, r.error])).toEqual([
      ['message', 'SKIPPED', 'NOT_HANDLED'],
      ['unfollow', 'SKIPPED', 'NOT_A_USER_CHAT'],
      ['unfollow', 'SKIPPED', 'NOT_ACTIVE_MODE'],
    ])
    expect(await reachable(linked.memberId)).toBe(true)
    expect(repliesTo(message)).toEqual([])
    expect(JSON.stringify(await rows(orgId))).not.toContain('hunter2')
    expect(await rowOf(orgId, message)).toMatchObject({ payload: { messageType: 'text' } })
  })
})

describe('[BR-TOK-02] a postback reaches the handler of its action with the member linked to the LINE user of the signed webhook', () => {
  it('hands v=1&a=<action>&… to its handler with the linked member, or none for a LINE user who is not linked', async () => {
    const { orgId, channelKey } = await lineOrg()
    const linked = await linkedMember(orgId)
    const seen: LinePostbackRequest[] = []
    const contexts: LinePostbackContext[] = []
    const unregister = registerLinePostbackHandler('probetest', async (request, context) => {
      seen.push(request)
      contexts.push(context)
      return { status: 'PROCESSED' }
    })
    try {
      const mine = lineEvents.postback({ userId: linked.lineUserId, data: 'v=1&a=probetest&k=11111111-1111-7111-8111-111111111111' })
      const strangers = lineEvents.postback({ userId: newLineUserId(), data: 'v=1&a=probetest&k=2' })
      expect((await deliver(channelKey, buildLineWebhook([mine, strangers]).body)).status).toBe(200)
      expect(seen).toHaveLength(2)
      expect(contexts.map((c) => [c.path, c.channel.organizationId])).toEqual([
        ['INLINE', orgId],
        ['INLINE', orgId],
      ])
      // The handler can read the time again when it answers (reply or push, BR-LINE-07)
      expect(contexts[0]!.clock.now().getTime()).toBeGreaterThanOrEqual(contexts[0]!.now.getTime())
      expect((await rows(orgId)).map((r) => r.status)).toEqual(['PROCESSED', 'PROCESSED'])
      expect(seen[0]).toMatchObject({
        organizationId: orgId,
        webhookEventId: mine.webhookEventId,
        lineUserId: linked.lineUserId,
        memberId: linked.memberId,
        action: 'probetest',
        replyToken: mine.replyToken,
        redelivery: false,
      })
      expect(Object.fromEntries(seen[0]!.params)).toEqual({ v: '1', a: 'probetest', k: '11111111-1111-7111-8111-111111111111' })
      expect(seen[1]).toMatchObject({ lineUserId: strangers.source.userId, memberId: null })
    } finally {
      unregister()
    }
  })

  it('skips data of another form, a repeated key and an action nobody handles', async () => {
    const { orgId, channelKey } = await lineOrg()
    const linked = await linkedMember(orgId)
    let called = 0
    const unregister = registerLinePostbackHandler('probetest', async () => {
      called++
      return { status: 'PROCESSED' }
    })
    try {
      const datas = ['a=probetest&k=1', 'v=2&a=probetest', 'v=1&a=probetest&a=approve', 'v=1&a=Probe', 'v=1&a=nobody', 'just text', `v=1&a=probetest&k=${'x'.repeat(300)}`]
      expect((await deliver(channelKey, buildLineWebhook(datas.map((data) => lineEvents.postback({ userId: linked.lineUserId, data }))).body)).status).toBe(200)
      expect(called).toBe(0)
      expect((await rows(orgId)).map((r) => r.error)).toEqual([
        'POSTBACK_INVALID',
        'POSTBACK_INVALID',
        'POSTBACK_INVALID',
        'POSTBACK_INVALID',
        'POSTBACK_UNKNOWN_ACTION',
        'POSTBACK_INVALID',
        'POSTBACK_INVALID',
      ])
    } finally {
      unregister()
    }
  })

  it('keeps one handler per action: registering again replaces it, and an action name of another form is refused', async () => {
    const { orgId, channelKey } = await lineOrg()
    const calls: string[] = []
    const removeFirst = registerLinePostbackHandler('onlyonce', async () => {
      calls.push('first')
      return { status: 'PROCESSED' }
    })
    // The same module evaluated again (a development reload) registers its handler again
    const removeSecond = registerLinePostbackHandler('onlyonce', async () => {
      calls.push('second')
      return { status: 'PROCESSED' }
    })
    try {
      removeFirst()
      expect(linePostbackActions()).toContain('onlyonce')
      expect((await deliver(channelKey, buildLineWebhook([lineEvents.postback({ userId: newLineUserId(), data: 'v=1&a=onlyonce' })]).body)).status).toBe(200)
      expect(calls).toEqual(['second'])
      expect(() => registerLinePostbackHandler('Approve!', async () => ({ status: 'PROCESSED' }))).toThrow(TypeError)
    } finally {
      removeSecond()
    }
    expect(linePostbackActions()).not.toContain('onlyonce')
    expect(await rows(orgId)).toHaveLength(1)
  })
})
