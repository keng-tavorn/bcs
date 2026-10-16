import { isValidLineSignature } from '@/integrations/line'
import { logger } from '@/lib/logger'
import { findLineChannelOrganization } from '@/server/db/lookups'
import { describeError } from '@/server/errors/describe'
import { getDefaultOutboxSender, type OutboxSender } from '@/server/events/outbox'
import { LINE_CHANNEL_KEY_PATTERN } from '@/server/queries/line-channel'
import type { Clock } from '@/lib/clock'
import { parseLineWebhook } from './body'
import { LINE_WEBHOOK_INLINE_BUDGET_MS, LINE_WEBHOOK_REQUEST_ENDED_MS } from './constants'
import { runLineWebhookEvent } from './process'
import { tellLineWebhookJob, webhookClock } from './queue'
import { finishLineWebhookEvent, handOverLineWebhookEvents, loadQueuedLineWebhookEvents, recordLineWebhookEvents, recoverStaleLineWebhookEvents } from './store'
import type { LineWebhookChannel, OpenLineWebhookChannel, RecordedLineEvent } from './types'

// The LINE webhook (FR-LINE-005, BR-LINE-03 to 05). For POST /api/webhooks/line/<channelKey>:
//  1. the channelKey names an organization's channel; an unknown key is 404 and nothing more is said;
//  2. x-line-signature must be base64(HMAC-SHA256(channel secret, raw body)), compared in constant time on the bytes as
//     received, before anything is parsed: a wrong or missing one is 401 and nothing is recorded or processed;
//  3. each event is recorded once per webhookEventId (store.ts): a redelivery or a repeated id is not processed again —
//     unless its request dropped it (still RECEIVED long after), which is then handed to the job (BR-LINE-04: only what
//     was done is skipped);
//  4. the recorded events are processed in order, inline, until LINE_WEBHOOK_INLINE_BUDGET_MS has passed since the
//     request arrived. Whatever is not done then goes to the line-webhook job (QUEUED, through the outbox), in order, in
//     one hand-over: the events not started, one that failed inline, and the one still running, which goes on after the
//     answer but is queued too, so a cut request loses nothing (AC3: work that takes longer goes to the queue). The job
//     waits until that request has surely ended before it looks at them. Once one event of a LINE user is handed over,
//     that user's later events follow it there rather than overtake it inline;
//  5. the answer is 200 whenever the signature is right and the events are safe — also when the body holds nothing BCS
//     reads, or the channel is switched off — so LINE never redelivers what was checked (BR-LINE-05). When the events
//     could not be recorded or handed over (the database), the answer is 500 so that LINE may deliver them again; the
//     line-webhook sweep picks up any it recorded meanwhile.
// Logs carry the organization and counts: never the body, a LINE user id, a reply token or the signature (NFR-SEC-09).

export interface LineWebhookRequest {
  readonly channelKey: string
  /** The body exactly as received: the signature covers these bytes */
  readonly rawBody: Uint8Array
  /** The x-line-signature header; null when there is none */
  readonly signature: string | null
}

export interface LineWebhookDeps {
  /** openLineChannel of src/server/services/line-channel */
  readonly openChannel: OpenLineWebhookChannel
  /** The hand-over to the job (store.ts); tests replace it to see what a failed one does */
  readonly handOver?: typeof handOverLineWebhookEvents
  /** S17-06: whether the organization asks through the chat now (chatIntakeSettingsFor of src/lib/s17-settings) — only then is a message's text kept */
  readonly asksThroughChat?: (organizationId: string) => Promise<boolean>
}

export interface ReceiveLineWebhookOptions {
  /** The time of receipt, from which time goes on with real time; real time by default (tests give their own) */
  readonly now?: Date
  /** performance.now() when the request arrived: the inline budget counts from it. Now by default */
  readonly startedAt?: number
  /** LINE_WEBHOOK_INLINE_BUDGET_MS by default */
  readonly budgetMs?: number
  /** Keeps work going after the answer: next/server after() in the route. Without it the work runs on by itself */
  readonly waitUntil?: (work: Promise<unknown>) => void
  /** Sends the hand-over to the job: Inngest by default; null leaves it to the outbox-sweeper */
  readonly sender?: OutboxSender | null
}

export type LineWebhookIgnored = 'NOT_JSON' | 'NOT_A_WEBHOOK' | 'CHANNEL_INACTIVE'

export type LineWebhookAnswer =
  | {
      readonly status: 200
      /** Events recorded by this request (new webhookEventIds) */
      readonly recorded: number
      /** Events whose webhookEventId was recorded before: not processed again (BR-LINE-04) */
      readonly duplicates: number
      /** Of the duplicates, events their request had dropped: handed to the job now */
      readonly recovered: number
      /** Events without a usable webhookEventId: dropped */
      readonly unreadable: number
      /** Processed before the answer */
      readonly inline: number
      /** Started inline and still running at the answer: it goes on, and is queued as well */
      readonly inFlight: number
      /** Handed to the line-webhook job (the one still running included) */
      readonly queued: number
      readonly ignored?: LineWebhookIgnored
    }
  | { readonly status: 401 | 404 | 500 }

const NOTHING = { recorded: 0, duplicates: 0, recovered: 0, unreadable: 0, inline: 0, inFlight: 0, queued: 0 } as const

type Log = Pick<typeof logger, 'info' | 'warn' | 'error'>

/** What `work` settled with, or null when it had not settled after `ms`; `work` never rejects */
async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

/** The statuses an inline run finishes from: RECEIVED, or QUEUED once it was handed over while still running */
const INLINE_FROM = ['RECEIVED', 'QUEUED'] as const

/**
 * One event inline: DONE, or RETRY when it failed in a way another try may fix (the row is left for the job). Never
 * rejects.
 */
async function processInline(channel: LineWebhookChannel, event: RecordedLineEvent, clock: Clock, log: Log): Promise<'DONE' | 'RETRY'> {
  try {
    await runLineWebhookEvent(channel, event, INLINE_FROM, { now: clock.now(), clock, path: 'INLINE' })
    return 'DONE'
  } catch (error) {
    log.warn({ error: describeError(error), eventId: event.id }, 'a LINE webhook event failed inline; the line-webhook job tries it again')
    return 'RETRY'
  }
}

export async function receiveLineWebhook(request: LineWebhookRequest, deps: LineWebhookDeps, options: ReceiveLineWebhookOptions = {}): Promise<LineWebhookAnswer> {
  const startedAt = options.startedAt ?? performance.now()
  const deadline = startedAt + (options.budgetMs ?? LINE_WEBHOOK_INLINE_BUDGET_MS)
  const clock = webhookClock(options.now)
  const waitUntil = options.waitUntil ?? ((work: Promise<unknown>) => void work)
  const sender = options.sender === undefined ? getDefaultOutboxSender() : options.sender
  const handOver = deps.handOver ?? handOverLineWebhookEvents

  if (!LINE_CHANNEL_KEY_PATTERN.test(request.channelKey)) return { status: 404 }
  let found: Awaited<ReturnType<typeof findLineChannelOrganization>>
  let opened: Awaited<ReturnType<OpenLineWebhookChannel>> | null = null
  try {
    found = await findLineChannelOrganization(request.channelKey)
    if (found) opened = await deps.openChannel(found.organizationId)
  } catch (error) {
    // The database could not be asked: LINE may deliver the events again
    logger.error({ error: describeError(error) }, 'LINE webhook: the channel could not be read')
    return { status: 500 }
  }
  if (!found || !opened) return { status: 404 }
  const log = logger.child({ organizationId: found.organizationId })
  if (!opened.ok) {
    if (opened.reason === 'NOT_CONFIGURED') return { status: 404 }
    log.error({ alert: true }, 'LINE webhook: the stored channel secret does not open (ENCRYPTION_KEY changed?); enter the channel secret again in the LINE settings')
    return { status: 500 }
  }
  const channel = opened.channel

  if (!isValidLineSignature(channel.channelSecret, request.rawBody, request.signature)) {
    log.warn({ header: request.signature ? 'WRONG' : 'MISSING' }, 'LINE webhook refused: x-line-signature does not match the channel secret')
    return { status: 401 }
  }

  const parsed = parseLineWebhook(request.rawBody)
  if (!parsed.ok) {
    log.warn({ reason: parsed.reason }, 'LINE webhook signed correctly but without events BCS can read')
    return { status: 200, ...NOTHING, ignored: parsed.reason }
  }
  if (parsed.unreadable > 0) log.warn({ unreadable: parsed.unreadable }, 'LINE webhook events without a usable webhookEventId were dropped')
  // LINE is switched off in this organization: nothing is recorded or answered
  if (!channel.active) return { status: 200, ...NOTHING, unreadable: parsed.unreadable, ignored: 'CHANNEL_INACTIVE' }

  const receivedAt = clock.now()
  const outboxIds: string[] = []
  let recorded: Awaited<ReturnType<typeof recordLineWebhookEvents>>
  try {
    const keepChatText = parsed.events.some((e) => e.inbound?.kind === 'TEXT') && deps.asksThroughChat ? await deps.asksThroughChat(channel.organizationId) : false
    recorded = await recordLineWebhookEvents(channel.organizationId, channel.channelKey, parsed.events, receivedAt, { keepChatText })
  } catch (error) {
    log.error({ error: describeError(error), events: parsed.events.length }, 'LINE webhook events could not be recorded; LINE may deliver them again')
    return { status: 500 }
  }
  // Delivered again: what its first request dropped is not done, so it goes to the job now (BR-LINE-04). Should this
  // fail, the line-webhook sweep finds the same rows a few minutes later.
  let recovered = 0
  try {
    const stale = await recoverStaleLineWebhookEvents(channel.organizationId, receivedAt, { webhookEventIds: recorded.duplicates })
    recovered = stale.handedOver.length
    outboxIds.push(...stale.outboxIds)
    if (stale.gaveUp.length > 0) log.error({ alert: true, events: stale.gaveUp.length }, 'LINE webhook events delivered again were given up: no run of the line-webhook job finished them within a day')
  } catch (error) {
    log.warn({ error: describeError(error), events: recorded.duplicates.length }, 'LINE webhook: events delivered again could not be checked; the line-webhook sweep recovers any that were dropped')
  }

  // Inline in order while the budget lasts; the rest, in order, to the job (see 4. above)
  const events = recorded.recorded
  const toJob: string[] = []
  const usersWaiting = new Set<string>()
  const queue = (event: RecordedLineEvent) => {
    toJob.push(event.id)
    if (event.payload.userId) usersWaiting.add(event.payload.userId)
  }
  let budgetOver = false
  let inline = 0
  let inFlight = 0
  for (const event of events) {
    const remaining = deadline - performance.now()
    if (budgetOver || remaining <= 0 || (event.payload.userId !== null && usersWaiting.has(event.payload.userId))) {
      budgetOver ||= remaining <= 0
      queue(event)
      continue
    }
    const work = processInline(channel, event, clock, log)
    const settled = await settlesWithin(work, remaining)
    if (settled === 'DONE') inline++
    else if (settled === 'RETRY') queue(event)
    else {
      // Still running at the end of the budget: it goes on after the answer, and is queued as well in case it is cut
      inFlight++
      waitUntil(work)
      queue(event)
      budgetOver = true
    }
  }

  let queued = 0
  if (toJob.length > 0) {
    try {
      // Committed before the answer, so the job is sure to hear of them; telling Inngest goes on after the answer
      const handed = await handOver(channel.organizationId, toJob, inFlight > 0 ? { notBefore: new Date(receivedAt.getTime() + LINE_WEBHOOK_REQUEST_ENDED_MS) } : {})
      queued = handed.queued.length
      outboxIds.push(...handed.outboxIds)
    } catch (error) {
      log.error(
        { alert: true, error: describeError(error), events: toJob.length },
        'LINE webhook events are recorded but could not be handed to the line-webhook job: answering 500 so that LINE may deliver them again; the line-webhook sweep recovers them otherwise',
      )
      waitUntil(tellLineWebhookJob(outboxIds, sender, log))
      return { status: 500 }
    }
  }
  waitUntil(tellLineWebhookJob(outboxIds, sender, log))
  const answer = { status: 200, recorded: events.length, duplicates: recorded.duplicates.length, recovered, unreadable: parsed.unreadable, inline, inFlight, queued } as const
  log.info({ ...answer }, 'LINE webhook')
  return answer
}

export interface LineWebhookJobResult {
  readonly processed: number
  readonly skipped: number
  readonly failed: number
  /** Ids that were not waiting for the job (finished already, or unknown) */
  readonly notQueued: number
}

/**
 * The line-webhook job (§4.6 handler of `bcs/line.webhook_received`): processes the QUEUED events of these ids in order,
 * each at the time it really starts (`now` is when the run started; tests give their own and it goes on with real
 * time). Rows finished already are left alone, so a run that is repeated does nothing twice. When the channel is gone or
 * switched off the events are skipped; when its secret does not open, or an event fails in a way another try may fix,
 * it throws after the others so Inngest retries the step.
 */
export async function processQueuedLineWebhookEvents(organizationId: string, eventIds: readonly string[], now: Date, deps: LineWebhookDeps): Promise<LineWebhookJobResult> {
  const clock = webhookClock(now)
  const events = await loadQueuedLineWebhookEvents(organizationId, eventIds)
  const result = { processed: 0, skipped: 0, failed: 0, notQueued: eventIds.length - events.length }
  if (events.length === 0) return result
  const log = logger.child({ organizationId, job: 'line-webhook' })
  const opened = await deps.openChannel(organizationId)
  if (!opened.ok && opened.reason === 'SECRET_UNREADABLE') throw new Error('the stored LINE channel secret does not open; the line-webhook job tries again later')
  const unavailable = !opened.ok ? 'CHANNEL_NOT_CONFIGURED' : opened.channel.active ? null : 'CHANNEL_INACTIVE'
  if (!opened.ok || unavailable) {
    for (const event of events) {
      if (await finishLineWebhookEvent(organizationId, event.id, ['QUEUED'], { status: 'SKIPPED', reason: unavailable ?? 'CHANNEL_NOT_CONFIGURED' }, clock.now())) result.skipped++
    }
    return result
  }
  let retry = 0
  for (const event of events) {
    try {
      const outcome = await runLineWebhookEvent(opened.channel, event, ['QUEUED'], { now: clock.now(), clock, path: 'QUEUED' })
      if (outcome.status === 'PROCESSED') result.processed++
      else if (outcome.status === 'SKIPPED') result.skipped++
      else result.failed++
    } catch (error) {
      retry++
      log.warn({ error: describeError(error), eventId: event.id }, 'a queued LINE webhook event failed; Inngest tries the step again')
    }
  }
  if (retry > 0) throw new Error(`${retry} LINE webhook event(s) failed; the line-webhook job tries them again`)
  return result
}
