import { satangToAmount } from '@/core/money/dto'
import { ok, type Result } from '@/core/result'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { applyAiAssist, assertNoPendingAiReview, decimalText, registerAssistSubject, type AiAssist } from '../ai/assist-contract'

// The values of a request by form path (BR-AI-17 of S13, ADR-148): what an AI action may propose for a request and
// what the person ended up with. Paths: title · requestTypeCode · priceIncludesVat · suggestedSupplierId ·
// formData.<field> · lines.<i>.description|quantity|uom|unitPrice|categoryCode · quotations.<i>.supplierName|supplierId|
// amount|includesVat. Quantities and amounts are written as the form writes them (decimalText, satangToAmount).

export async function readRequestForAssist(tx: TenantTx, id: string): Promise<Record<string, string> | null> {
  const r = await tx.request.findFirst({
    where: { id },
    select: {
      title: true,
      priceIncludesVat: true,
      suggestedSupplierId: true,
      formData: true,
      requestType: { select: { code: true } },
      lines: { orderBy: { lineNo: 'asc' }, select: { description: true, quantity: true, uom: true, unitPriceSatang: true, categoryCode: true } },
      // Saved together, quotations share one createdAt: the id (UUID v7, made in order) breaks the tie
      quotations: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { supplierName: true, supplierId: true, amountSatang: true, includesVat: true } },
    },
  })
  if (!r) return null
  const out: Record<string, string> = {
    title: r.title,
    requestTypeCode: r.requestType.code,
    priceIncludesVat: String(r.priceIncludesVat),
  }
  if (r.suggestedSupplierId) out.suggestedSupplierId = r.suggestedSupplierId
  for (const [key, value] of Object.entries((r.formData ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'boolean') out[`formData.${key}`] = String(value)
  }
  r.lines.forEach((l, i) => {
    out[`lines.${i}.description`] = l.description
    out[`lines.${i}.quantity`] = decimalText(l.quantity)
    out[`lines.${i}.uom`] = l.uom
    out[`lines.${i}.unitPrice`] = satangToAmount(l.unitPriceSatang)
    if (l.categoryCode) out[`lines.${i}.categoryCode`] = l.categoryCode
  })
  r.quotations.forEach((q, i) => {
    out[`quotations.${i}.supplierName`] = q.supplierName
    if (q.supplierId) out[`quotations.${i}.supplierId`] = q.supplierId
    out[`quotations.${i}.amount`] = satangToAmount(q.amountSatang)
    out[`quotations.${i}.includesVat`] = String(q.includesVat)
  })
  return out
}

// A request takes what the Document Agent read from a quotation and what the Intake Agent drafted; a draft may keep
// fields waiting until it is sent (request.submit and request.resubmit check)
registerAssistSubject('REQUEST', { purposes: ['QUOTATION_READ', 'INTAKE'], final: false, read: readRequestForAssist })

/** request.create_draft and request.edit: what the person confirmed of an AI action, after the draft was written */
export function aiAssisted(tx: TenantTx, ctx: Ctx, requestId: string, input: AiAssist | undefined): Promise<Result<readonly EventDraft[]>> {
  return applyAiAssist(tx, ctx, { type: 'REQUEST', id: requestId }, input)
}

/** request.submit and request.resubmit: the same, then nothing the AI filled may still wait (AI_REVIEW_PENDING) */
export async function aiReviewed(tx: TenantTx, ctx: Ctx, requestId: string, input: AiAssist | undefined): Promise<Result<readonly EventDraft[]>> {
  const applied = await aiAssisted(tx, ctx, requestId, input)
  if (!applied.ok) return applied
  const pending = await assertNoPendingAiReview(tx, ctx, { type: 'REQUEST', id: requestId })
  return pending.ok ? ok(applied.data) : pending
}
