import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { err, ok, type AppError, type Result } from '@/core/result'
import { COMMAND_TX_MAX_WAIT_MS, COMMAND_TX_TIMEOUT_MS, RETRYABLE_TX_ERROR_CODES } from '@/lib/constants'
import { stableStringify, toJsonSafe, type JsonValue } from '@/lib/json'
import { logger } from '@/lib/logger'
import type { Ctx } from '@/server/context'
import { lockIdempotencyKey } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { appendEvents, type EventDraft } from '@/server/events/append'
import { dispatchOutbox, enqueueOutbox, getDefaultOutboxSender, type OutboxDraft, type OutboxSender } from '@/server/events/outbox'
import '@/server/inngest'
import { createNotifications, type NotificationDraft } from '@/server/notifications/create'

// runCommand() — the only path for a state change (spec §4.3, P-1, ADR-022):
//  1. the adapter supplies an idempotencyKey   2. Zod validation → VALIDATION_FAILED
//  3. ctx (tenant, actor, channel, requestId, now)
//  4. one interactive transaction (Read Committed): idempotency lock + CommandLog check → execute
//     (load with FOR UPDATE in id order, version check, authorize + SoD, core decide, write state) →
//     Event (≥ 1, INV-EVT-02) + Outbox + Notification + CommandLog
//  5. commit, then best-effort send of the outbox (outbox-sweeper retries)
//  6. serialization failure / deadlock → retry the whole transaction up to 3 times with jitter

export interface CommandSuccess<R> {
  readonly ok: true
  /** JSON-safe DTO; stored in CommandLog and returned unchanged on a replay */
  readonly result: R
  readonly events: readonly EventDraft[]
  readonly notifications?: readonly NotificationDraft[]
  readonly outbox?: readonly OutboxDraft[]
}

export interface CommandFailure {
  readonly ok: false
  readonly error: AppError
  /** Security/audit events that must persist even though the command is rolled back (e.g. SoD blocked) */
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
  /** Outbox sender override (tests); defaults to the Inngest sender */
  readonly sender?: OutboxSender | null
  /** Demo-history seed: write outbox rows as suppressed so nothing is sent for the past */
  readonly suppressOutbox?: boolean
  readonly maxRetries?: number
}

class CommandRejected extends Error {
  constructor(readonly failure: CommandFailure) {
    super(failure.error.code)
  }
}

type TxOutcome =
  | { kind: 'done'; result: JsonValue; outboxIds: string[] }
  | { kind: 'replay'; result: JsonValue }
  | { kind: 'conflict' }

export function isRetryableTxError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current && depth < 6; depth++) {
    const e = current as { code?: unknown; meta?: { code?: unknown }; cause?: unknown; message?: unknown }
    if (typeof e.code === 'string' && RETRYABLE_TX_ERROR_CODES.has(e.code)) return true
    if (typeof e.meta?.code === 'string' && RETRYABLE_TX_ERROR_CODES.has(e.meta.code)) return true
    if (typeof e.message === 'string' && /deadlock detected|could not serialize access|write conflict/i.test(e.message)) return true
    current = e.cause
  }
  return false
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function runCommand<I, R>(
  ctx: Ctx,
  definition: CommandDefinition<I, R>,
  rawInput: unknown,
  options: RunOptions,
): Promise<Result<R>> {
  const log = logger.child({
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
    organizationId: ctx.organizationId,
    command: definition.name,
  })
  if (!options.idempotencyKey) return err('VALIDATION_FAILED', 'idempotencyKey is required', { field: 'idempotencyKey' })
  const parsed = definition.input.safeParse(rawInput)
  if (!parsed.success) {
    const e = validationError(parsed.error.issues)
    return { ok: false, error: e }
  }
  const input = parsed.data
  const inputHash = hashInput(definition.name, input)
  const db = forTenant(ctx.organizationId)
  const maxRetries = options.maxRetries ?? 3

  for (let attempt = 0; ; attempt++) {
    try {
      const outcome = await db.$transaction(
        async (tx): Promise<TxOutcome> => {
          await lockIdempotencyKey(tx, ctx.organizationId, options.idempotencyKey)
          const prior = await tx.commandLog.findUnique({
            where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: options.idempotencyKey } },
          })
          if (prior) return prior.inputHash === inputHash ? { kind: 'replay', result: prior.result as JsonValue } : { kind: 'conflict' }

          const out = await definition.execute(tx, input, ctx)
          if (!out.ok) throw new CommandRejected(out)
          if (out.events.length === 0) {
            throw new Error(`INV-EVT-02: command ${definition.name} changed state without writing an Event`)
          }
          const events = await appendEvents(tx, ctx, out.events)
          const notificationOutbox = await createNotifications(tx, ctx.organizationId, out.notifications ?? [])
          const outboxIds = await enqueueOutbox(
            tx,
            ctx.organizationId,
            [
              ...events.map((e) => ({
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
              })),
              ...notificationOutbox,
              ...(out.outbox ?? []),
            ],
            { suppressed: options.suppressOutbox ?? false },
          )
          const result = toJsonSafe(out.result)
          await tx.commandLog.create({
            data: {
              organizationId: ctx.organizationId,
              idempotencyKey: options.idempotencyKey,
              commandName: definition.name,
              inputHash,
              result: result as object,
            },
          })
          return { kind: 'done', result, outboxIds }
        },
        { isolationLevel: 'ReadCommitted', maxWait: COMMAND_TX_MAX_WAIT_MS, timeout: COMMAND_TX_TIMEOUT_MS },
      )

      if (outcome.kind === 'conflict') {
        return err('IDEMPOTENCY_CONFLICT', 'idempotency key reused with different input', { idempotencyKey: options.idempotencyKey })
      }
      if (outcome.kind === 'done') {
        const sender = options.sender === undefined ? getDefaultOutboxSender() : options.sender
        await dispatchOutbox(outcome.outboxIds, sender, ctx.now)
      }
      return ok(outcome.result as R)
    } catch (error) {
      if (error instanceof CommandRejected) {
        const { failure } = error
        if (failure.auditEvents?.length) await persistAuditEvents(ctx, failure.auditEvents, options, log)
        return { ok: false, error: failure.error }
      }
      if (isRetryableTxError(error) && attempt < maxRetries) {
        await sleep(20 + Math.floor(Math.random() * 80) * (attempt + 1))
        continue
      }
      log.error({ err: error }, 'command failed unexpectedly')
      return err('INTERNAL', (error as Error).message, { requestId: ctx.requestId })
    }
  }
}

async function persistAuditEvents(
  ctx: Ctx,
  drafts: readonly EventDraft[],
  options: RunOptions,
  log: { error(obj: object, msg?: string): void },
): Promise<void> {
  try {
    const ids = await forTenant(ctx.organizationId).$transaction(async (tx) => {
      const events = await appendEvents(tx, ctx, drafts)
      return enqueueOutbox(
        tx,
        ctx.organizationId,
        events.map((e) => ({ eventName: `bcs/${e.type}`, payload: { eventId: e.id, organizationId: ctx.organizationId, type: e.type, data: e.data } })),
        { suppressed: options.suppressOutbox ?? false },
      )
    })
    const sender = options.sender === undefined ? getDefaultOutboxSender() : options.sender
    await dispatchOutbox(ids, sender, ctx.now)
  } catch (error) {
    log.error({ err: error }, 'could not persist audit events of a rejected command')
  }
}
