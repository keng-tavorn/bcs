import {
  OUTBOX_CLAIM_LEASE_MS,
  OUTBOX_DISPATCH_SEND_TIMEOUT_MS,
  OUTBOX_DISPATCH_TIMEOUT_MS,
  OUTBOX_LAST_ERROR_MAX_LENGTH,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETRY_BASE_MS,
  OUTBOX_RETRY_MAX_MS,
  OUTBOX_STALL_ALERT_AFTER_MS,
  OUTBOX_SWEEP_AFTER_MS,
  OUTBOX_SWEEP_BATCH_SIZE,
  OUTBOX_SWEEP_BUDGET_MS,
  OUTBOX_SWEEP_SEND_TIMEOUT_MS,
  OUTBOX_UNAVAILABLE_RETRY_MS,
} from '@/lib/constants'
import { newId } from '@/lib/ids'
import { toJsonSafe, type JsonValue } from '@/lib/json'
import { logger, scrubText } from '@/lib/logger'
import { claimDueOutboxRows, recordOutboxRefusal, type ClaimedOutboxRow } from '@/server/db/sql/outbox'
import { systemDb } from '@/server/db/system'
import type { TenantTx } from '@/server/db/tenant'

// Transactional outbox (ADR-030, spec §4.3 step 5). Rows are written in the same transaction as the state
// change; after commit they are sent to Inngest best-effort with Outbox.id as the Inngest event id, so a
// re-send is de-duplicated. Rows not sent then are sent by the outbox-sweeper job every minute.
// Relay bookkeeping (sentAt, nextAttemptAt, deadAt) uses real time, like createdAt — never business time.
//
// Outbox.attempts counts refusals only: Inngest refused the message when it was sent alone. A row dies (deadAt,
// alert) after OUTBOX_MAX_ATTEMPTS refusals. A send that fails without blaming the message — Inngest unavailable,
// no answer, a failure on the request path — records lastError and is due again after OUTBOX_UNAVAILABLE_RETRY_MS
// without counting, so an outage never kills a row (FR-PLT-012 AC3, NFR-OBS-02).

export interface OutboxDraft {
  readonly eventName: string
  readonly payload: Record<string, unknown>
}

export interface OutboxMessage {
  readonly id: string
  readonly name: string
  readonly data: JsonValue
}

export interface OutboxSendOptions {
  /** Aborted when the caller stops waiting; a sender should end its requests then */
  readonly signal?: AbortSignal
}

/**
 * Sends one batch with one attempt (retries are the relay's job). A failure is told apart by what it throws:
 * - OutboxUnavailableError: Inngest takes nothing, whatever the content (cannot connect, key or URL problem,
 *   rate limit). The sweep stops at once.
 * - OutboxUncertainError: no verdict on the messages (5xx, no answer in time, connection lost mid-request):
 *   Inngest is in trouble, or a message in the batch breaks it. The sweeper tells the two apart with control sends.
 * - anything else (OutboxRefusedError for the Inngest sender): Inngest refused the messages; the batch is split
 *   to find the bad one.
 */
export type OutboxSender = (messages: readonly OutboxMessage[], options?: OutboxSendOptions) => Promise<void>

export class OutboxUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OutboxUnavailableError'
  }
}

export class OutboxUncertainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OutboxUncertainError'
  }
}

export class OutboxRefusedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OutboxRefusedError'
  }
}

let defaultSender: OutboxSender | null = null

/** Tests install a fake; the app installs the Inngest sender (src/server/inngest.ts). */
export function setDefaultOutboxSender(sender: OutboxSender | null): void {
  defaultSender = sender
}

export function getDefaultOutboxSender(): OutboxSender | null {
  return defaultSender
}

export async function enqueueOutbox(
  tx: TenantTx,
  organizationId: string,
  drafts: readonly OutboxDraft[],
  options: { suppressed?: boolean } = {},
): Promise<string[]> {
  if (drafts.length === 0) return []
  const rows = drafts.map((d) => ({
    id: newId(),
    organizationId,
    eventName: d.eventName,
    payload: toJsonSafe(d.payload) as object,
    suppressed: options.suppressed ?? false,
  }))
  await tx.outbox.createMany({ data: rows })
  return options.suppressed ? [] : rows.map((r) => r.id)
}

/** Text for Outbox.lastError (scrubbed like a log line, NFR-SEC-09); never throws, whatever was thrown. */
export function describeSendError(error: unknown): string {
  let text: string
  try {
    if (error instanceof Error) text = typeof error.message === 'string' ? error.message : String(JSON.stringify(error.message))
    else if (typeof error === 'string') text = error
    else text = JSON.stringify(error) ?? String(error)
  } catch {
    text = 'unprintable error'
  }
  return scrubText(text).slice(0, OUTBOX_LAST_ERROR_MAX_LENGTH)
}

interface SendableRow {
  readonly id: string
  readonly eventName: string
  readonly payload: unknown
}

type FailureKind = 'refused' | 'unavailable' | 'uncertain'
type SendOutcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown; readonly kind: FailureKind }

function failureKind(error: unknown): FailureKind {
  if (error instanceof OutboxUnavailableError) return 'unavailable'
  if (error instanceof OutboxUncertainError) return 'uncertain'
  return 'refused'
}

/** One sender call that gives up after timeoutMs (and aborts the sender's request). Never throws. */
async function sendWithin(sender: OutboxSender, rows: readonly SendableRow[], timeoutMs: number): Promise<SendOutcome> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new OutboxUncertainError(`no answer from Inngest within ${timeoutMs} ms`)
      controller.abort(reason)
      reject(reason)
    }, timeoutMs)
  })
  const messages = rows.map((r) => ({ id: r.id, name: r.eventName, data: r.payload as JsonValue }))
  try {
    await Promise.race([Promise.resolve().then(() => sender(messages, { signal: controller.signal })), deadline])
    return { ok: true }
  } catch (error) {
    return { ok: false, error, kind: failureKind(error) }
  } finally {
    clearTimeout(timer)
  }
}

async function markSent(ids: readonly string[], now: Date): Promise<void> {
  if (ids.length === 0) return
  await systemDb.outbox.updateMany({ where: { id: { in: [...ids] }, sentAt: null }, data: { sentAt: now, nextAttemptAt: null } })
}

/** Counts a refusal of each row; returns how many died (an alert is logged for each, NFR-OBS-02). */
async function countRefusal(ids: readonly string[], error: unknown, now: Date): Promise<number> {
  const rows = await recordOutboxRefusal(systemDb, {
    ids,
    now,
    lastError: describeSendError(error),
    maxAttempts: OUTBOX_MAX_ATTEMPTS,
    retryBaseMs: OUTBOX_RETRY_BASE_MS,
    retryMaxMs: OUTBOX_RETRY_MAX_MS,
  })
  const dead = rows.filter((r) => r.dead)
  for (const row of dead) {
    logger.error(
      { alert: true, outboxId: row.id, organizationId: row.organizationId, eventName: row.eventName, attempts: row.attempts, err: error },
      'outbox message is dead: Inngest refused it on every attempt',
    )
  }
  return dead.length
}

/** A failed send that does not prove the rows at fault: the cause is kept, no attempt is counted, due again soon. */
async function retryLater(ids: readonly string[], error: unknown, now: Date): Promise<void> {
  if (ids.length === 0) return
  await systemDb.outbox.updateMany({
    where: { id: { in: [...ids] }, sentAt: null, deadAt: null },
    data: { lastError: describeSendError(error), nextAttemptAt: new Date(now.getTime() + OUTBOX_UNAVAILABLE_RETRY_MS) },
  })
}

/** Claimed rows that were not tried in this run are due again at once. */
async function releaseClaims(ids: readonly string[], now: Date): Promise<void> {
  if (ids.length === 0) return
  await systemDb.outbox.updateMany({ where: { id: { in: [...ids] }, sentAt: null, deadAt: null }, data: { nextAttemptAt: now } })
}

export interface DispatchResult {
  readonly sent: number
  readonly failed: number
  /** The bound was reached; anything not confirmed is left to the outbox-sweeper */
  readonly timedOut?: boolean
}

/**
 * Best-effort send right after commit (spec §4.3 step 5): one request, never retried on the request path. Never
 * throws, and returns within `timeoutMs` whatever Inngest or the database do; rows that were not confirmed stay
 * for the outbox-sweeper. Only a refusal of a message sent alone counts as its refusal.
 */
export async function dispatchOutbox(
  ids: readonly string[],
  sender: OutboxSender | null,
  now: Date,
  options: { timeoutMs?: number; sendTimeoutMs?: number; log?: Pick<typeof logger, 'warn'> } = {},
): Promise<DispatchResult> {
  if (!sender || ids.length === 0) return { sent: 0, failed: 0 }
  const timeoutMs = options.timeoutMs ?? OUTBOX_DISPATCH_TIMEOUT_MS
  const sendTimeoutMs = Math.min(options.sendTimeoutMs ?? OUTBOX_DISPATCH_SEND_TIMEOUT_MS, timeoutMs)
  const log = options.log ?? logger
  const work = (async (): Promise<DispatchResult> => {
    const rows = await systemDb.outbox.findMany({
      where: { id: { in: [...ids] }, sentAt: null, deadAt: null, suppressed: false },
      select: { id: true, eventName: true, payload: true },
    })
    if (rows.length === 0) return { sent: 0, failed: 0 }
    const outcome = await sendWithin(sender, rows, sendTimeoutMs)
    const rowIds = rows.map((r) => r.id)
    if (outcome.ok) {
      await markSent(rowIds, now)
      return { sent: rows.length, failed: 0 }
    }
    if (outcome.kind === 'refused' && rows.length === 1) await countRefusal(rowIds, outcome.error, now)
    else await retryLater(rowIds, outcome.error, now)
    log.warn({ err: outcome.error, count: rows.length }, 'outbox send after commit failed; the outbox-sweeper will retry')
    return { sent: 0, failed: rows.length }
  })().catch((error: unknown) => {
    log.warn({ err: error }, 'outbox dispatch after commit failed; the outbox-sweeper will retry')
    return { sent: 0, failed: ids.length }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<DispatchResult>((resolve) => {
    timer = setTimeout(() => resolve({ sent: 0, failed: ids.length, timedOut: true }), timeoutMs)
  })
  try {
    return await Promise.race([work, bound])
  } finally {
    clearTimeout(timer)
  }
}

export interface SweepOptions {
  readonly batchSize?: number
  /** Stop claiming and sending after this long (wall clock), below the 1-minute cron interval */
  readonly budgetMs?: number
  readonly sendTimeoutMs?: number
  readonly stallAlertAfterMs?: number
}

export interface SweepResult {
  readonly claimed: number
  readonly sent: number
  readonly failed: number
  readonly dead: number
  readonly stoppedBy: 'drained' | 'unavailable' | 'budget'
}

type Chunk = readonly ClaimedOutboxRow[]

interface Suspect {
  readonly row: ClaimedOutboxRow
  readonly error: unknown
}

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id)

/**
 * The evidence one sweeper run gathers about Inngest. A send without a verdict (OutboxUncertainError) blames
 * neither Inngest nor the messages until another send settles it:
 * - a batch of several messages that fails so is split in halves; when Inngest has not answered since the
 *   previous such failure, one message is first sent alone as a control;
 * - a message that fails so alone is a suspect: the next answer from Inngest (accepted or refused) shows Inngest
 *   is up, so each suspect counts a refusal; a second suspect before any answer means Inngest is in trouble;
 * - OutboxUnavailableError, or two suspects in a row, stops the run without counting anything.
 */
class SweepRun {
  claimed = 0
  sent = 0
  failed = 0
  dead = 0
  /** Refusals counted in this run: progress towards a verdict on a message, even when nothing was sent */
  counted = 0
  stoppedBy: SweepResult['stoppedBy'] = 'drained'
  lastError: unknown = undefined
  oldest: ClaimedOutboxRow | undefined = undefined
  /** Inngest answered a send in this run */
  answered = false
  /** Inngest answered a send since the last send without a verdict */
  answeredSinceUncertain = false
  /** Rows of sends without a verdict since Inngest last answered */
  readonly unanswered = new Set<string>()
  suspects: Suspect[] = []

  constructor(readonly now: Date) {}

  claim(rows: readonly ClaimedOutboxRow[]): void {
    this.claimed += rows.length
    for (const row of rows) if (!this.oldest || row.createdAt < this.oldest.createdAt) this.oldest = row
  }

  async delivered(chunk: Chunk): Promise<void> {
    await markSent(ids(chunk), this.now)
    this.sent += chunk.length
    await this.inngestAnswered()
  }

  async refused(chunk: Chunk, error: unknown): Promise<void> {
    await this.inngestAnswered()
    if (chunk.length === 1) await this.countRefusal([chunk[0]!], error)
  }

  /** A send without a verdict; returns false when it shows Inngest is in trouble (the run must stop). */
  uncertain(chunk: Chunk, error: unknown): boolean {
    this.answeredSinceUncertain = false
    for (const row of chunk) this.unanswered.add(row.id)
    if (chunk.length > 1) return true
    this.suspects.push({ row: chunk[0]!, error })
    return this.suspects.length < 2
  }

  /** Inngest answered: it is up, so every suspect's failure was its own. */
  private async inngestAnswered(): Promise<void> {
    this.answered = true
    this.answeredSinceUncertain = true
    this.unanswered.clear()
    const suspects = this.suspects
    this.suspects = []
    for (const s of suspects) await this.countRefusal([s.row], s.error)
  }

  private async countRefusal(rows: Chunk, error: unknown): Promise<void> {
    this.dead += await countRefusal(ids(rows), error, this.now)
    this.failed += rows.length
    this.counted += rows.length
  }

  /** Inngest is unavailable: rows of sends without an answer wait without counting, the rest are due again at once. */
  async stop(chunk: Chunk, error: unknown, queue: readonly Chunk[]): Promise<void> {
    this.stoppedBy = 'unavailable'
    this.lastError = error
    for (const row of chunk) this.unanswered.add(row.id)
    for (const s of this.suspects) await retryLater([s.row.id], s.error, this.now)
    const failedIds = new Set(this.unanswered)
    for (const s of this.suspects) failedIds.delete(s.row.id)
    await retryLater([...failedIds], error, this.now)
    this.failed += failedIds.size + this.suspects.length
    this.suspects = []
    await releaseClaims(
      queue.flat().filter((r) => !this.unanswered.has(r.id)).map((r) => r.id),
      this.now,
    )
  }

  /** End of the run: a suspect counts when Inngest answered in this run, otherwise it waits without counting. */
  async settleSuspects(): Promise<void> {
    const suspects = this.suspects
    this.suspects = []
    for (const s of suspects) {
      if (this.answered) await this.countRefusal([s.row], s.error)
      else {
        await retryLater([s.row.id], s.error, this.now)
        this.failed += 1
      }
    }
  }
}

function halves(chunk: Chunk): [Chunk, Chunk] {
  const half = Math.ceil(chunk.length / 2)
  return [chunk.slice(0, half), chunk.slice(half)]
}

/**
 * Job outbox-sweeper (FR-PLT-012 AC3): sends every due row — rows never tried again that are older than
 * OUTBOX_SWEEP_AFTER_MS, and retries whose nextAttemptAt has passed — batch after batch until none is due,
 * Inngest is unavailable, or the time budget is used. A failing batch is bisected (SweepRun) until the bad
 * messages are isolated, so one bad row never holds back the others, whether Inngest refuses it or fails on it.
 */
export async function sweepOutbox(sender: OutboxSender, now: Date, options: SweepOptions = {}): Promise<SweepResult> {
  const batchSize = options.batchSize ?? OUTBOX_SWEEP_BATCH_SIZE
  const budgetMs = options.budgetMs ?? OUTBOX_SWEEP_BUDGET_MS
  const sendTimeoutMs = options.sendTimeoutMs ?? OUTBOX_SWEEP_SEND_TIMEOUT_MS
  const stallAlertAfterMs = options.stallAlertAfterMs ?? OUTBOX_STALL_ALERT_AFTER_MS
  const started = performance.now()
  const overBudget = () => performance.now() - started >= budgetMs
  const cutoff = new Date(now.getTime() - OUTBOX_SWEEP_AFTER_MS)
  const leaseUntil = new Date(now.getTime() + OUTBOX_CLAIM_LEASE_MS)
  const run = new SweepRun(now)

  sweep: for (;;) {
    if (overBudget()) {
      run.stoppedBy = 'budget'
      break
    }
    const rows = await claimDueOutboxRows(systemDb, { now, cutoff, leaseUntil, limit: batchSize })
    if (rows.length === 0) break
    run.claim(rows)
    const queue: Chunk[] = [[...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))]
    while (queue.length > 0) {
      if (overBudget()) {
        run.stoppedBy = 'budget'
        await releaseClaims(ids(queue.flat()), now)
        break sweep
      }
      const chunk = queue.shift()!
      const outcome = await sendWithin(sender, chunk, sendTimeoutMs)
      if (outcome.ok) {
        await run.delivered(chunk)
        continue
      }
      run.lastError = outcome.error
      if (outcome.kind === 'refused') {
        await run.refused(chunk, outcome.error)
        if (chunk.length > 1) queue.push(...halves(chunk))
        continue
      }
      if (outcome.kind === 'uncertain') {
        const verified = run.answeredSinceUncertain
        if (run.uncertain(chunk, outcome.error)) {
          if (chunk.length > 1) {
            // Inngest answered since the last failure without a verdict: blame the batch and split it. Otherwise
            // first send one of its messages alone, as a control.
            if (verified) queue.push(...halves(chunk))
            else queue.unshift(chunk.slice(0, 1), chunk.slice(1))
          } else if (queue[0] && queue[0].length > 1) {
            // A message failed alone: the next send is a single message too, the control
            const next = queue.shift()!
            queue.unshift(next.slice(0, 1), next.slice(1))
          }
          continue
        }
      }
      await run.stop(chunk, outcome.error, queue)
      logger.warn({ err: outcome.error, claimed: run.claimed, sent: run.sent }, 'outbox-sweeper stopped: Inngest is unavailable')
      break sweep
    }
  }
  await run.settleSuspects()

  const result: SweepResult = { claimed: run.claimed, sent: run.sent, failed: run.failed, dead: run.dead, stoppedBy: run.stoppedBy }
  const oldest = run.oldest
  const waitedMs = oldest ? now.getTime() - oldest.createdAt.getTime() : 0
  if (oldest && run.sent === 0 && run.counted === 0 && waitedMs >= stallAlertAfterMs) {
    // NFR-OBS-02: nothing could be delivered and messages have waited too long — every tenant's events are stuck
    logger.error(
      {
        alert: true,
        outboxId: oldest.id,
        organizationId: oldest.organizationId,
        eventName: oldest.eventName,
        attempts: oldest.attempts,
        err: run.lastError,
        waitedMs,
        ...result,
      },
      'outbox is stalled: no message could be sent to Inngest for longer than the alert threshold',
    )
  } else if (run.stoppedBy === 'budget') {
    // NFR-OBS-02: a run that could not drain the due rows means a backlog is building up
    logger.warn({ ...result }, 'outbox-sweeper used its time budget before every due row was sent')
  } else if (run.claimed > 0) logger.info({ ...result }, 'outbox-sweeper run')
  return result
}
