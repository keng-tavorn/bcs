import { z } from 'zod'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { postGoodsReceipt, requestCloseShort } from '@/server/services/receiving'
import { previewGoodsReceipt } from '@/server/services/receiving/view'
import { toReceivingFailure, type CloseShortOutcome, type PostOutcome, type PreviewOutcome, type ReceivingFailure } from '@/ui/receiving/outcome'
import { cleanQuantity, isZeroQuantity } from '@/ui/receiving/quantity'
import { previewView } from './present'

// The commands behind the receiving page (FR-P2P-006, FR-P2P-007, FR-P2P-010 AC2), apart from the session and the page
// cache so tests run them with a context. Every input is parsed first, so a malformed call gets VALIDATION_FAILED and
// never a crash; quantities typed with thousands separators are cleaned; lines left empty are not part of the receipt.
// Then the service decides and checks the permission again (gr.post with BR-SOD-02 and BR-SOD-07, po.close), so a
// hidden button is never the guard (BR-AUTH-05). The screen keeps one rule of its own: refused goods are either damaged
// — then the receiver says whether the supplier replaces them or they are kept (BR-GR-05) — or refused for another
// reason, which the remark gives.

const Key = z.uuid()
const REASON_MIN = 3
const MAX_PHOTOS = 20
const QUANTITY_TEXT_MAX = 40
const DELIVERY_NOTE_MAX = 100

const LineInput = z.object({
  poLineId: z.uuid(),
  received: z.string().max(QUANTITY_TEXT_MAX),
  rejected: z.string().max(QUANTITY_TEXT_MAX),
  damaged: z.boolean(),
  remark: z.string().max(REASON_MAX_LENGTH),
  excessDisposition: z.enum(['RETURN_EXCESS', 'ACCEPT_EXCESS']).optional(),
  damagedDisposition: z.enum(['RETURN_REPLACE', 'ACCEPT_DAMAGED']).optional(),
})
const ReceiptInput = z.object({
  poId: z.uuid(),
  deliveryNoteNo: z.string().max(DELIVERY_NOTE_MAX),
  notes: z.string().max(REASON_MAX_LENGTH),
  photoFileIds: z.array(z.uuid()).max(MAX_PHOTOS),
  lines: z.array(LineInput).min(1).max(200),
})
const PreviewInput = ReceiptInput.pick({ poId: true, photoFileIds: true, lines: true })
const CloseShortInput = z.object({ poId: z.uuid(), reason: z.string().max(REASON_MAX_LENGTH), confirmed: z.boolean() })

const invalid = (field: string, reason?: string): ReceivingFailure => ({ ok: false, code: 'VALIDATION_FAILED', field, ...(reason ? { reason } : {}) })
const BAD_KEY = invalid('idempotencyKey')

type LineIn = z.infer<typeof LineInput>
type CleanLine = { poLineId: string; received: string; rejected: string; damaged: boolean; remark: string | null; excessDisposition?: LineIn['excessDisposition']; damagedDisposition?: LineIn['damagedDisposition'] }

/** The lines that make the receipt: quantities cleaned, empty lines left out; or what is wrong and where */
function receiptLines(lines: readonly LineIn[]): { ok: true; lines: CleanLine[] } | ReceivingFailure {
  const out: CleanLine[] = []
  for (const [i, l] of lines.entries()) {
    if (!l.received.trim()) continue
    const received = cleanQuantity(l.received)
    const rejected = l.rejected.trim() ? cleanQuantity(l.rejected) : '0'
    if (received === null) return invalid(`lines.${i}.received`, 'QUANTITY')
    if (rejected === null) return invalid(`lines.${i}.rejected`, 'QUANTITY')
    if (isZeroQuantity(received)) continue
    const remark = l.remark.trim()
    out.push({
      poLineId: l.poLineId,
      received,
      rejected,
      damaged: l.damaged && !isZeroQuantity(rejected),
      remark: remark || null,
      ...(l.excessDisposition ? { excessDisposition: l.excessDisposition } : {}),
      ...(l.damagedDisposition ? { damagedDisposition: l.damagedDisposition } : {}),
    })
  }
  if (out.length === 0) return invalid('lines', 'NOTHING_RECEIVED')
  return { ok: true, lines: out }
}

/**
 * What the receipt will do, before it is posted (§9.9 principle 3). The key is the form's for this check: a check refused
 * by separation of duties is recorded once with it (FR-DOA-007 AC2).
 */
export async function previewReceipt(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PreviewOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = PreviewInput.safeParse(input)
  if (!parsed.success) return invalid('lines', 'QUANTITY')
  const lines = receiptLines(parsed.data.lines)
  if (!lines.ok) return lines
  const result = await previewGoodsReceipt(
    ctx,
    {
      poId: parsed.data.poId,
      photoFileIds: parsed.data.photoFileIds,
      lines: lines.lines.map((l) => ({ poLineId: l.poLineId, received: l.received, rejected: l.rejected, damaged: l.damaged })),
    },
    { idempotencyKey: idempotencyKey as string },
  )
  return result.ok ? { ok: true, preview: previewView(result.data) } : toReceivingFailure(result.error)
}

/** Post the receipt (gr.post); damaged goods need the receiver's choice, the excess its own (BR-GR-03) */
export async function postReceipt(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PostOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = ReceiptInput.safeParse(input)
  if (!parsed.success) return invalid('lines', 'QUANTITY')
  const lines = receiptLines(parsed.data.lines)
  if (!lines.ok) return lines
  const missing = lines.lines.findIndex((l) => l.damaged && !l.damagedDisposition)
  if (missing >= 0) return invalid(`lines.${missing}.damagedDisposition`, 'DAMAGED_DISPOSITION_REQUIRED')
  const deliveryNoteNo = parsed.data.deliveryNoteNo.trim()
  const notes = parsed.data.notes.trim()
  const result = await postGoodsReceipt(
    ctx,
    {
      poId: parsed.data.poId,
      deliveryNoteNo: deliveryNoteNo || null,
      notes: notes || null,
      photoFileIds: [...new Set(parsed.data.photoFileIds)],
      lines: lines.lines.map((l) => ({
        poLineId: l.poLineId,
        received: l.received,
        rejected: l.rejected,
        remark: l.remark,
        ...(l.damaged && l.damagedDisposition ? { damagedDisposition: l.damagedDisposition } : {}),
        ...(l.excessDisposition ? { excessDisposition: l.excessDisposition } : {}),
      })),
    },
    { idempotencyKey: idempotencyKey as string },
  )
  if (!result.ok) return toReceivingFailure(result.error)
  return { ok: true, number: result.data.number, poStatus: result.data.poStatus, varianceCount: result.data.varianceIds.length, pendingApproval: result.data.pendingApproval }
}

/** PROCUREMENT asks to close the PO although goods are still to come (po.close_short, GC-GR-04): a reason and a tick */
export async function closeShort(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<CloseShortOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = CloseShortInput.safeParse(input)
  if (!parsed.success) return invalid('reason')
  const reason = parsed.data.reason.trim()
  if (reason.length < REASON_MIN) return invalid('reason')
  if (!parsed.data.confirmed) return invalid('confirm')
  const result = await requestCloseShort(ctx, { poId: parsed.data.poId, reason }, { idempotencyKey: idempotencyKey as string })
  return result.ok ? { ok: true, lines: result.data.varianceIds.length } : toReceivingFailure(result.error)
}
