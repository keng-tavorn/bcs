import { z } from 'zod'
import { actualize, closePo } from '@/core/budget'
import { confirmInvoice, normalizeInvoiceNo } from '@/core/invoice'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { vatFromNet, type Satang } from '@/core/money/math'
import type { AppError } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { applyBudget, type BudgetOperation } from '@/server/budget/ledger'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { claimTrack } from '../ap/track'
import { requireModule } from '../modules'
import { invoiceFileInUse, loadInvoiceFile, sourceOf, type InvoiceFileRefusal, type InvoiceSource } from './source'

export { readEtaxFile, readEtaxXml, type EtaxPrefill, type EtaxProblem, type EtaxReading } from './etax'

// Simple invoice confirmation, tier 1 (spec §7.12, BR-IVC-01 to BR-IVC-04, FR-P2P-008): FINANCE records an invoice the
// supplier sent against its PO — number, date, amount before VAT, VAT and whether it is the last. The amount before VAT
// never exceeds what the PO still holds (INVOICE_EXCEEDS_COMMITTED); the number is compared with the supplier's earlier
// ones without spaces, upper case (DUPLICATE_INVOICE); it is shared over the PO lines by what each still holds (largest
// remainder, core/invoice) and moves COMMITTED → ACTUAL per line. A VAT more than 1.00 baht away from the PO's rate is
// a warning, not a refusal. The last invoice on a closed PO gives back what the PO still held (BR-BUD-06); on an open
// PO it lets the PO close without keeping anything. The invoice's file and where its values came from (ETAX_XML or
// MANUAL) are decided from the stored file (./source.ts, BR-IVC-05), never taken from the caller. The answer says what
// the invoice did — its share per line, what the PO still holds, what a last invoice gives back per budget line — and
// is stored with the command, so a resend of the same submission answers exactly the same.

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'DUPLICATE_INVOICE' | 'INVOICE_EXCEEDS_COMMITTED'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const
type Fail = { ok: false; error: AppError }

/** BR-IVC-01: a VAT further than this from the PO's rate is shown as a warning (the screen's preview uses it too) */
export const VAT_TOLERANCE_SATANG = 100n
/** POs an invoice can be recorded on: sent onwards, closed included while the PO still holds something */
export const INVOICEABLE: readonly string[] = ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED']

const Amount = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/)

const RecordInput = z.strictObject({
  poId: z.uuid(),
  invoiceNo: z.string().trim().min(1).max(60),
  invoiceDate: z.iso.date(),
  net: Amount,
  vat: Amount,
  isFinal: z.boolean().default(false),
  /** The invoice's file: one the member uploaded through the e-Tax reader for this PO (FileLink ETAX or INVOICE) */
  sourceFileId: z.uuid().nullable().optional(),
  /**
   * What the caller believes the values came from. The command decides it from the stored file itself; a claim of
   * ETAX_XML that the file does not bear out is refused, never recorded (BR-IVC-05)
   */
  parsedFrom: z.enum(['MANUAL', 'ETAX_XML']).optional(),
})

const FILE_REFUSALS: Readonly<Record<InvoiceFileRefusal, string>> = {
  FILE: 'the invoice file must be one you uploaded for this purchase order, unchanged',
  FILE_OTHER_PO: 'the invoice file was uploaded for another purchase order',
  FILE_IN_USE: 'the invoice file is already the file of another invoice',
  TAX_ID_MISMATCH: 'the seller in the file is not the supplier of the purchase order',
}
const fileRefused = (reason: InvoiceFileRefusal) => fail('VALIDATION_FAILED', FILE_REFUSALS[reason], { field: 'sourceFileId', reason })

export interface RecordedInvoice {
  readonly invoiceId: string
  /** BR-IVC-04: the amount before VAT each PO line took */
  readonly allocation: Array<{ poLineId: string; net: string }>
  readonly vatWarning: { expected: string; given: string } | null
  /** Decided from the stored file (BR-IVC-05) */
  readonly parsedFrom: 'MANUAL' | 'ETAX_XML'
  /** What the PO's lines still hold after this invoice, before anything a last invoice gives back */
  readonly heldAfter: string
  /**
   * AC3, BR-BUD-06: a last invoice's give-back per budget line — given back now on a closed PO, or to be given back
   * when procurement closes an open one; null for other invoices
   */
  readonly giveBack: { when: 'NOW' | 'ON_CLOSE'; amount: string; budgetLines: Array<{ budgetLineId: string; amount: string }> } | null
}

export const recordInvoiceCommand = defineCommand({
  name: 'invoice_confirmation.record',
  capability: 'invoiceConfirmation.record',
  input: RecordInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<RecordedInvoice>> {
    const allowed = await authorize(tx, ctx, 'invoiceConfirmation.record')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!actor) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member records an invoice' } }
    // The file is read again from storage before anything is locked (it can take a moment)
    const file = input.sourceFileId ? await loadInvoiceFile(tx, { organizationId: ctx.organizationId, memberId: actor, fileId: input.sourceFileId, poId: input.poId }) : null
    if (file && !file.ok) return fileRefused(file.reason)
    const [locked] = await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [input.poId])
    if (!locked) return fail('NOT_FOUND', 'purchase order not found')
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: input.poId }, include: { lines: { orderBy: { lineNo: 'asc' } }, supplier: { select: { taxId: true } } } })
    if (!INVOICEABLE.includes(po.status)) return fail('INVALID_STATE_TRANSITION', `an invoice is not recorded on a ${po.status} purchase order`, { from: po.status, command: 'invoice_confirmation.record' })
    // BR-IVC-06: a PO takes tier-1 confirmations or tier-2 invoices, never both
    const track = await claimTrack(tx, po, 'CONFIRMATION', (await requireModule(ctx, 'PAY', tx)).ok)
    if (!track.ok) return track
    if (await tx.invoiceConfirmation.count({ where: { poId: po.id, isFinal: true } })) return fail('INVALID_STATE_TRANSITION', 'the last invoice of this purchase order is in', { from: po.status, command: 'invoice_confirmation.record', reason: 'FINAL_RECORDED' })
    // BR-IVC-05: where the values came from, from the file itself; under the PO's lock no other invoice takes the file
    let source: InvoiceSource = { parsedFrom: 'MANUAL', kind: 'INVOICE' }
    if (file) {
      if (await invoiceFileInUse(tx, file.file.fileId)) return fileRefused('FILE_IN_USE')
      const decided = sourceOf(file.file, po.supplier.taxId, input)
      if (!decided.ok) return fileRefused(decided.reason)
      source = decided.source
    }
    if (input.parsedFrom === 'ETAX_XML' && source.parsedFrom !== 'ETAX_XML') return fail('VALIDATION_FAILED', 'the values are not the ones read from an e-Tax file of this purchase order', { field: 'parsedFrom', reason: 'NOT_AS_READ' })

    const net = amountToSatang(input.net)
    const vat = amountToSatang(input.vat)
    if (net <= 0n) return fail('VALIDATION_FAILED', 'an amount before VAT above zero is needed', { field: 'net', reason: 'AMOUNT_NOT_POSITIVE' })
    // What each PO line still holds, in line order (BR-IVC-04 shares by it)
    const held = await tx.budgetAllocation.findMany({ where: { sourceType: 'PO_LINE', sourceId: { in: po.lines.map((l) => l.id) } }, select: { sourceId: true, committedSatang: true } })
    const remaining = po.lines.map((l) => held.find((h) => h.sourceId === l.id)?.committedSatang ?? 0n)
    const earlier = await tx.invoiceConfirmation.findMany({ where: { supplierId: po.supplierId }, select: { invoiceNoNormalized: true } })
    const confirmed = confirmInvoice(remaining, net, input.invoiceNo, new Set(earlier.map((e) => e.invoiceNoNormalized)))
    if (!confirmed.ok) {
      return confirmed.error === 'DUPLICATE_INVOICE'
        ? fail('DUPLICATE_INVOICE', 'the supplier already has an invoice with this number', { invoiceNo: normalizeInvoiceNo(input.invoiceNo) })
        : fail('INVOICE_EXCEEDS_COMMITTED', 'the invoice is above what the purchase order still holds', { remaining: satangToAmount(confirmed.remainingTotal) })
    }

    // BR-BUD-04 per line: COMMITTED → ACTUAL; the last invoice on a closed PO also gives back what is left (BR-BUD-06)
    const operations: BudgetOperation[] = []
    po.lines.forEach((line, i) => {
      const part = confirmed.allocation[i]!
      if (part > 0n) operations.push({ budgetLineId: line.budgetLineId, document: { type: 'PURCHASE_ORDER', id: po.id }, run: (s) => actualize(s, line.id, part) })
    })
    if (input.isFinal && po.status === 'CLOSED') {
      for (const line of po.lines) operations.push({ budgetLineId: line.budgetLineId, document: { type: 'PURCHASE_ORDER', id: po.id }, run: (s) => closePo(s, line.id, 0n) })
    }
    const budget = await applyBudget(tx, ctx, operations)
    if (!budget.ok) return budget as Fail

    const invoiceId = await tx.invoiceConfirmation
      .create({
        data: {
          organizationId: ctx.organizationId,
          poId: po.id,
          supplierId: po.supplierId,
          invoiceNo: input.invoiceNo,
          invoiceNoNormalized: confirmed.normalizedNo,
          invoiceDate: new Date(`${input.invoiceDate}T00:00:00Z`),
          netSatang: net,
          vatSatang: vat,
          grossSatang: net + vat,
          isFinal: input.isFinal,
          sourceFileId: file ? file.file.fileId : null,
          parsedFrom: source.parsedFrom,
          recordedById: actor,
          recordedAt: ctx.now,
        },
        select: { id: true },
      })
      .then((r) => r.id)
    const parts = po.lines.map((line, i) => ({ poLineId: line.id, netSatang: confirmed.allocation[i]! })).filter((p) => p.netSatang > 0n)
    await tx.invoiceLineAllocation.createMany({ data: parts.map((p) => ({ organizationId: ctx.organizationId, invoiceId, poLineId: p.poLineId, netSatang: p.netSatang })) })
    if (file) {
      await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId: file.file.fileId, subjectType: 'InvoiceConfirmation', subjectId: invoiceId, kind: source.kind } })
    }

    // BR-IVC-01: the VAT on the invoice against the PO's rate, as a warning
    const expectedVat: Satang = vatFromNet(net, po.vatRateBp ?? 0).vat
    const gap = vat > expectedVat ? vat - expectedVat : expectedVat - vat
    const vatWarning = gap > VAT_TOLERANCE_SATANG ? { expected: satangToAmount(expectedVat), given: satangToAmount(vat) } : null
    const events: EventDraft[] = [
      {
        type: 'invoice_confirmation.recorded',
        aggregateType: 'InvoiceConfirmation',
        aggregateId: invoiceId,
        data: {
          poId: po.id,
          supplierId: po.supplierId,
          invoiceNoNormalized: confirmed.normalizedNo,
          netSatang: net.toString(),
          vatSatang: vat.toString(),
          isFinal: input.isFinal,
          parsedFrom: source.parsedFrom,
          allocation: parts.map((p) => ({ poLineId: p.poLineId, netSatang: p.netSatang.toString() })),
          vatWarning: vatWarning !== null,
        },
      },
      ...budget.events,
    ]
    // What each budget line of the PO still holds after this invoice: a last invoice gives it back (BR-BUD-06)
    const heldAfter = new Map<string, Satang>()
    po.lines.forEach((line, i) => heldAfter.set(line.budgetLineId, (heldAfter.get(line.budgetLineId) ?? 0n) + confirmed.remaining[i]!))
    const heldTotal = confirmed.remaining.reduce((a, b) => a + b, 0n)
    const giveBack: RecordedInvoice['giveBack'] = input.isFinal
      ? {
          when: po.status === 'CLOSED' ? 'NOW' : 'ON_CLOSE',
          amount: satangToAmount(heldTotal),
          budgetLines: [...heldAfter].filter(([, amount]) => amount > 0n).map(([budgetLineId, amount]) => ({ budgetLineId, amount: satangToAmount(amount) })),
        }
      : null
    return {
      ok: true,
      result: { invoiceId, allocation: parts.map((p) => ({ poLineId: p.poLineId, net: satangToAmount(p.netSatang) })), vatWarning, parsedFrom: source.parsedFrom, heldAfter: satangToAmount(heldTotal), giveBack },
      events,
    }
  },
})

export function recordInvoice(ctx: Ctx, input: z.input<typeof RecordInput>, options: RunOptions) {
  return runCommand(ctx, recordInvoiceCommand, input, options)
}
