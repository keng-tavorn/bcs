import { z } from 'zod'
import { compareQuotations } from '@/core/forms'
import { vatFromGross } from '@/core/money/math'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'

// Quotations as data (spec BR-FORM-06, FR-INT-005 AC4): each has a supplier, an amount, whether it includes VAT and
// its file; one is chosen. core/forms compares their prices before VAT with the rate in effect; choosing one that is
// not among the lowest needs nonLowestQuoteReason (QUOTE-LOWEST). A quotation's file is also linked to the request as
// a QUOTATION attachment, so the attachment rules (ATT-QUOTES) and file access see it like any other attachment.

/** A request carries at most this many quotations */
export const MAX_QUOTATIONS = 20

export const QuotationInput = z.strictObject({
  supplierName: z.string().trim().min(1).max(200),
  /** The supplier of the register, when the quotation is theirs (the Document Agent matches it by tax id and branch, BR-AI-25) */
  supplierId: z.uuid().optional(),
  amount: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
  includesVat: z.boolean(),
  fileId: z.uuid().optional(),
  selected: z.boolean().default(false),
})
export type QuotationInput = z.output<typeof QuotationInput>

const amountToSatang = (baht: string) => {
  const [whole, fraction = ''] = baht.split('.')
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))
}

type Refusal = { ok: false; error: { code: 'VALIDATION_FAILED'; message: string; details: Record<string, unknown> } }
const refuse = (message: string, details: Record<string, unknown>): Refusal => ({ ok: false, error: { code: 'VALIDATION_FAILED', message, details } })

/**
 * Replaces the quotations of a draft or a returned request. At most one is chosen; a file must be one the requester
 * uploaded. Prices before VAT are kept with the rate of today and computed again at submit with the rate then.
 */
export async function writeQuotations(tx: TenantTx, ctx: Ctx, request: { id: string; requesterMemberId: string }, quotations: readonly QuotationInput[], rateBp: number | null): Promise<Refusal | null> {
  if (quotations.filter((q) => q.selected).length > 1) return refuse('choose one quotation', { field: 'quotations', reason: 'MORE_THAN_ONE_SELECTED' })
  const fileIds = [...new Set(quotations.flatMap((q) => (q.fileId ? [q.fileId] : [])))]
  if (fileIds.length) {
    const own = await tx.fileObject.count({ where: { id: { in: fileIds }, uploadedById: request.requesterMemberId, status: 'AVAILABLE' } })
    if (own !== fileIds.length) return refuse('a quotation file must be one you uploaded', { field: 'quotations', reason: 'FILE' })
  }
  const supplierIds = [...new Set(quotations.flatMap((q) => (q.supplierId ? [q.supplierId] : [])))]
  if (supplierIds.length && (await tx.supplier.count({ where: { id: { in: supplierIds } } })) !== supplierIds.length) {
    return refuse('a quotation names a supplier that is not in the register', { field: 'quotations', reason: 'SUPPLIER' })
  }
  const previous = await tx.requestQuotation.findMany({ where: { requestId: request.id }, select: { fileId: true } })
  await tx.requestQuotation.deleteMany({ where: { requestId: request.id } })
  for (const q of quotations) {
    const amountSatang = amountToSatang(q.amount)
    await tx.requestQuotation.create({
      data: {
        organizationId: ctx.organizationId,
        requestId: request.id,
        supplierName: q.supplierName,
        ...(q.supplierId ? { supplierId: q.supplierId } : {}),
        amountSatang,
        includesVat: q.includesVat,
        vatRateBp: rateBp ?? 0,
        netSatang: q.includesVat && rateBp !== null ? vatFromGross(amountSatang, rateBp).net : amountSatang,
        ...(q.fileId ? { fileId: q.fileId } : {}),
        isSelected: q.selected,
      },
    })
  }
  // The files of quotations are the request's QUOTATION attachments: links of files no longer quoted go, new ones come
  const dropped = previous.flatMap((p) => (p.fileId && !fileIds.includes(p.fileId) ? [p.fileId] : []))
  if (dropped.length) await tx.fileLink.deleteMany({ where: { subjectType: 'Request', subjectId: request.id, kind: 'QUOTATION', fileId: { in: dropped } } })
  const linked = new Set((await tx.fileLink.findMany({ where: { subjectType: 'Request', subjectId: request.id, kind: 'QUOTATION', fileId: { in: fileIds } }, select: { fileId: true } })).map((l) => l.fileId))
  for (const fileId of fileIds.filter((f) => !linked.has(f))) {
    await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId, subjectType: 'Request', subjectId: request.id, kind: 'QUOTATION' } })
  }
  return null
}

/**
 * At submit (BR-FORM-06): every quotation has its file, one is chosen, and choosing one that is not among the lowest
 * prices before VAT needs a reason. The prices are computed again with the rate of the tax date and stored.
 */
export async function checkQuotations(tx: TenantTx, request: { id: string; nonLowestQuoteReason: string | null }, rateBp: number): Promise<Refusal | null> {
  const rows = await tx.requestQuotation.findMany({ where: { requestId: request.id }, orderBy: { createdAt: 'asc' } })
  if (rows.length === 0) return null
  const missingFile = rows.findIndex((r) => !r.fileId)
  if (missingFile >= 0) return refuse('every quotation needs its file', { field: `quotations.${missingFile}.fileId`, reason: 'FILE_REQUIRED' })
  const selected = rows.find((r) => r.isSelected)
  const compared = compareQuotations(
    rows.map((r) => ({ ref: r.id, amountSatang: r.amountSatang, includesVat: r.includesVat })),
    selected?.id ?? null,
    rateBp,
    request.nonLowestQuoteReason,
  )
  if (!compared.ok) {
    const index = (id: string) => rows.findIndex((r) => r.id === id)
    return refuse(compared.rule === 'QUOTE-LOWEST' ? 'the chosen quotation is not the lowest: give a reason' : 'choose one quotation', {
      field: compared.rule === 'QUOTE-LOWEST' ? 'nonLowestQuoteReason' : 'quotations',
      reason: compared.rule,
      rule: compared.rule,
      lowest: compared.lowest.map(index),
    })
  }
  for (const r of rows) await tx.requestQuotation.update({ where: { id: r.id }, data: { vatRateBp: rateBp, netSatang: compared.nets[r.id]! } })
  return null
}
