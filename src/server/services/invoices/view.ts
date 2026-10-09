import { z } from 'zod'
import { confirmInvoice, normalizeInvoiceNo } from '@/core/invoice'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { vatFromNet, type Satang } from '@/core/money/math'
import { err, ok, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import {
  countInvoicesNotExported,
  getInvoicePo,
  countInvoiceablePos,
  listInvoiceablePos,
  listRecordedInvoices,
  supplierInvoiceNumbers,
  type InvoiceableFilter,
  type InvoiceablePoListDto,
  type InvoicePoDto,
  type RecordedInvoiceDto,
} from '@/server/queries/finance'
import { INVOICEABLE, VAT_TOLERANCE_SATANG } from './index'
import { invoiceFileInUse, loadInvoiceFile, sourceOf, type InvoiceSource } from './source'

// What the invoice screens show (spec §9.1 /finance/invoices, S4-08, S4-17, FR-P2P-008, §9.9 principle 3): the POs
// that wait for an invoice and the invoices recorded lately, one PO with what each line holds, and — before anything is
// recorded — what an invoice will do: how its amount before VAT is shared over the PO lines (BR-IVC-04), the budget it
// moves from committed to actual on each budget line (AC2), its VAT against the PO's rate (BR-IVC-01), what a last
// invoice gives back (AC3, BR-BUD-06), and whether it will be recorded as read from its e-Tax file or as typed
// (BR-IVC-05, ./source.ts). The preview reads only and decides with core/invoice and ./source.ts exactly as the
// invoice_confirmation.record command does, which checks everything again under lock. Only FINANCE
// (invoiceConfirmation.record, §2.4) sees any of it.

const Amount = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/)

/** The member, when they are FINANCE */
async function financeOnly(ctx: Ctx): Promise<Result<string>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'invoiceConfirmation.record'))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  if (allowed.data.kind !== 'member') return err('FORBIDDEN', 'members only')
  return ok(allowed.data.memberId)
}

// ---------- the list (/finance/invoices) ----------

export interface InvoiceWorkDto {
  /** POs that wait for an invoice */
  readonly waiting: InvoiceablePoListDto
  /** How many POs wait for an invoice in the filter, on every page (the home's to-do row counts the same) */
  readonly waitingCount: number
  /** Invoices recorded, last first */
  readonly recorded: { readonly rows: readonly RecordedInvoiceDto[]; readonly limited: boolean }
  /** Invoices not in an Express file yet (the export page's work) */
  readonly notExported: number
}

/** /finance/invoices: `received` narrows the POs waiting for an invoice to those with goods received (?gr=posted) */
export async function listInvoiceWork(ctx: Ctx, filter: InvoiceableFilter = {}): Promise<Result<InvoiceWorkDto>> {
  const allowed = await financeOnly(ctx)
  if (!allowed.ok) return allowed
  const [waiting, waitingCount, recorded, notExported] = await Promise.all([
    listInvoiceablePos(ctx, filter),
    countInvoiceablePos(ctx, filter),
    listRecordedInvoices(ctx, { q: filter.q }),
    countInvoicesNotExported(ctx),
  ])
  return ok({ waiting, waitingCount, recorded, notExported })
}

/** The home's row "ใบกำกับรอยืนยัน" (§9.10): POs with goods received and no last invoice, as /finance/invoices?gr=posted lists them */
export async function countInvoicesToConfirm(ctx: Ctx): Promise<number | null> {
  const allowed = await financeOnly(ctx)
  return allowed.ok ? countInvoiceablePos(ctx, { received: true }) : null
}

// ---------- one PO (/finance/invoices/[poId]) ----------

/** Why no invoice can be recorded on the PO now (the command refuses the same) */
export type InvoiceBlock = 'NOT_SENT' | 'CANCELLED' | 'FINAL_RECORDED' | 'NOTHING_HELD'

export interface InvoicePoViewDto extends InvoicePoDto {
  readonly blocked: InvoiceBlock | null
}

function blockOf(po: InvoicePoDto): InvoiceBlock | null {
  if (!INVOICEABLE.includes(po.status)) return po.status === 'CANCELLED' ? 'CANCELLED' : 'NOT_SENT'
  if (po.finalRecorded) return 'FINAL_RECORDED'
  if (po.heldSatang <= 0n) return 'NOTHING_HELD'
  return null
}

export async function getInvoicePoView(ctx: Ctx, poId: string): Promise<Result<InvoicePoViewDto>> {
  const allowed = await financeOnly(ctx)
  if (!allowed.ok) return allowed
  const po = await getInvoicePo(ctx, poId)
  if (!po) return err('NOT_FOUND', 'purchase order not found')
  return ok({ ...po, blocked: blockOf(po) })
}

// ---------- what an invoice will do, before it is recorded ----------

const PreviewInput = z.strictObject({
  poId: z.uuid(),
  invoiceNo: z.string().trim().min(1).max(60),
  invoiceDate: z.iso.date(),
  net: Amount,
  vat: Amount,
  isFinal: z.boolean().default(false),
  /** The file to be kept with the invoice, as the command takes it */
  sourceFileId: z.uuid().nullable().optional(),
})

export type InvoicePreviewInput = z.input<typeof PreviewInput>

export interface BudgetLineRefDto {
  readonly id: string
  readonly code: string
  readonly name: string
}

export interface InvoicePreviewDto {
  readonly invoiceNo: string
  readonly invoiceDate: string
  readonly netSatang: Satang
  readonly vatSatang: Satang
  readonly grossSatang: Satang
  readonly vatRateBp: number | null
  /** The VAT of the amount before VAT at the PO's rate */
  readonly expectedVatSatang: Satang
  /** BR-IVC-01: more than 1.00 baht away from the expected VAT — a warning, never a refusal */
  readonly vatWarning: boolean
  /** BR-IVC-04: the amount before VAT each PO line takes (lines that take nothing are left out) */
  readonly parts: ReadonlyArray<{ readonly poLineId: string; readonly lineNo: number; readonly description: string; readonly budgetLine: BudgetLineRefDto; readonly netSatang: Satang }>
  /** AC2: what moves from committed to actual on each budget line */
  readonly byBudgetLine: ReadonlyArray<{ readonly budgetLine: BudgetLineRefDto; readonly netSatang: Satang }>
  readonly heldBeforeSatang: Satang
  readonly heldAfterSatang: Satang
  readonly isFinal: boolean
  readonly poStatus: string
  /**
   * AC3, BR-BUD-06: a last invoice gives back what the PO still holds after it — at once on a closed PO, or when
   * procurement closes it (which waits for `unsettledLines` to be received or closed short); null for other invoices
   */
  readonly giveBack: { readonly when: 'NOW' | 'ON_CLOSE'; readonly amountSatang: Satang; readonly unsettledLines: number } | null
  /** BR-IVC-05: as the command will record it — read from the e-Tax file, or typed (with or without the file kept) */
  readonly source: InvoiceSource & { readonly withFile: boolean }
}

const fieldOf = (error: z.ZodError): string => String(error.issues[0]?.path[0] ?? 'input')

/** What recording this invoice would do; refuses what the command would refuse, with the same codes and details */
export async function previewInvoice(ctx: Ctx, input: unknown): Promise<Result<InvoicePreviewDto>> {
  const parsed = PreviewInput.safeParse(input)
  if (!parsed.success) return err('VALIDATION_FAILED', 'the invoice is not complete', { field: fieldOf(parsed.error) })
  const allowed = await financeOnly(ctx)
  if (!allowed.ok) return allowed
  const v = parsed.data
  const db = forTenant(ctx.organizationId)
  // The same checks of the file as the command, in the same order (./source.ts)
  const fileRefused = (reason: string) => err('VALIDATION_FAILED', 'the invoice file cannot go with this invoice', { field: 'sourceFileId', reason })
  const file = v.sourceFileId ? await loadInvoiceFile(db, { organizationId: ctx.organizationId, memberId: allowed.data, fileId: v.sourceFileId, poId: v.poId }) : null
  if (file && !file.ok) return fileRefused(file.reason)
  const po = await getInvoicePo(ctx, v.poId)
  if (!po) return err('NOT_FOUND', 'purchase order not found')
  if (!INVOICEABLE.includes(po.status)) return err('INVALID_STATE_TRANSITION', `an invoice is not recorded on a ${po.status} purchase order`, { from: po.status, command: 'invoice_confirmation.record' })
  if (po.finalRecorded) return err('INVALID_STATE_TRANSITION', 'the last invoice of this purchase order is in', { from: po.status, command: 'invoice_confirmation.record', reason: 'FINAL_RECORDED' })
  let source: InvoiceSource = { parsedFrom: 'MANUAL', kind: 'INVOICE' }
  if (file) {
    if (await invoiceFileInUse(db, file.file.fileId)) return fileRefused('FILE_IN_USE')
    const decided = sourceOf(file.file, po.supplier.taxId, v)
    if (!decided.ok) return fileRefused(decided.reason)
    source = decided.source
  }
  const net = amountToSatang(v.net)
  const vat = amountToSatang(v.vat)
  if (net <= 0n) return err('VALIDATION_FAILED', 'an amount before VAT above zero is needed', { field: 'net', reason: 'AMOUNT_NOT_POSITIVE' })

  const remaining = po.lines.map((l) => l.committedSatang)
  const confirmed = confirmInvoice(remaining, net, v.invoiceNo, await supplierInvoiceNumbers(ctx, po.supplier.id))
  if (!confirmed.ok) {
    return confirmed.error === 'DUPLICATE_INVOICE'
      ? err('DUPLICATE_INVOICE', 'the supplier already has an invoice with this number', { invoiceNo: normalizeInvoiceNo(v.invoiceNo) })
      : err('INVOICE_EXCEEDS_COMMITTED', 'the invoice is above what the purchase order still holds', { remaining: satangToAmount(confirmed.remainingTotal) })
  }

  const parts = po.lines.flatMap((line, i) => {
    const part = confirmed.allocation[i]!
    return part > 0n ? [{ poLineId: line.id, lineNo: line.lineNo, description: line.description, budgetLine: line.budgetLine, netSatang: part }] : []
  })
  const byBudgetLine = new Map<string, { budgetLine: BudgetLineRefDto; netSatang: Satang }>()
  for (const p of parts) byBudgetLine.set(p.budgetLine.id, { budgetLine: p.budgetLine, netSatang: (byBudgetLine.get(p.budgetLine.id)?.netSatang ?? 0n) + p.netSatang })
  const expectedVat = vatFromNet(net, po.totals.vatRateBp ?? 0).vat
  const gap = vat > expectedVat ? vat - expectedVat : expectedVat - vat
  const heldAfter = confirmed.remaining.reduce((a, b) => a + b, 0n)
  return ok({
    invoiceNo: v.invoiceNo,
    invoiceDate: v.invoiceDate,
    netSatang: net,
    vatSatang: vat,
    grossSatang: net + vat,
    vatRateBp: po.totals.vatRateBp,
    expectedVatSatang: expectedVat,
    vatWarning: gap > VAT_TOLERANCE_SATANG,
    parts,
    byBudgetLine: [...byBudgetLine.values()],
    heldBeforeSatang: po.heldSatang,
    heldAfterSatang: heldAfter,
    isFinal: v.isFinal,
    poStatus: po.status,
    giveBack: v.isFinal ? { when: po.status === 'CLOSED' ? 'NOW' : 'ON_CLOSE', amountSatang: heldAfter, unsettledLines: po.unsettledLines } : null,
    source: { ...source, withFile: file !== null },
  })
}
