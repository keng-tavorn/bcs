import * as services from '@/server/services/requests'

// The request services for tests whose fixtures send the same request again within the duplicate window (S6-13 ·
// BR-DUP-02 · BR-DUP-05) for reasons that have nothing to do with duplicates: a submit or resubmit refused with
// DUPLICATE_UNACKNOWLEDGED is sent again with a reason, as the requester would after reading the warning. Everything
// else is the services as they are. The tests of duplicates themselves (tests/integration/duplicates.test.ts and the
// phase-1 seed) import @/server/services/requests directly and see the refusal.

export * from '@/server/services/requests'

const REASON = 'ส่งซ้ำโดยตั้งใจในเทสต์'

type Options = Parameters<typeof services.submitRequest>[2]
const again = (options: Options): Options => ({ ...options, idempotencyKey: `${options.idempotencyKey}:duplicate-reason` })
const refusedAsDuplicate = (r: { ok: boolean; error?: { details?: Record<string, unknown> } }) => !r.ok && r.error?.details?.reason === 'DUPLICATE_UNACKNOWLEDGED'

export async function submitRequest(...[ctx, input, options]: Parameters<typeof services.submitRequest>): ReturnType<typeof services.submitRequest> {
  const first = await services.submitRequest(ctx, input, options)
  return refusedAsDuplicate(first) && input.duplicateReason === undefined ? services.submitRequest(ctx, { ...input, duplicateReason: REASON }, again(options)) : first
}

export async function resubmitRequest(...[ctx, input, options]: Parameters<typeof services.resubmitRequest>): ReturnType<typeof services.resubmitRequest> {
  const first = await services.resubmitRequest(ctx, input, options)
  return refusedAsDuplicate(first) && input.duplicateReason === undefined ? services.resubmitRequest(ctx, { ...input, duplicateReason: REASON }, again(options)) : first
}
