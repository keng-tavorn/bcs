import { amountToSatang, satangToAmount } from '../money/dto'
import { parseQuantity, vatFromGross } from '../money/math'
import { formatQuantity } from '../receiving'
import { normalizeTaxId } from '../thai/taxid'
import type { CheckCode, ReadLine, ReadingToCheck } from './verify'

// Turning a checked reading into values of a form (BR-AI-25, golden ai-quotation-map and ai-dn-map). A quotation fills
// the request's quotation (BR-FORM-06) with the supplier of the register when the tax id and branch match, the amount
// as read only when the totals passed, and the lines only without a discount. A delivery note fills the received
// quantity of the PO lines it names, once per line, in the line's unit; more than is still open is filled but marked,
// and gr.post decides as before.

export interface SupplierEntry {
  readonly id: string
  readonly taxId: string
  readonly branch: string
  readonly nameTh: string
}

export type MappingFlag = 'SUPPLIER_NOT_REGISTERED' | 'AMOUNT_UNVERIFIED' | 'DISCOUNT_NOT_MAPPABLE'

export interface QuotationMapping {
  readonly quotation: { readonly supplierId: string | null; readonly supplierName: string | null; readonly amount: string | null; readonly includesVat: boolean; readonly fileId: string } | null
  /** The price before VAT of the quotation as BR-FORM-06 compares it; null without an amount */
  readonly quoteNet: string | null
  readonly priceIncludesVat: boolean
  readonly lines: readonly { readonly qty: string | null; readonly uom: string | null; readonly unitPrice: string | null }[] | null
  readonly flags: readonly MappingFlag[]
}

const UNVERIFIED: readonly CheckCode[] = ['NET_TOTAL', 'GROSS_TOTAL', 'DISCOUNT_AMBIGUOUS']

export function mapQuotation(
  reading: ReadingToCheck & { readonly seller?: { readonly taxId?: string | null; readonly branch?: string | null; readonly name?: string | null } | null },
  checks: { readonly fail?: readonly CheckCode[]; readonly warn?: readonly CheckCode[] },
  ctx: { readonly fileId: string; readonly vatRateBp: number; readonly registry: readonly SupplierEntry[]; readonly normalized: { readonly lines: readonly ReadLine[]; readonly discountTotal: string | null } },
): QuotationMapping {
  const fails = checks.fail ?? []
  const includesVat = reading.priceIncludesVat === true
  // Another currency fills nothing (NG-9)
  if (fails.includes('CURRENCY')) return { quotation: null, quoteNet: null, priceIncludesVat: includesVat, lines: null, flags: [] }
  const flags: MappingFlag[] = []
  const taxId = reading.seller?.taxId ? normalizeTaxId(reading.seller.taxId) : null
  const found = taxId ? ctx.registry.find((s) => s.taxId === taxId && s.branch === (reading.seller?.branch ?? '00000')) : undefined
  if (!found) flags.push('SUPPLIER_NOT_REGISTERED')
  const unverified = fails.some((c) => UNVERIFIED.includes(c))
  if (unverified) flags.push('AMOUNT_UNVERIFIED')
  const read = includesVat ? reading.gross : reading.net
  const amount = unverified || !read ? null : satangToAmount(amountToSatang(read.replace(/,/g, '')))
  const discounted = fails.includes('DISCOUNT_AMBIGUOUS') || ctx.normalized.discountTotal !== null
  if (discounted) flags.push('DISCOUNT_NOT_MAPPABLE')
  const quoteNet = amount === null ? null : includesVat ? satangToAmount(vatFromGross(amountToSatang(amount), ctx.vatRateBp).net) : amount
  return {
    quotation: { supplierId: found?.id ?? null, supplierName: found?.nameTh ?? reading.seller?.name ?? null, amount, includesVat, fileId: ctx.fileId },
    quoteNet,
    priceIncludesVat: includesVat,
    lines: discounted ? null : ctx.normalized.lines.map((l) => ({ qty: l.qty ?? null, uom: l.unit ?? null, unitPrice: l.unitPrice ?? null })),
    flags,
  }
}

export interface PoLineOpen {
  readonly lineNo: number
  readonly uom: string
  readonly openQty: string
}

export type DeliveryNoteFlag =
  | { readonly code: 'PO_LINE_UNKNOWN'; readonly dnLine: number }
  | { readonly code: 'UOM_MISMATCH'; readonly dnLine: number }
  | { readonly code: 'DUPLICATE_PO_LINE'; readonly lineNo: number }
  | { readonly code: 'OVER_OPEN'; readonly lineNo: number }

export function mapDeliveryNote(
  dnLines: readonly { readonly qty: string; readonly unit: string; readonly poLineNo: number | null }[],
  poLines: readonly PoLineOpen[],
): { readonly prefill: readonly { readonly lineNo: number; readonly received: string }[]; readonly flags: readonly DeliveryNoteFlag[] } {
  const flags: DeliveryNoteFlag[] = []
  const usable: { dnLine: number; po: PoLineOpen; qty: bigint }[] = []
  dnLines.forEach((d, i) => {
    const po = poLines.find((p) => p.lineNo === d.poLineNo)
    if (!po) return flags.push({ code: 'PO_LINE_UNKNOWN', dnLine: i })
    if (po.uom !== d.unit) return flags.push({ code: 'UOM_MISMATCH', dnLine: i })
    usable.push({ dnLine: i, po, qty: parseQuantity(d.qty) })
  })
  const prefill: { lineNo: number; received: string }[] = []
  for (const u of usable) {
    const same = usable.filter((x) => x.po.lineNo === u.po.lineNo)
    if (same.length > 1) {
      if (same[0] === u) flags.push({ code: 'DUPLICATE_PO_LINE', lineNo: u.po.lineNo })
      continue
    }
    prefill.push({ lineNo: u.po.lineNo, received: formatQuantity(u.qty) })
    if (u.qty > parseQuantity(u.po.openQty)) flags.push({ code: 'OVER_OPEN', lineNo: u.po.lineNo })
  }
  return { prefill, flags }
}
