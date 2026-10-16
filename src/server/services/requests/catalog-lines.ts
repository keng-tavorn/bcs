import { agreementDay, checkAgreementLine, type Agreement } from '@/core/pricing'
import type { AppError } from '@/core/result'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'

// The catalogue lines of a request against the agreed prices in effect today (S6-10 · FR-INT-102 AC2 · BR-PRC-06): the
// request's suggested supplier is the supplier of its lines. A line of an item whose agreement is with that supplier
// takes the agreed price before VAT (AGREEMENT_PRICE_LOCKED) and refers to the agreement; a request with prices that
// include VAT cannot take an agreed price (AGREEMENT_PRICE_BEFORE_VAT). An item with agreements only with other
// suppliers needs the request's offAgreementReason (AGREEMENT_OFF) — at submit, as other answers a draft may still lack.
// A save checks the prices; the submit and the resubmit check everything again with the agreements of their day.

export interface CatalogLineFacts {
  readonly catalogItemId?: string | null
  /** As entered: before VAT unless the request's prices include VAT */
  readonly unitPriceSatang: bigint
}

export interface CatalogCheckInput {
  readonly lines: readonly CatalogLineFacts[]
  readonly supplierId: string | null
  readonly priceIncludesVat: boolean
  readonly offAgreementReason: string | null
  /** The submit: a missing reason refuses too */
  readonly submit: boolean
}

type Outcome = { ok: true; agreementIds: Array<string | null> } | { ok: false; error: AppError }

const refuse = (message: string, details: Record<string, unknown>): Outcome => ({ ok: false, error: { code: 'VALIDATION_FAILED', message, details } })

export async function checkCatalogLines(tx: TenantTx, ctx: Ctx, input: CatalogCheckInput): Promise<Outcome> {
  const ids = [...new Set(input.lines.map((l) => l.catalogItemId).filter((id): id is string => Boolean(id)))]
  const agreementIds: Array<string | null> = input.lines.map(() => null)
  if (ids.length === 0) return { ok: true, agreementIds }
  const items = new Map((await tx.catalogItem.findMany({ where: { id: { in: ids } }, select: { id: true, active: true } })).map((i) => [i.id, i]))
  const day = agreementDay(ctx.now)
  const date = new Date(`${day}T00:00:00Z`)
  const rows = await tx.priceAgreement.findMany({
    where: { catalogItemId: { in: ids }, validFrom: { lte: date }, validTo: { gt: date } },
    select: { id: true, catalogItemId: true, supplierId: true, unitPriceSatang: true, validFrom: true, validTo: true },
  })
  const inEffect: Agreement[] = rows.map((a) => ({ ...a, validFrom: a.validFrom.toISOString().slice(0, 10), validTo: a.validTo.toISOString().slice(0, 10) }))
  for (const [i, line] of input.lines.entries()) {
    if (!line.catalogItemId) continue
    const item = items.get(line.catalogItemId)
    if (!item || !item.active) return refuse('unknown or inactive catalogue item', { field: `lines.${i}.catalogItemId`, reason: 'UNKNOWN' })
    const checked = checkAgreementLine(inEffect, { catalogItemId: line.catalogItemId, supplierId: input.supplierId, unitPriceSatang: line.unitPriceSatang }, input.offAgreementReason)
    if (!checked.ok) {
      if (!input.submit && checked.error.details?.reason === 'AGREEMENT_OFF') continue
      const field = checked.error.details?.reason === 'AGREEMENT_OFF' ? 'offAgreementReason' : `lines.${i}.unitPrice`
      return { ok: false, error: { ...checked.error, details: { ...checked.error.details, field, line: i } } }
    }
    if (checked.data.priceAgreementId && input.priceIncludesVat) {
      return refuse('an agreed price is before VAT: the request must be priced before VAT', { field: 'priceIncludesVat', reason: 'AGREEMENT_PRICE_BEFORE_VAT', line: i })
    }
    agreementIds[i] = checked.data.priceAgreementId
  }
  return { ok: true, agreementIds }
}
