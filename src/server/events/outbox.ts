import { OUTBOX_SWEEP_AFTER_MS } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { toJsonSafe, type JsonValue } from '@/lib/json'
import { logger } from '@/lib/logger'
import { systemDb } from '@/server/db/system'
import type { TenantTx } from '@/server/db/tenant'

// Transactional outbox (ADR-030, spec §4.3 step 5). Rows are written in the same transaction as the state
// change; after commit they are sent to Inngest best-effort with Outbox.id as the Inngest event id, so a
// re-send is de-duplicated. Rows that failed are re-sent by the outbox-sweeper job every minute.

export interface OutboxDraft {
  readonly eventName: string
  readonly payload: Record<string, unknown>
}

export interface OutboxMessage {
  readonly id: string
  readonly name: string
  readonly data: JsonValue
}

export type OutboxSender = (messages: readonly OutboxMessage[]) => Promise<void>

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

async function sendRows(rows: Array<{ id: string; eventName: string; payload: unknown }>, sender: OutboxSender, now: Date) {
  if (rows.length === 0) return { sent: 0, failed: 0 }
  try {
    await sender(rows.map((r) => ({ id: r.id, name: r.eventName, data: r.payload as JsonValue })))
    await systemDb.outbox.updateMany({ where: { id: { in: rows.map((r) => r.id) }, sentAt: null }, data: { sentAt: now } })
    return { sent: rows.length, failed: 0 }
  } catch (error) {
    await systemDb.outbox.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, sentAt: null },
      data: { attempts: { increment: 1 }, lastError: (error as Error).message.slice(0, 500) },
    })
    logger.warn({ err: error, count: rows.length }, 'outbox send failed; the sweeper will retry')
    return { sent: 0, failed: rows.length }
  }
}

/** Best-effort send right after commit. Never throws. */
export async function dispatchOutbox(ids: readonly string[], sender: OutboxSender | null, now: Date) {
  if (!sender || ids.length === 0) return { sent: 0, failed: ids.length }
  const rows = await systemDb.outbox.findMany({
    where: { id: { in: [...ids] }, sentAt: null, suppressed: false },
    select: { id: true, eventName: true, payload: true },
  })
  return sendRows(rows, sender, now)
}

/** Re-sends rows that are still unsent after OUTBOX_SWEEP_AFTER_MS (job outbox-sweeper, every minute). */
export async function sweepOutbox(sender: OutboxSender, now: Date, batchSize = 100) {
  const cutoff = new Date(now.getTime() - OUTBOX_SWEEP_AFTER_MS)
  const rows = await systemDb.outbox.findMany({
    where: { sentAt: null, suppressed: false, createdAt: { lte: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
    select: { id: true, eventName: true, payload: true },
  })
  return sendRows(rows, sender, now)
}
