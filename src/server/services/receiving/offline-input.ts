import { z } from 'zod'
import { ok, type Result } from '@/core/result'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'

// A goods receipt captured in BCS Go without a signal and sent later (BR-APP-08 of S17, P1-07). P1-07 lays the field
// `offline` of gr.post and its checks in BR-APP-08's order; S17-12 fills this file only — the shape
// { capturedAt, capturedByMemberId, expectedPoVersion } and the two checks below — and the lines of gr.post that write
// receivedAt, offlineCapturedAt and poVersion. Until then nothing can be sent here: any `offline` is VALIDATION_FAILED.

export const OfflineCaptureInput = z.never()
export type OfflineCapture = z.infer<typeof OfflineCaptureInput>

/** BR-APP-08 first check: the member sending must be the one who captured the receipt (FORBIDDEN). Nothing before S17 */
export function checkOfflineSender(_actorMemberId: string, _offline: OfflineCapture | undefined): Result<true> {
  return ok(true)
}

/**
 * BR-APP-08 after the PO's status: the PO version the receipt was captured against (CONFLICT_VERSION) and when it was
 * captured (VALIDATION_FAILED reason CAPTURED_AT). Nothing before S17.
 */
export async function checkOfflineCapture(
  _tx: TenantTx,
  _ctx: Ctx,
  _po: { readonly version: number; readonly sentAt: Date | null },
  _offline: OfflineCapture | undefined,
): Promise<Result<true>> {
  return ok(true)
}
