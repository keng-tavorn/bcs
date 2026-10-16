import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { MS_PER_DAY, MS_PER_MINUTE } from '@/lib/constants'
import { bcsGoSettingsOf } from '@/lib/s17-settings'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'

// A goods receipt captured in BCS Go without a signal and sent later (BR-APP-08, S17-12, OQ-170). gr.post checks, in
// BR-APP-08's order: the member sending is the one who captured it (FORBIDDEN) → permission and SoD as ever → the PO's
// status as ever → the PO is still at the version the phone's copy had (CONFLICT_VERSION: somebody received, changed
// or cancelled it meanwhile, so what the receiver saw is no longer what is on order) → the capture time is not before
// the PO was sent, at most OFFLINE_CLOCK_SKEW_MS after now (a phone's clock running fast) and not older than the
// organization's bcsGo.offlineRetentionDays (VALIDATION_FAILED reason CAPTURED_AT) → everything as ever. The money of
// the receipt never changes for being offline: the receipt is posted now (postedAt = ctx.now, which the budget and the
// reports count) and keeps when it was captured for the document only (receivedAt = min(capturedAt, now)).

/** BR-APP-08: a phone's clock may run this far ahead of the server's */
export const OFFLINE_CLOCK_SKEW_MS = 5 * MS_PER_MINUTE

export const OfflineCaptureInput = z.strictObject({
  /** When the receiver saved it on the phone (the page's clock) */
  capturedAt: z.iso.datetime({ offset: true }),
  capturedByMemberId: z.uuid(),
  /** The version of the PO in the phone's copy */
  expectedPoVersion: z.number().int().nonnegative(),
})
export type OfflineCapture = z.infer<typeof OfflineCaptureInput>

/** BR-APP-08 first check: the member sending must be the one who captured the receipt (FORBIDDEN) */
export function checkOfflineSender(actorMemberId: string, offline: OfflineCapture | undefined): Result<true> {
  if (offline && offline.capturedByMemberId !== actorMemberId) return err('FORBIDDEN', 'an offline receipt is sent by the member who captured it', { reason: 'NOT_OWNER' })
  return ok(true)
}

/**
 * BR-APP-08 after the PO's status: the PO version the receipt was captured against (CONFLICT_VERSION) and when it was
 * captured (VALIDATION_FAILED reason CAPTURED_AT)
 */
export async function checkOfflineCapture(tx: TenantTx, ctx: Ctx, po: { readonly version: number; readonly sentAt: Date | null }, offline: OfflineCapture | undefined): Promise<Result<true>> {
  if (!offline) return ok(true)
  if (offline.expectedPoVersion !== po.version) {
    return err('CONFLICT_VERSION', 'the purchase order changed since the copy on the phone was prepared', { expectedVersion: offline.expectedPoVersion, actualVersion: po.version })
  }
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const keepDays = bcsGoSettingsOf(org.settings).offlineRetentionDays
  const at = Date.parse(offline.capturedAt)
  const now = ctx.now.getTime()
  const tooEarly = po.sentAt !== null && at < po.sentAt.getTime()
  if (tooEarly || at > now + OFFLINE_CLOCK_SKEW_MS || at < now - keepDays * MS_PER_DAY) {
    return err('VALIDATION_FAILED', 'the capture time is before the purchase order was sent, ahead of now or older than the organization keeps a queue', { field: 'offline.capturedAt', reason: 'CAPTURED_AT' })
  }
  return ok(true)
}

/** OQ-170: the receipt says when the goods came — never after it reached BCS */
export function receivedAtOf(offline: OfflineCapture | undefined, now: Date): Date {
  if (!offline) return now
  const at = new Date(offline.capturedAt)
  return at.getTime() < now.getTime() ? at : now
}
