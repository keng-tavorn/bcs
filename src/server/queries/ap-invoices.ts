import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { isUuid } from './requests'

// What the approver of an invoice's price variance decides on (S8-06, FR-AP-105 AC2, BR-AP-06): the invoice and its PO,
// each line over the PO price with the PO's and the invoice's unit prices and the difference, and the variance in total
// with its VAT. The page that shows it has already checked the task is the reader's (getTaskAccess). The LINE card and
// the LIFF summary show the numbers and the total only (BR-AP-09).

export interface InvoiceTaskViewDto {
  readonly id: string
  readonly number: string | null
  readonly supplierInvoiceNo: string | null
  readonly invoiceDate: string | null
  readonly status: string
  readonly po: { readonly id: string; readonly number: string | null }
  readonly supplier: { readonly nameTh: string; readonly juristic: boolean }
  readonly lines: ReadonlyArray<{ readonly lineNo: number; readonly description: string; readonly quantity: string; readonly uom: string; readonly poUnitPriceSatang: bigint; readonly unitPriceSatang: bigint; readonly overSatang: bigint }>
  readonly grossSatang: bigint
  /** The variance the route was made on: net, VAT and the two together (from invoice.variance_submitted) */
  readonly variance: { readonly netSatang: bigint; readonly vatSatang: bigint } | null
}

export async function getInvoiceTaskView(ctx: Ctx, invoiceId: string): Promise<InvoiceTaskViewDto | null> {
  if (!isUuid(invoiceId)) return null
  const db = forTenant(ctx.organizationId)
  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId },
    select: {
      id: true,
      number: true,
      supplierInvoiceNo: true,
      invoiceDate: true,
      status: true,
      grossSatang: true,
      po: { select: { id: true, number: true } },
      supplier: { select: { nameTh: true, payeeType: true } },
      lines: { orderBy: { lineNo: 'asc' }, select: { lineNo: true, description: true, quantity: true, uom: true, unitPriceSatang: true, overSatang: true, poLine: { select: { unitPriceSatang: true } } } },
    },
  })
  if (!invoice) return null
  const asked = await db.event.findFirst({ where: { aggregateId: invoiceId, type: 'invoice.variance_submitted' }, orderBy: { seq: 'desc' }, select: { data: true } })
  const data = (asked?.data ?? null) as { netSatang?: string; vatSatang?: string } | null
  return {
    id: invoice.id,
    number: invoice.number,
    supplierInvoiceNo: invoice.supplierInvoiceNo,
    invoiceDate: invoice.invoiceDate?.toISOString().slice(0, 10) ?? null,
    status: invoice.status,
    po: invoice.po,
    supplier: { nameTh: invoice.supplier.nameTh, juristic: invoice.supplier.payeeType === 'JURISTIC' },
    lines: invoice.lines
      .filter((l) => l.overSatang > 0n)
      .map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: l.quantity.toString(), uom: l.uom, poUnitPriceSatang: l.poLine.unitPriceSatang, unitPriceSatang: l.unitPriceSatang, overSatang: l.overSatang })),
    grossSatang: invoice.grossSatang,
    variance: data?.netSatang && data.vatSatang ? { netSatang: BigInt(data.netSatang), vatSatang: BigInt(data.vatSatang) } : null,
  }
}
