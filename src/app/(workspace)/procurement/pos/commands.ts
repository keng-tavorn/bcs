import { z } from 'zod'
import { PAYMENT_TERM_MAX_DAYS, PO_NOTE_MAX_LENGTH, REASON_MAX_LENGTH } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { cancelPurchaseOrder, closePurchaseOrder, editDraftPo, submitPo } from '@/server/services/purchase-orders'
import { sendPurchaseOrder } from '@/server/services/purchase-orders/send'
import { toPoFailure, type PoOutcome } from '@/ui/purchase-order/outcome'

// The commands behind the buttons of the purchase-order page (FR-P2P-003 AC2, FR-P2P-004, FR-P2P-005, FR-P2P-010),
// apart from the session and the page cache so tests run them with a context. Every input is parsed first, so a
// malformed call gets VALIDATION_FAILED and never a crash; then the service checks the capability, the state machine
// of §6.4 and the money rules again (BR-AUTH-05) and writes its Event. Totals always come back from core on the server
// (FR-P2P-003 AC3): the browser sends prices and quantities, never amounts. The screen asks a reason for every action
// that needs one before it calls; the services refuse without it too.

const Key = z.uuid()
const Id = z.uuid()
const REASON_MIN = 3
const Quantity = z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/)
const Price = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/)

const EditInput = z.object({
  poId: Id,
  expectedVersion: z.number().int().min(0),
  lines: z.array(z.object({ poLineId: Id, quantity: Quantity.optional(), unitPrice: Price.optional() })).max(200).default([]),
  removeLineIds: z.array(Id).max(200).default([]),
  paymentTermDays: z.number().int().min(0).max(PAYMENT_TERM_MAX_DAYS).nullable().optional(),
  notesToSupplier: z.string().max(PO_NOTE_MAX_LENGTH).nullable().optional(),
})
const SendInput = z.object({ poId: Id, reason: z.string().max(REASON_MAX_LENGTH).optional() })
const CancelInput = z.object({ poId: Id, disposition: z.enum(['RETURN_TO_POOL', 'CANCEL_REQUEST_LINES']), reason: z.string().max(REASON_MAX_LENGTH) })

const invalid = (field: string, reason?: string): PoOutcome => ({ ok: false, code: 'VALIDATION_FAILED', field, ...(reason ? { reason } : {}) })
const BAD_KEY = invalid('idempotencyKey')
/** The field a parse refused: the screen says what to fix in it (purchaseOrder.errors) */
const refusedField = (error: z.ZodError, fallback: string) => String(error.issues[0]?.path[0] ?? fallback)

type ServiceResult = { ok: true; data: unknown } | { ok: false; error: { code: string; details?: Readonly<Record<string, unknown>> } }

function outcomeOf(result: ServiceResult): PoOutcome {
  if (!result.ok) return toPoFailure(result.error)
  const status = (result.data as { status?: unknown } | null)?.status
  return typeof status === 'string' ? { ok: true, status } : { ok: true }
}

/** Prices, quantities up to what the requests have left, terms, the note, and lines back to the pool (FR-P2P-003 AC2) */
export async function editDraft(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PoOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = EditInput.safeParse(input)
  if (!parsed.success) return invalid(refusedField(parsed.error, 'lines'))
  const { notesToSupplier, ...rest } = parsed.data
  return outcomeOf(
    await editDraftPo(ctx, { ...rest, ...(notesToSupplier !== undefined ? { notesToSupplier: notesToSupplier?.trim() ? notesToSupplier.trim() : null } : {}) }, { idempotencyKey: idempotencyKey as string }),
  )
}

/** Send a draft for approval on the DOA rule of PURCHASE_ORDER (FR-P2P-004 AC1, BR-BUD-05) */
export async function submitDraft(ctx: Ctx, poId: unknown, idempotencyKey: unknown): Promise<PoOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = Id.safeParse(poId)
  if (!parsed.success) return invalid('poId')
  const result = await submitPo(ctx, { poId: parsed.data }, { idempotencyKey: idempotencyKey as string })
  return result.ok ? { ok: true, status: 'PENDING_APPROVAL' } : toPoFailure(result.error)
}

/** E-mail an approved PO to its supplier with its PDF; again only with a reason (FR-P2P-005, ADR-043) */
export async function sendToSupplier(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PoOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = SendInput.safeParse(input)
  if (!parsed.success) return invalid(refusedField(parsed.error, 'poId'))
  const reason = parsed.data.reason?.trim()
  if (reason !== undefined && reason.length < REASON_MIN) return invalid('reason')
  const result = await sendPurchaseOrder(ctx, { poId: parsed.data.poId, ...(reason ? { reason } : {}) }, { idempotencyKey: idempotencyKey as string })
  if (!result.ok) return toPoFailure(result.error)
  return result.data.bounce ? { ok: true, status: result.data.status, bounce: result.data.bounce } : { ok: true, status: result.data.status }
}

/** Cancel an approved or sent PO with what happens to its request lines and a reason (FR-P2P-010 AC1, BR-BUD-06) */
export async function cancelPo(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PoOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = CancelInput.safeParse(input)
  if (!parsed.success) return invalid(refusedField(parsed.error, 'disposition'))
  const reason = parsed.data.reason.trim()
  if (reason.length < REASON_MIN) return invalid('reason')
  return outcomeOf(await cancelPurchaseOrder(ctx, { poId: parsed.data.poId, disposition: parsed.data.disposition, reason }, { idempotencyKey: idempotencyKey as string }))
}

/** Close a PO whose lines came in full or were closed short (FR-P2P-010 AC2, AC3) */
export async function closePo(ctx: Ctx, poId: unknown, idempotencyKey: unknown): Promise<PoOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = Id.safeParse(poId)
  if (!parsed.success) return invalid('poId')
  return outcomeOf(await closePurchaseOrder(ctx, { poId: parsed.data }, { idempotencyKey: idempotencyKey as string }))
}
