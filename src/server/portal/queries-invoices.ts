import { bankOf } from '@/core/bankfile/banks'
import { MS_PER_DAY } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { portalInvoicesOn } from '@/server/services/ap/portal'
import { portalWhere } from './db'

// S7-12 (FR-AP-103 AC5 · FR-PAY-103 AC8 · BR-SUP ข้อ 15 · ADR-188): what the supplier reads of its own invoices and
// payments on the portal, through portalWhere like every portal query (INV-SUP-01 · tests/generated/portal-isolation).
// Nothing when PAY is off or supplier.portalInvoice is false (the menu is hidden then), or for a supplier not ACTIVE.
// An invoice is told in the supplier's words: a difference found is "being checked" — never its kind or its amount. A
// payment shows the last four digits of the account and never the account number or the bank's reference.

/** Where an invoice stands for its supplier */
export type PortalInvoiceStage = 'DRAFT' | 'IN_REVIEW' | 'READY' | 'PAID' | 'REJECTED' | 'CANCELLED'

function stageOf(status: string): PortalInvoiceStage {
  if (status === 'DRAFT') return 'DRAFT'
  if (status === 'EXCEPTION' || status === 'PENDING_APPROVAL') return 'IN_REVIEW'
  if (status === 'READY_FOR_PAYMENT' || status === 'IN_PAYMENT_RUN') return 'READY'
  if (status === 'PAID') return 'PAID'
  return status === 'REJECTED' ? 'REJECTED' : 'CANCELLED'
}

const day = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The contact's own supplier, ACTIVE, with invoices on the portal: its id, or null */
async function invoicingSupplier(ctx: Ctx): Promise<string | null> {
  if (ctx.actor.type !== 'SUPPLIER') throw new Error('a portal query needs a portal context')
  if (!ctx.actor.supplierId) return null
  const supplier = await forTenant(ctx.organizationId).supplier.findFirst({ where: portalWhere(ctx, 'supplier'), select: { id: true, status: true } })
  if (supplier?.status !== 'ACTIVE') return null
  return (await portalInvoicesOn(ctx)) ? supplier.id : null
}

/** Whether the portal shows invoices and payments to this contact (the menu and the pages) */
export async function portalInvoicesShown(ctx: Ctx): Promise<boolean> {
  return (await invoicingSupplier(ctx)) !== null
}

export interface PortalInvoiceRow {
  readonly id: string
  readonly supplierInvoiceNo: string | null
  /** BCS's number, given when FINANCE submits it ("รับแล้ว") */
  readonly number: string | null
  readonly poNumber: string | null
  readonly invoiceDate: string | null
  /** Satang as text: the page formats it */
  readonly grossSatang: string
  readonly stage: PortalInvoiceStage
  readonly dueDate: string | null
  readonly paidOn: string | null
  readonly rejectReason: string | null
  readonly fromPortal: boolean
  /** The contact may still change it: a draft from the portal whose coding FINANCE has not confirmed */
  readonly editable: boolean
}

const ROW_SELECT = {
  id: true,
  supplierInvoiceNo: true,
  number: true,
  invoiceDate: true,
  grossSatang: true,
  status: true,
  dueDate: true,
  rejectReason: true,
  cancelReason: true,
  channel: true,
  po: { select: { number: true } },
  lines: { select: { codingConfirmedAt: true } },
  paymentDocuments: { where: { status: 'PAID' as const }, select: { item: { select: { paidOn: true } } } },
} as const

type RowSource = {
  id: string
  supplierInvoiceNo: string | null
  number: string | null
  invoiceDate: Date | null
  grossSatang: bigint
  status: string
  dueDate: Date | null
  rejectReason: string | null
  cancelReason: string | null
  channel: string
  po: { number: string | null }
  lines: ReadonlyArray<{ codingConfirmedAt: Date | null }>
  paymentDocuments: ReadonlyArray<{ item: { paidOn: Date | null } }>
}

function rowOf(r: RowSource): PortalInvoiceRow {
  const stage = stageOf(r.status)
  return {
    id: r.id,
    supplierInvoiceNo: r.supplierInvoiceNo,
    number: r.number,
    poNumber: r.po.number,
    invoiceDate: day(r.invoiceDate),
    grossSatang: r.grossSatang.toString(),
    stage,
    dueDate: day(r.dueDate),
    paidOn: day(r.paymentDocuments.map((d) => d.item.paidOn).find((d) => d !== null)),
    // a draft from the portal FINANCE refuses before sending it is cancelled (never rejected): its reason is the supplier's too
    rejectReason: stage === 'REJECTED' ? r.rejectReason : stage === 'CANCELLED' && r.channel === 'PORTAL' ? r.cancelReason : null,
    fromPortal: r.channel === 'PORTAL',
    // until FINANCE confirms its coding or numbers it (invoice.update says the same)
    editable: stage === 'DRAFT' && r.channel === 'PORTAL' && r.number === null && r.lines.every((l) => l.codingConfirmedAt === null),
  }
}

/** /portal/<org>/invoices: the supplier's invoices, the newest first */
export async function listPortalInvoices(ctx: Ctx): Promise<PortalInvoiceRow[]> {
  if (!(await invoicingSupplier(ctx))) return []
  const rows = await forTenant(ctx.organizationId).invoice.findMany({ where: portalWhere(ctx, 'invoice'), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200, select: ROW_SELECT })
  return rows.map(rowOf)
}

export interface PortalInvoiceView extends PortalInvoiceRow {
  readonly poId: string
  readonly version: number
  readonly priceIncludesVat: boolean
  readonly netSatang: string
  readonly vatSatang: string
  readonly discountSatang: string
  readonly lines: readonly { readonly poLineId: string | null; readonly description: string; readonly quantity: string; readonly uom: string; readonly unitPriceSatang: string; readonly netSatang: string }[]
  /** The PO's lines, to put on the invoice while it can be changed */
  readonly poLines: readonly { readonly id: string; readonly lineNo: number; readonly description: string; readonly uom: string; readonly quantity: string; readonly unitPriceSatang: string }[]
  readonly file: { readonly fileName: string; readonly scanned: boolean } | null
  /** When it was sent, received (numbered), ready, rejected or paid */
  readonly timeline: { readonly sentAt: string; readonly receivedAt: string | null; readonly readyAt: string | null; readonly rejectedAt: string | null }
}

/** One invoice of the supplier with its lines; null for one it may not see */
export async function getPortalInvoice(ctx: Ctx, invoiceId?: string): Promise<PortalInvoiceView | null> {
  if (!(await invoicingSupplier(ctx)) || !invoiceId || !UUID.test(invoiceId)) return null
  const db = forTenant(ctx.organizationId)
  const inv = await db.invoice.findFirst({
    where: { AND: [portalWhere(ctx, 'invoice'), { id: invoiceId }] },
    select: {
      ...ROW_SELECT,
      poId: true,
      version: true,
      priceIncludesVat: true,
      netSatang: true,
      statedVatSatang: true,
      discountSatang: true,
      createdAt: true,
      submittedAt: true,
      readyAt: true,
      rejectedAt: true,
      sourceFile: { select: { fileName: true, scanStatus: true } },
      lines: { orderBy: { lineNo: 'asc' }, select: { codingConfirmedAt: true, poLineId: true, description: true, quantity: true, uom: true, unitPriceSatang: true, netSatang: true } },
    },
  })
  if (!inv) return null
  const po = await db.purchaseOrder.findFirst({ where: { AND: [portalWhere(ctx, 'purchaseOrder'), { id: inv.poId }] }, select: { lines: { orderBy: { lineNo: 'asc' }, select: { id: true, lineNo: true, description: true, uom: true, quantity: true, unitPriceSatang: true } } } })
  return {
    ...rowOf(inv),
    poId: inv.poId,
    version: inv.version,
    priceIncludesVat: inv.priceIncludesVat,
    netSatang: inv.netSatang.toString(),
    vatSatang: inv.statedVatSatang.toString(),
    discountSatang: inv.discountSatang.toString(),
    lines: inv.lines.map((l) => ({ poLineId: l.poLineId, description: l.description, quantity: l.quantity.toString(), uom: l.uom, unitPriceSatang: l.unitPriceSatang.toString(), netSatang: l.netSatang.toString() })),
    poLines: (po?.lines ?? []).map((l) => ({ id: l.id, lineNo: l.lineNo, description: l.description, uom: l.uom, quantity: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang.toString() })),
    file: inv.sourceFile ? { fileName: inv.sourceFile.fileName, scanned: inv.sourceFile.scanStatus === 'CLEAN' || inv.sourceFile.scanStatus === 'NOT_REQUIRED' } : null,
    timeline: { sentAt: inv.createdAt.toISOString(), receivedAt: inv.submittedAt?.toISOString() ?? null, readyAt: inv.readyAt?.toISOString() ?? null, rejectedAt: inv.rejectedAt?.toISOString() ?? null },
  }
}

export interface PortalInvoicePoRow {
  readonly id: string
  readonly number: string | null
  readonly sentAt: string | null
  readonly grossSatang: string
}

/** /portal/<org>/invoices/new: the supplier's POs that take a tier-2 invoice (BR-MATCH-05 · BR-IVC-06); the command checks again */
export async function listPortalInvoicePos(ctx: Ctx): Promise<PortalInvoicePoRow[]> {
  if (!(await invoicingSupplier(ctx))) return []
  const rows = await forTenant(ctx.organizationId).purchaseOrder.findMany({
    where: { AND: [portalWhere(ctx, 'purchaseOrder'), { OR: [{ invoiceTrack: 'MATCHING' }, { invoiceTrack: null, invoices: { none: {} } }] }] },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    take: 200,
    select: { id: true, number: true, sentAt: true, grossSatang: true },
  })
  return rows.map((r) => ({ id: r.id, number: r.number, sentAt: r.sentAt?.toISOString() ?? null, grossSatang: r.grossSatang.toString() }))
}

export interface PortalPaymentRow {
  readonly id: string
  readonly runNumber: string | null
  readonly status: 'PAID' | 'FAILED'
  readonly paidOn: string | null
  readonly payableSatang: string
  readonly whtSatang: string
  readonly transferSatang: string
  readonly bankName: string | null
  /** The last four digits of the account paid to — the number itself never leaves the server */
  readonly last4: string | null
  readonly failureReason: string | null
  /** The supplier's invoice numbers the payment covers (BCS's number when it has none) */
  readonly invoices: readonly string[]
  readonly certificate: { readonly id: string; readonly number: string } | null
}

/** /portal/<org>/payments: what was paid to the supplier, or failed, the newest first (FR-PAY-103 AC8) */
export async function listPortalPayments(ctx: Ctx): Promise<PortalPaymentRow[]> {
  if (!(await invoicingSupplier(ctx))) return []
  const rows = await forTenant(ctx.organizationId).paymentRunItem.findMany({
    where: portalWhere(ctx, 'paymentRunItem'),
    orderBy: [{ resultRecordedAt: 'desc' }, { id: 'desc' }],
    take: 200,
    select: {
      id: true,
      status: true,
      paidOn: true,
      payableSatang: true,
      whtSatang: true,
      transferSatang: true,
      payeeBankCode: true,
      payeeAccountNo: true,
      failureReason: true,
      run: { select: { number: true } },
      documents: { where: { invoiceId: { not: null } }, select: { invoice: { select: { supplierInvoiceNo: true, number: true } } } },
      whtCertificate: { select: { id: true, number: true, fileId: true } },
    },
  })
  return rows.map((r) => ({
    id: r.id,
    runNumber: r.run.number,
    status: r.status === 'PAID' ? 'PAID' : 'FAILED',
    paidOn: day(r.paidOn),
    payableSatang: r.payableSatang.toString(),
    whtSatang: r.whtSatang.toString(),
    transferSatang: r.transferSatang.toString(),
    bankName: r.payeeBankCode ? (bankOf(r.payeeBankCode)?.nameTh ?? r.payeeBankCode) : null,
    last4: r.payeeAccountNo ? r.payeeAccountNo.slice(-4) : null,
    failureReason: r.status === 'FAILED' ? r.failureReason : null,
    invoices: [...new Set(r.documents.map((d) => d.invoice?.supplierInvoiceNo ?? d.invoice?.number ?? '').filter((n) => n !== ''))],
    certificate: r.status === 'PAID' && r.whtCertificate?.fileId ? { id: r.whtCertificate.id, number: r.whtCertificate.number } : null,
  }))
}

/** The home's line of each invoice rejected in the last 30 days, to send again (provider of PORTAL_HOME_PROVIDERS) */
export async function listPortalRejectedInvoiceTodos(ctx: Ctx): Promise<Array<{ kind: string; page: string; values: Record<string, string> }>> {
  if (!(await invoicingSupplier(ctx))) return []
  const since = new Date(ctx.now.getTime() - 30 * MS_PER_DAY)
  const rows = await forTenant(ctx.organizationId).invoice.findMany({ where: { AND: [portalWhere(ctx, 'invoice'), { status: 'REJECTED', rejectedAt: { gte: since } }] }, orderBy: [{ rejectedAt: 'desc' }, { id: 'desc' }], take: 20, select: { id: true, supplierInvoiceNo: true, number: true } })
  return rows.map((r) => {
    const no = r.supplierInvoiceNo ?? r.number ?? ''
    return { kind: 'INVOICE_REJECTED', page: `/invoices/${r.id}`, values: { typeTh: no, typeEn: no } }
  })
}
