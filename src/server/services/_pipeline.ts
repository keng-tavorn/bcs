import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { err, isErrorCode, ok, type AppError, type Result } from '@/core/result'
import { systemClock } from '@/lib/clock'
import {
  COMMAND_BUSY_ERROR_CODES,
  COMMAND_BUSY_RETRIES,
  COMMAND_TX_MAX_WAIT_MS,
  COMMAND_TX_TIMEOUT_MS,
  RETRYABLE_TX_ERROR_CODES,
} from '@/lib/constants'
import { stableStringify, toJsonSafe, type Jsonified, type JsonValue } from '@/lib/json'
import { logger } from '@/lib/logger'
import type { Actor, Ctx } from '@/server/context'
import { lockIdempotencyKey } from '@/server/db/sql/locks'
import { setTransactionTimeouts } from '@/server/db/sql/timeouts'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { describeError } from '@/server/errors/describe'
import { appendEvents, type AppendedEvent, type EventDraft } from '@/server/events/append'
import { dispatchOutbox, enqueueOutbox, getDefaultOutboxSender, type OutboxDraft, type OutboxSender } from '@/server/events/outbox'
import '@/server/inngest'
import { createNotifications, type NotificationDraft } from '@/server/notifications/create'
import { applyTokenLifecycle } from '@/server/tokens/action-tokens'

// runCommand() — the only path for a state change (spec §4.3, P-1, ADR-022):
//  1. the adapter supplies an idempotencyKey; CommandLog stores it inside the actor's namespace (scopedIdempotencyKey)
//  2. Zod validation → VALIDATION_FAILED (also when a transform throws)
//  3. ctx (tenant, actor, channel, requestId, now)
//  4. one interactive transaction (Read Committed) with bounded lock and statement waits: idempotency lock +
//     CommandLog check → execute() inside a savepoint (load with FOR UPDATE in id order, version check,
//     authorize + SoD, core decide, write state) → Event (≥ 1, INV-EVT-02) + Outbox + Notification + CommandLog.
//     A rejection rolls back to the savepoint. A rejection that carries audit events writes them and is recorded
//     in CommandLog, so a resend with the same key replays it instead of auditing twice (INV-PLT-01). Approval
//     task events issue and revoke the tasks' ActionTokens in the same transaction (BR-TOK-01).
//  5. commit, then send the outbox with one request, holding the response at most OUTBOX_DISPATCH_TIMEOUT_MS (the
//     outbox-sweeper sends whatever is not confirmed by then)
//  6. serialization failure / deadlock → retry the whole transaction up to 3 times with jitter; lock or statement
//     timeout, or no free pooled connection → retry COMMAND_BUSY_RETRIES times, then RATE_LIMITED
// An unexpected error is answered INTERNAL with the requestId only; the log gets describeError(): codes and stack
// frames with organizationId, never the error text, which can quote personal data (FR-PLT-008 AC3).

export interface CommandSuccess<R> {
  readonly ok: true
  /** Stored in CommandLog; callers receive Jsonified<R> (bigint, Date and Decimal as strings), on replays too */
  readonly result: R
  readonly events: readonly EventDraft[]
  readonly notifications?: readonly NotificationDraft[]
  readonly outbox?: readonly OutboxDraft[]
}

export interface CommandFailure {
  readonly ok: false
  readonly error: AppError
  /** Security/audit events that persist although the command's own writes are rolled back (e.g. SoD blocked) */
  readonly auditEvents?: readonly EventDraft[]
}

export type CommandOutcome<R> = CommandSuccess<R> | CommandFailure

export interface CommandDefinition<I, R> {
  readonly name: string
  /** Capability of spec §2.4 that execute() checks; declared so verify can audit every command */
  readonly capability: string
  readonly input: z.ZodType<I>
  execute(tx: TenantTx, input: I, ctx: Ctx): Promise<CommandOutcome<R>>
}

export function defineCommand<I, R>(definition: CommandDefinition<I, R>): CommandDefinition<I, R> {
  return definition
}

export interface RunOptions {
  readonly idempotencyKey: string
  /** Outbox sender override (tests); defaults to the Inngest sender; null sends nothing now (the sweeper will) */
  readonly sender?: OutboxSender | null
  /** Demo-history seed: write outbox rows as suppressed so nothing is sent for the past */
  readonly suppressOutbox?: boolean
  readonly maxRetries?: number
}

const NAMESPACES: Readonly<Record<Actor['type'], string>> = { USER: 'u', SYSTEM: 'sys', PLATFORM_ADMIN: 'pa', AI_AGENT: 'ai', SUPPLIER: 'sup' }

/** Who sent the command, within its actor type: a SYSTEM actor without a job name has the empty identity. */
function actorIdentity(actor: Actor): string {
  switch (actor.type) {
    case 'USER':
      return actor.memberId
    case 'SYSTEM':
      return actor.job ?? ''
    case 'PLATFORM_ADMIN':
      return actor.platformAdminId
    case 'AI_AGENT':
      return actor.agentId
    case 'SUPPLIER':
      return actor.supplierContactId
  }
}

/**
 * The key stored in CommandLog: the adapter's idempotencyKey inside the namespace of the actor that sent it,
 * `<type>:<length of the identity>:<identity>:<key>` (u: member, sys: job, pa: platform admin, ai: agent,
 * sup: supplier contact). One actor can therefore neither claim another actor's key in advance (job keys
 * `<functionId>:<stepId>:<subjectId>` are predictable) nor receive another actor's stored result on a replay.
 * The length prefix keeps the encoding injective although identities and keys may contain ":" — without it
 * agent "a:b" with key "c" and agent "a" with key "b:c" would share one stored key.
 */
export function scopedIdempotencyKey(actor: Actor, idempotencyKey: string): string {
  const identity = actorIdentity(actor)
  return `${NAMESPACES[actor.type]}:${identity.length}:${identity}:${idempotencyKey}`
}

/** What CommandLog.result holds: the Result of the first run, returned unchanged on every replay. */
type StoredResult = { readonly ok: true; readonly data: JsonValue } | { readonly ok: false; readonly error: AppError }

type TxOutcome =
  | { kind: 'done'; result: StoredResult; outboxIds: string[] }
  | { kind: 'replay'; result: StoredResult }
  | { kind: 'conflict' }
  | { kind: 'rejected'; error: AppError }

class CommandRejected extends Error {
  constructor(readonly failure: CommandFailure) {
    super(failure.error.code)
  }
}

/** Prisma codes and SQLSTATEs on an error, its cause chain, and the driver error Prisma wraps in meta. */
function errorCodes(error: unknown): string[] {
  const codes: string[] = []
  let current: unknown = error
  for (let depth = 0; current && typeof current === 'object' && depth < 6; depth++) {
    const e = current as {
      code?: unknown
      meta?: { code?: unknown; driverAdapterError?: { cause?: { code?: unknown; originalCode?: unknown } } }
      cause?: unknown
    }
    const cause = e.meta?.driverAdapterError?.cause
    for (const code of [e.code, e.meta?.code, cause?.code, cause?.originalCode]) if (typeof code === 'string') codes.push(code)
    current = e.cause
  }
  return codes
}

function errorMessages(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current && typeof current === 'object' && depth < 6; depth++) {
    const message = (current as { message?: unknown }).message
    if (typeof message === 'string') parts.push(message)
    current = (current as { cause?: unknown }).cause
  }
  return parts.join('\n')
}

export function isRetryableTxError(error: unknown): boolean {
  if (errorCodes(error).some((code) => RETRYABLE_TX_ERROR_CODES.has(code))) return true
  return /deadlock detected|could not serialize access|write conflict/i.test(errorMessages(error))
}

// The texts of "no free pooled connection": pg's pool acquire timeout (DB_POOL_ACQUIRE_TIMEOUT_MS) and Prisma's
// transaction maxWait (P2028 also covers other transaction API errors, so only this message counts)
const BUSY_MESSAGES = /canceling statement due to (?:lock|statement) timeout|timeout exceeded when trying to connect|unable to start a transaction in the given time/i

/**
 * lock_timeout or statement_timeout fired (SET LOCAL by setTransactionTimeouts), or no pooled connection became
 * free in time (duplicates waiting on a lock hold connections): the item or the database is busy, not broken.
 */
export function isBusyTxError(error: unknown): boolean {
  if (errorCodes(error).some((code) => COMMAND_BUSY_ERROR_CODES.has(code))) return true
  return BUSY_MESSAGES.test(errorMessages(error))
}

function hashInput(name: string, input: unknown): string {
  return createHash('sha256').update(stableStringify({ command: name, input })).digest('hex')
}

function validationError(issues: readonly z.core.$ZodIssue[]): AppError {
  const first = issues[0]
  const field = first?.path.length ? first.path.join('.') : '(input)'
  return {
    code: 'VALIDATION_FAILED',
    message: `invalid input at ${field}: ${first?.message ?? ''}`,
    details: { field, issues: issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
  }
}

/** The error as callers receive it, on the first run and on every replay alike (details made JSON-safe). */
function jsonSafeError(error: AppError): AppError {
  return error.details === undefined ? { code: error.code, message: error.message } : (toJsonSafe(error) as unknown as AppError)
}

function readStoredResult(value: unknown): StoredResult {
  const v = value as { ok?: unknown; data?: unknown; error?: { code?: unknown } } | null
  if (v && v.ok === true && 'data' in v) return { ok: true, data: v.data as JsonValue }
  if (v && v.ok === false && typeof v.error?.code === 'string' && isErrorCode(v.error.code)) return { ok: false, error: v.error as AppError }
  throw new Error('CommandLog.result does not hold a stored Result')
}

function fromStored<R>(stored: StoredResult): Result<Jsonified<R>> {
  return stored.ok ? ok(stored.data as Jsonified<R>) : { ok: false, error: stored.error }
}

/** One payload shape for every event sent to Inngest, whether the command succeeded or was rejected. */
function eventOutboxDraft(ctx: Ctx, e: AppendedEvent): OutboxDraft {
  return {
    eventName: `bcs/${e.type}`,
    payload: {
      eventId: e.id,
      organizationId: ctx.organizationId,
      type: e.type,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      occurredAt: e.occurredAt,
      correlationId: ctx.correlationId,
      data: e.data,
    },
  }
}

/** Runs execute() in a savepoint: a rejection rolls back everything it wrote (and recovers a failed statement). */
async function executeInSavepoint<I, R>(tx: TenantTx, definition: CommandDefinition<I, R>, input: I, ctx: Ctx): Promise<CommandOutcome<R>> {
  try {
    return await tx.$transaction(async (savepoint) => {
      const out = await definition.execute(savepoint, input, ctx)
      if (!out.ok) throw new CommandRejected(out)
      return out
    })
  } catch (error) {
    if (error instanceof CommandRejected) return error.failure
    throw error
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const jitter = (attempt: number) => 20 + Math.floor(Math.random() * 80) * attempt

export async function runCommand<I, R>(
  ctx: Ctx,
  definition: CommandDefinition<I, R>,
  rawInput: unknown,
  options: RunOptions,
): Promise<Result<Jsonified<R>>> {
  const log = logger.child({
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
    organizationId: ctx.organizationId,
    command: definition.name,
  })
  if (!options.idempotencyKey) return err('VALIDATION_FAILED', 'idempotencyKey is required', { field: 'idempotencyKey' })
  let parsed: z.ZodSafeParseResult<I>
  try {
    parsed = await definition.input.safeParseAsync(rawInput)
  } catch (error) {
    // Zod does not catch exceptions thrown inside .transform(): still invalid input, not a crash (§14.1). The
    // thrown text may quote the input, so only its description is logged.
    log.warn({ error: describeError(error) }, 'input schema threw while parsing; reported as VALIDATION_FAILED')
    return err('VALIDATION_FAILED', 'invalid input', { field: '(input)' })
  }
  if (!parsed.success) return { ok: false, error: validationError(parsed.error.issues) }
  const input = parsed.data
  const inputHash = hashInput(definition.name, input)
  const key = scopedIdempotencyKey(ctx.actor, options.idempotencyKey)
  const suppressed = options.suppressOutbox ?? false
  const db = forTenant(ctx.organizationId)
  const maxRetries = options.maxRetries ?? 3

  let outcome: TxOutcome | undefined
  for (let retries = 0, busyRetries = 0; outcome === undefined; ) {
    try {
      outcome = await db.$transaction(
        async (tx): Promise<TxOutcome> => {
          await setTransactionTimeouts(tx)
          await lockIdempotencyKey(tx, ctx.organizationId, key)
          const prior = await tx.commandLog.findUnique({
            where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } },
          })
          if (prior) return prior.inputHash === inputHash ? { kind: 'replay', result: readStoredResult(prior.result) } : { kind: 'conflict' }

          const out = await executeInSavepoint(tx, definition, input, ctx)
          let result: StoredResult
          let drafts: OutboxDraft[]
          if (!out.ok) {
            // A plain rejection wrote nothing and is not recorded: a resend runs again.
            if (!out.auditEvents?.length) return { kind: 'rejected', error: jsonSafeError(out.error) }
            // A rejection with audit events is recorded and replayed for its key (INV-PLT-01). A corrected
            // resubmit with the same key is the same key with different input, so it gets IDEMPOTENCY_CONFLICT
            // (FR-PLT-012 AC2): forms must use a new idempotencyKey for every submission, not one per form.
            const audit = await appendEvents(tx, ctx, out.auditEvents)
            drafts = audit.map((e) => eventOutboxDraft(ctx, e))
            result = { ok: false, error: jsonSafeError(out.error) }
          } else {
            if (out.events.length === 0) {
              throw new Error(`INV-EVT-02: command ${definition.name} changed state without writing an Event`)
            }
            const events = await appendEvents(tx, ctx, out.events)
            // Loaded when used: the subject registry imports services that are built on this pipeline
            await applyTokenLifecycle(tx, ctx, out.events, (t, type, id) => import('./approvals/subjects').then((m) => m.outsideChannels(t, type, id)))
            const notificationOutbox = await createNotifications(tx, ctx.organizationId, out.notifications ?? [])
            drafts = [...events.map((e) => eventOutboxDraft(ctx, e)), ...notificationOutbox, ...(out.outbox ?? [])]
            result = { ok: true, data: toJsonSafe(out.result) }
          }
          const outboxIds = await enqueueOutbox(tx, ctx.organizationId, drafts, { suppressed })
          await tx.commandLog.create({
            data: { organizationId: ctx.organizationId, idempotencyKey: key, commandName: definition.name, inputHash, result: result as object },
          })
          return { kind: 'done', result, outboxIds }
        },
        { isolationLevel: 'ReadCommitted', maxWait: COMMAND_TX_MAX_WAIT_MS, timeout: COMMAND_TX_TIMEOUT_MS },
      )
    } catch (error) {
      if (isRetryableTxError(error) && retries < maxRetries) {
        retries++
        await sleep(jitter(retries))
        continue
      }
      if (isBusyTxError(error)) {
        if (busyRetries < COMMAND_BUSY_RETRIES) {
          busyRetries++
          await sleep(jitter(busyRetries))
          continue
        }
        log.warn({ error: describeError(error) }, 'command gave up waiting for a lock, a slow statement or a database connection')
        return err('RATE_LIMITED', 'busy: the item is in use by another command; try again shortly', { requestId: ctx.requestId })
      }
      // The caller gets only a reference (spec §14.2); the error collector gets codes and stack frames with
      // organizationId and the request ids, never the error text, which can quote personal data (FR-PLT-008 AC3).
      log.error({ error: describeError(error) }, 'command failed unexpectedly')
      return err('INTERNAL', 'unexpected error', { requestId: ctx.requestId })
    }
  }

  // The transaction has ended: nothing below may report a committed command as failed.
  switch (outcome.kind) {
    case 'conflict':
      return err('IDEMPOTENCY_CONFLICT', 'idempotency key reused with different input', { idempotencyKey: options.idempotencyKey })
    case 'rejected':
      return { ok: false, error: outcome.error }
    case 'replay':
      return fromStored<R>(outcome.result)
    case 'done':
      if (outcome.outboxIds.length > 0) {
        try {
          const sender = options.sender === undefined ? getDefaultOutboxSender() : options.sender
          // Relay bookkeeping (sentAt, nextAttemptAt) uses real time, never business time (ctx.now)
          await dispatchOutbox(outcome.outboxIds, sender, systemClock.now(), { log })
        } catch (error) {
          log.warn({ error: describeError(error) }, 'outbox dispatch after commit failed; the outbox-sweeper will send it')
        }
      }
      return fromStored<R>(outcome.result)
  }
}
