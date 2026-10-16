import { newId } from '@/lib/ids'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { enqueueOutbox } from '@/server/events/outbox'
import { StoredLineEvent, type ParsedLineEvent } from './body'
import { LINE_WEBHOOK_JOB_MAX_EVENTS, LINE_WEBHOOK_QUEUE_EVENT, LINE_WEBHOOK_QUEUED_GIVE_UP_MS, LINE_WEBHOOK_REQUEST_ENDED_MS } from './constants'
import type { LineWebhookQueuePayload } from './queue'
import type { LineEventOutcome, RecordedLineEvent } from './types'

// LineWebhookEvent rows: intake bookkeeping of the webhook, like the outbox (not an aggregate, so no Event). A row is
// written before anything is processed, once per (organization, webhookEventId) — a redelivery or a repeated id finds
// the row and is not processed again unless it was dropped (BR-LINE-04: only what was done is skipped). Its status moves:
//   RECEIVED ──(processed inline by the request that recorded it)──→ PROCESSED · SKIPPED · FAILED
//   RECEIVED ──(handed to the line-webhook job with an outbox row)──→ QUEUED ──(a run of the job)──→ PROCESSED · SKIPPED · FAILED
// Every move is a conditional update from the expected status, so it happens once. The job takes QUEUED rows only. One
// overlap is by design: an event still running inline when the webhook answers is handed over as well (FR-LINE-005 AC3),
// and finishes from QUEUED if its request lives on; the job waits until that request has surely ended before it looks
// (notBefore). Rows nobody finishes are not left behind (BR-LINE-05):
//  - RECEIVED older than LINE_WEBHOOK_REQUEST_ENDED_MS: its request dropped it → handed to the job (error RECOVERED), by a
//    redelivery of the event or by the line-webhook sweep;
//  - QUEUED after every run of the job failed → FAILED with error GAVE_UP (the job's failure handler, with an alert);
//    one still RECEIVED or QUEUED LINE_WEBHOOK_QUEUED_GIVE_UP_MS after it arrived (nothing ever finished it) → the same,
//    by the sweep.

export type LineWebhookStatus = 'RECEIVED' | 'QUEUED' | 'PROCESSED' | 'SKIPPED' | 'FAILED'

/** LineWebhookEvent.error of a QUEUED row recovered from RECEIVED (its request dropped it) */
export const LINE_WEBHOOK_RECOVERED = 'RECOVERED'
/** LineWebhookEvent.error of a row given up: no run of the job could finish it */
export const LINE_WEBHOOK_GAVE_UP = 'GAVE_UP'

const ROW = { id: true, organizationId: true, webhookEventId: true, type: true, payload: true, receivedAt: true } as const

function recorded(row: { id: string; organizationId: string; webhookEventId: string; type: string; payload: unknown; receivedAt: Date }): RecordedLineEvent {
  return { ...row, payload: StoredLineEvent.parse(row.payload) }
}

/**
 * Writes one row per event that was not recorded before, in the order LINE sent them. Events whose webhookEventId the
 * organization already has (a redelivery, a resent body, a concurrent delivery) write nothing: their webhookEventIds come
 * back as duplicates, for the caller to recover any that were dropped.
 */
export async function recordLineWebhookEvents(
  organizationId: string,
  channelKey: string,
  events: readonly ParsedLineEvent[],
  receivedAt: Date,
  /** S17-06 (BR-LINE-11): the organization asks through the chat, so the text of a new text message waits in LineInboundMessage */
  options: { readonly keepChatText?: boolean } = {},
): Promise<{ readonly recorded: readonly RecordedLineEvent[]; readonly duplicates: readonly string[] }> {
  if (events.length === 0) return { recorded: [], duplicates: [] }
  const rows = events.map((e) => ({
    id: newId(),
    organizationId,
    webhookEventId: e.webhookEventId,
    channelKey,
    type: e.type,
    payload: e.payload,
    receivedAt,
    status: 'RECEIVED' as const,
  }))
  // INSERT … ON CONFLICT DO NOTHING RETURNING: only the rows this request inserted come back. The text of their messages
  // in the same transaction, so a message is never processed without its text (a redelivery inserts neither)
  const mine = await forTenant(organizationId).$transaction(async (tx) => {
    const inserted = new Set((await tx.lineWebhookEvent.createManyAndReturn({ data: rows, skipDuplicates: true, select: { id: true } })).map((r) => r.id))
    if (options.keepChatText) {
      const inbound = rows.flatMap((r, i) => {
        const message = events[i]!.inbound
        // A text waits for its processing; an image needs no row (its id is in the event, its content is fetched from LINE)
        return message?.kind === 'TEXT' && inserted.has(r.id) ? [{ organizationId, lineWebhookEventId: r.id, lineMessageId: message.lineMessageId, kind: message.kind, text: message.text, receivedAt }] : []
      })
      if (inbound.length) await tx.lineInboundMessage.createMany({ data: inbound })
    }
    return inserted
  })
  return {
    recorded: rows.filter((r) => mine.has(r.id)).map((r) => recorded(r)),
    duplicates: [...new Set(rows.filter((r) => !mine.has(r.id)).map((r) => r.webhookEventId))],
  }
}

/** Outbox rows that start runs of the job for these ids (in order), LINE_WEBHOOK_JOB_MAX_EVENTS ids per run */
async function enqueueRuns(tx: TenantTx, organizationId: string, eventIds: readonly string[], extra: Omit<LineWebhookQueuePayload, 'organizationId' | 'eventIds'>): Promise<string[]> {
  const drafts = []
  for (let at = 0; at < eventIds.length; at += LINE_WEBHOOK_JOB_MAX_EVENTS) {
    const payload: LineWebhookQueuePayload = { organizationId, eventIds: eventIds.slice(at, at + LINE_WEBHOOK_JOB_MAX_EVENTS), ...extra }
    drafts.push({ eventName: LINE_WEBHOOK_QUEUE_EVENT, payload })
  }
  return enqueueOutbox(tx, organizationId, drafts)
}

const inOrder = (ids: readonly string[], kept: ReadonlySet<string>) => ids.filter((id) => kept.has(id))

/**
 * Hands RECEIVED rows to the line-webhook job: QUEUED, and the outbox rows of `bcs/line.webhook_received` in the same
 * transaction, so the job is told even if Inngest cannot be reached now (the outbox-sweeper sends it then). `notBefore`
 * makes the job wait (an event among them is still running inline). Returns the ids it moved, in the given order, and the
 * outbox ids to send.
 */
export async function handOverLineWebhookEvents(
  organizationId: string,
  eventIds: readonly string[],
  options: { readonly notBefore?: Date; readonly error?: string } = {},
): Promise<{ readonly queued: readonly string[]; readonly outboxIds: readonly string[] }> {
  if (eventIds.length === 0) return { queued: [], outboxIds: [] }
  return forTenant(organizationId).$transaction(async (tx) => {
    const moved = await tx.lineWebhookEvent.updateManyAndReturn({
      where: { id: { in: [...eventIds] }, status: 'RECEIVED' },
      data: { status: 'QUEUED', error: options.error ?? null },
      select: { id: true },
    })
    const queued = inOrder(eventIds, new Set(moved.map((r) => r.id)))
    const outboxIds = await enqueueRuns(tx, organizationId, queued, options.notBefore ? { notBefore: options.notBefore.toISOString() } : {})
    return { queued, outboxIds }
  })
}

/** Another run of the job (number `round`, starting at `notBefore`) for the rows of these ids that are still QUEUED */
export async function requeueLineWebhookEvents(
  organizationId: string,
  eventIds: readonly string[],
  options: { readonly round: number; readonly notBefore: Date },
): Promise<{ readonly queued: readonly string[]; readonly outboxIds: readonly string[] }> {
  if (eventIds.length === 0) return { queued: [], outboxIds: [] }
  return forTenant(organizationId).$transaction(async (tx) => {
    const waiting = await tx.lineWebhookEvent.findMany({ where: { id: { in: [...eventIds] }, status: 'QUEUED' }, select: { id: true } })
    const queued = inOrder(eventIds, new Set(waiting.map((r) => r.id)))
    const outboxIds = await enqueueRuns(tx, organizationId, queued, { round: options.round, notBefore: options.notBefore.toISOString() })
    return { queued, outboxIds }
  })
}

/** Gives up the rows of these ids that are still QUEUED: FAILED, GAVE_UP. Returns their ids. */
export async function giveUpLineWebhookEvents(organizationId: string, eventIds: readonly string[], now: Date): Promise<readonly string[]> {
  if (eventIds.length === 0) return []
  const given = await forTenant(organizationId).lineWebhookEvent.updateManyAndReturn({
    where: { id: { in: [...eventIds] }, status: 'QUEUED' },
    data: { status: 'FAILED', error: LINE_WEBHOOK_GAVE_UP, processedAt: now },
    select: { id: true },
  })
  return inOrder(eventIds, new Set(given.map((r) => r.id)))
}

export interface RecoveredLineWebhookEvents {
  /** RECEIVED rows their request dropped, now QUEUED for the job (error RECOVERED) */
  readonly handedOver: readonly string[]
  readonly outboxIds: readonly string[]
  /** QUEUED rows no run of the job finished in LINE_WEBHOOK_QUEUED_GIVE_UP_MS: FAILED, GAVE_UP */
  readonly gaveUp: readonly string[]
}

/**
 * Rows of the organization that nothing will finish any more (see the top of this file), all of them or the ones of
 * these webhookEventIds (a redelivery): rows still waiting LINE_WEBHOOK_QUEUED_GIVE_UP_MS after they arrived are given
 * up; dropped RECEIVED rows younger than that are handed to the job, in the order they arrived. One transaction; a row
 * someone else moved meanwhile is left alone.
 */
export async function recoverStaleLineWebhookEvents(organizationId: string, now: Date, scope: { readonly webhookEventIds?: readonly string[] } = {}): Promise<RecoveredLineWebhookEvents> {
  if (scope.webhookEventIds && scope.webhookEventIds.length === 0) return { handedOver: [], outboxIds: [], gaveUp: [] }
  const which = scope.webhookEventIds ? { webhookEventId: { in: [...scope.webhookEventIds] } } : {}
  return forTenant(organizationId).$transaction(async (tx) => {
    // First what is too old to be worth doing: a day late, nobody waits for the answer any more (and an alert says so)
    const given = await tx.lineWebhookEvent.updateManyAndReturn({
      where: { ...which, status: { in: ['RECEIVED', 'QUEUED'] }, receivedAt: { lt: new Date(now.getTime() - LINE_WEBHOOK_QUEUED_GIVE_UP_MS) } },
      data: { status: 'FAILED', error: LINE_WEBHOOK_GAVE_UP, processedAt: now },
      select: { id: true },
    })
    const dropped = await tx.lineWebhookEvent.updateManyAndReturn({
      where: { ...which, status: 'RECEIVED', receivedAt: { lt: new Date(now.getTime() - LINE_WEBHOOK_REQUEST_ENDED_MS) } },
      data: { status: 'QUEUED', error: LINE_WEBHOOK_RECOVERED },
      select: { id: true, receivedAt: true },
    })
    // The order LINE sent them in: by arrival, and by id within one delivery (ids are made in order, UUID v7)
    const handedOver = dropped.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => r.id)
    const outboxIds = await enqueueRuns(tx, organizationId, handedOver, {})
    return { handedOver, outboxIds, gaveUp: given.map((r) => r.id) }
  })
}

/** Rows of these ids that wait for the job (QUEUED), in the given order */
export async function loadQueuedLineWebhookEvents(organizationId: string, eventIds: readonly string[]): Promise<readonly RecordedLineEvent[]> {
  if (eventIds.length === 0) return []
  const rows = await forTenant(organizationId).lineWebhookEvent.findMany({ where: { id: { in: [...eventIds] }, status: 'QUEUED' }, select: ROW })
  const byId = new Map(rows.map((r) => [r.id, r]))
  return eventIds.flatMap((id) => {
    const row = byId.get(id)
    return row ? [recorded(row)] : []
  })
}

/**
 * Records how processing ended, if the row is still in one of the statuses `from` (inline: RECEIVED, or QUEUED when it
 * was handed over while still running; the job: QUEUED). False when someone else finished it first.
 */
export async function finishLineWebhookEvent(
  organizationId: string,
  eventId: string,
  from: readonly ('RECEIVED' | 'QUEUED')[],
  outcome: LineEventOutcome,
  finishedAt: Date,
): Promise<boolean> {
  const done = await forTenant(organizationId).lineWebhookEvent.updateMany({
    where: { id: eventId, status: { in: [...from] } },
    data: { status: outcome.status, processedAt: finishedAt, error: outcome.reason ?? null },
  })
  return done.count === 1
}

/**
 * Deletes the text the webhook kept for one message nobody will take (S17-06 · BR-LINE-11): the organization stopped
 * asking through the chat, or the sender is linked to nobody. Bookkeeping like the event row itself, so no command.
 */
export async function discardLineInboundText(organizationId: string, eventId: string): Promise<void> {
  await forTenant(organizationId).lineInboundMessage.deleteMany({ where: { lineWebhookEventId: eventId } })
}

/** Deletes the text of messages received before `before` that nothing processed (BR-LINE-11: 24 hours at most) */
export async function deleteStaleLineInboundTexts(organizationId: string, before: Date): Promise<number> {
  return (await forTenant(organizationId).lineInboundMessage.deleteMany({ where: { receivedAt: { lt: before } } })).count
}
