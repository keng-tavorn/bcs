import { z } from 'zod'
import { PO_NOTE_MAX_LENGTH, REASON_MAX_LENGTH, RETENTION_HOLD_MAX_DAYS } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { setPoMilestones, setPoRetention } from '@/server/services/ap/milestones'
import { cancelPoChange, createPoChange, sendPoRevision, submitPoChange } from '@/server/services/purchase-orders/change'
import { previewPoChange } from '@/server/services/purchase-orders/view-change'
import { percentToBp, toPoS8Failure, type ChangePreviewOutcome, type PoS8Failure, type PoS8Outcome } from '@/ui/po-change/outcome'
import { money } from '../../../_tracking/present'

// The commands behind what S8 adds to the purchase-order page and its change page (S8-13, FR-AP-106 AC1, FR-AP-107),
// apart from the session and the page cache so tests run them with a context. Every input is parsed first, so a
// malformed call gets VALIDATION_FAILED and never a crash; then the service checks the capability (po.edit with module
// PAY for milestones and retention, po.change with a PO_CHANGE rule for changes), the state and the money rules again
// (BR-AUTH-05). The browser sends quantities, prices and percentages as text; amounts always come back from the server.

const Key = z.uuid()
const Id = z.uuid()
const Quantity = z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/)
const Price = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/)
const MAX_PARTS = 12

const invalid = (field: string, reason?: string): PoS8Failure => ({ ok: false, code: 'VALIDATION_FAILED', field, ...(reason ? { reason } : {}) })
const BAD_KEY = invalid('idempotencyKey')
const refusedField = (error: z.ZodError, fallback: string) => String(error.issues[0]?.path[0] ?? fallback)

type ServiceResult = { ok: true; data: unknown } | { ok: false; error: { code: string; details?: Readonly<Record<string, unknown>> } }

function outcomeOf(result: ServiceResult): PoS8Outcome {
  if (!result.ok) return toPoS8Failure(result.error)
  const status = (result.data as { status?: unknown } | null)?.status
  return typeof status === 'string' ? { ok: true, status } : { ok: true }
}

// ---------- milestones and retention of a draft (FR-AP-106 AC1, BR-RET-01, BR-RET-03) ----------

const MilestonesInput = z.object({ poId: Id, expectedVersion: z.number().int().min(0), poLineId: Id, shares: z.array(z.string().max(10)).min(1).max(MAX_PARTS) })

/** Splits a service line into milestones by shares in percent ("30", "40", "30") */
export async function setMilestonesFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PoS8Outcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = MilestonesInput.safeParse(input)
  if (!parsed.success) return invalid(refusedField(parsed.error, 'shares'), 'SHARES')
  const sharesBp = parsed.data.shares.map(percentToBp)
  if (sharesBp.some((s) => s === null)) return invalid('shares', 'SHARES')
  const { shares: _shares, ...rest } = parsed.data
  return outcomeOf(await setPoMilestones(ctx, { ...rest, sharesBp: sharesBp as number[] }, { idempotencyKey: idempotencyKey as string }))
}

const RetentionInput = z.object({ poId: Id, expectedVersion: z.number().int().min(0), retentionPercent: z.string().max(10), holdDays: z.string().max(10) })

/** The retention in percent ("5") and the days it is held after the last milestone ("" = the organization's default) */
export async function setRetentionFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PoS8Outcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = RetentionInput.safeParse(input)
  if (!parsed.success) return invalid(refusedField(parsed.error, 'retentionPercent'))
  const retentionBp = percentToBp(parsed.data.retentionPercent || '0')
  if (retentionBp === null) return invalid('retentionPercent')
  const days = parsed.data.holdDays.trim()
  if (days !== '' && (!/^\d{1,4}$/.test(days) || Number(days) > RETENTION_HOLD_MAX_DAYS)) return invalid('holdDays')
  return outcomeOf(
    await setPoRetention(ctx, { poId: parsed.data.poId, expectedVersion: parsed.data.expectedVersion, retentionBp, retentionHoldDays: days === '' ? null : Number(days) }, { idempotencyKey: idempotencyKey as string }),
  )
}

// ---------- changes of a sent PO (FR-AP-107) ----------

const LineChange = z.object({ poLineId: Id, newQuantity: Quantity.optional(), newUnitPrice: Price.optional() })
const PreviewInput = z.object({ poId: Id, lines: z.array(LineChange).max(200).default([]) })
const CreateInput = z.object({
  poId: Id,
  reason: z.string().max(REASON_MAX_LENGTH),
  lines: z.array(LineChange).max(200).default([]),
  deliveryDate: z.string().max(10),
  notesToSupplier: z.string().max(PO_NOTE_MAX_LENGTH),
  quantityDisposition: z.enum(['RETURN_TO_POOL', 'CANCEL_REQUEST_LINES']).optional(),
})
const SubmitInput = z.object({ poChangeId: Id, version: z.number().int().min(0) })
const CancelInput = z.object({ poChangeId: Id, version: z.number().int().min(0), reason: z.string().max(REASON_MAX_LENGTH) })

/** The PO's totals after the change, from the server (BR-POC-02), or why the change would be refused */
export async function previewChangeFor(ctx: Ctx, input: unknown): Promise<ChangePreviewOutcome> {
  const parsed = PreviewInput.safeParse(input)
  if (!parsed.success) return invalid(refusedField(parsed.error, 'lines'))
  const result = await previewPoChange(ctx, parsed.data)
  if (!result.ok) return toPoS8Failure(result.error)
  const { old: before, new: after } = result.data
  return { ok: true, totals: { oldNet: money(before.netSatang), oldVat: money(before.vatSatang), oldGross: money(before.grossSatang), newNet: money(after.netSatang), newVat: money(after.vatSatang), newGross: money(after.grossSatang) } }
}

/** Drafts the change (po_change.create): only what differs from the PO goes in it */
export async function createChangeFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PoS8Outcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = CreateInput.safeParse(input)
  if (!parsed.success) return invalid(refusedField(parsed.error, 'lines'))
  const { deliveryDate, notesToSupplier, reason, quantityDisposition, ...rest } = parsed.data
  if (!reason.trim()) return invalid('reason')
  if (deliveryDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) return invalid('deliveryDate')
  return outcomeOf(
    await createPoChange(
      ctx,
      { ...rest, reason: reason.trim(), deliveryDate: deliveryDate || null, notesToSupplier: notesToSupplier.trim() || null, ...(quantityDisposition ? { quantityDisposition } : {}) },
      { idempotencyKey: idempotencyKey as string },
    ),
  )
}

/** Sends a draft change for approval (or approves at once a change of only the date or the notes) */
export async function submitChangeFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PoS8Outcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = SubmitInput.safeParse(input)
  if (!parsed.success) return invalid(refusedField(parsed.error, 'poChangeId'))
  return outcomeOf(await submitPoChange(ctx, parsed.data, { idempotencyKey: idempotencyKey as string }))
}

/** Cancels a draft or pending change with a reason */
export async function cancelChangeFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PoS8Outcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = CancelInput.safeParse(input)
  if (!parsed.success) return invalid(refusedField(parsed.error, 'reason'))
  const reason = parsed.data.reason.trim()
  if (!reason) return invalid('reason')
  return outcomeOf(await cancelPoChange(ctx, { ...parsed.data, reason }, { idempotencyKey: idempotencyKey as string }))
}

/** E-mails the latest revision to the supplier with its PDF (po.sendRevision) */
export async function sendRevisionFor(ctx: Ctx, poId: unknown, idempotencyKey: unknown): Promise<PoS8Outcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = Id.safeParse(poId)
  if (!parsed.success) return invalid('poId')
  return outcomeOf(await sendPoRevision(ctx, { poId: parsed.data }, { idempotencyKey: idempotencyKey as string }))
}
