import { z } from 'zod'
import { amountToSatang } from '@/core/money/dto'
import type { Ctx } from '@/server/context'
import { readEtaxFile, recordInvoice } from '@/server/services/invoices'
import { getInvoicePoView, previewInvoice } from '@/server/services/invoices/view'
import { cleanAmount, isIsoDay } from '@/ui/finance/money'
import { toFinanceFailure, type EtaxOutcome, type FinanceFailure, type PreviewOutcome, type RecordOutcome } from '@/ui/finance/outcome'
import type { EtaxProblemKey } from '@/ui/finance/types'
import { formatTaxId } from '@/ui/suppliers/model'
import type { Locale } from '../../_tracking/present'
import { amountText, giveBackView, money, movesOf, partsOf, previewView } from '../present'

// The commands behind the invoice page (S4-08, S4-17, FR-P2P-008), apart from the session and the page cache so tests
// run them with a context. Every input is parsed first, so a malformed call gets VALIDATION_FAILED and never a crash;
// amounts typed with thousands separators are cleaned. Then the service decides and checks the permission again
// (invoiceConfirmation.record), so a hidden button is never the guard (BR-AUTH-05). The browser sends the file it
// uploaded, never where the values came from: the service decides that from the stored file (BR-IVC-05). What an
// invoice did — its share per PO line, the budget moved from committed to actual (AC2), what a last invoice gives back
// (AC3) — comes from the command's answer, which a resend of the same submission repeats exactly; the PO read
// afterwards only names the lines and says what is still to come.

const Key = z.uuid()
const FormInput = z.object({
  poId: z.string().max(64),
  invoiceNo: z.string().max(200),
  invoiceDate: z.string().max(20),
  net: z.string().max(40),
  vat: z.string().max(40),
  isFinal: z.boolean(),
  /** The file the e-Tax reader kept for this invoice, if any; anything else the browser sends is dropped */
  sourceFileId: z.uuid().nullable().default(null),
})
const INVOICE_NO_MAX = 60
const ETAX_PROBLEMS: readonly EtaxProblemKey[] = ['XML_UNREADABLE', 'NOT_AN_ETAX_INVOICE', 'VALUE_MISSING', 'TAX_ID_MISMATCH']

const invalid = (field: string, reason?: string): FinanceFailure => ({ ok: false, code: 'VALIDATION_FAILED', field, ...(reason ? { reason } : {}) })

function failure(error: { code: string; details?: Readonly<Record<string, unknown>> }): FinanceFailure {
  const remaining = typeof error.details?.remaining === 'string' ? amountText(error.details.remaining) : undefined
  return toFinanceFailure(error, remaining)
}

type Cleaned = { poId: string; invoiceNo: string; invoiceDate: string; net: string; vat: string; isFinal: boolean; sourceFileId: string | null }

/** The form's values as the service takes them, or the first field that is wrong */
function cleaned(input: z.infer<typeof FormInput>): { ok: true; value: Cleaned } | FinanceFailure {
  const invoiceNo = input.invoiceNo.trim()
  if (!invoiceNo || invoiceNo.length > INVOICE_NO_MAX) return invalid('invoiceNo')
  if (!isIsoDay(input.invoiceDate)) return invalid('invoiceDate')
  const net = cleanAmount(input.net)
  if (net === null) return invalid('net')
  if (amountToSatang(net) <= 0n) return invalid('net', 'AMOUNT_NOT_POSITIVE')
  const vat = cleanAmount(input.vat)
  if (vat === null) return invalid('vat')
  return { ok: true, value: { poId: input.poId, invoiceNo, invoiceDate: input.invoiceDate, net, vat, isFinal: input.isFinal, sourceFileId: input.sourceFileId } }
}

/** What recording the invoice will do (§9.9 principle 3), or why it would be refused */
export async function previewInvoiceFor(ctx: Ctx, input: unknown, locale: Locale): Promise<PreviewOutcome> {
  const parsed = FormInput.safeParse(input)
  if (!parsed.success) return invalid('input')
  const value = cleaned(parsed.data)
  if (!value.ok) return value
  const result = await previewInvoice(ctx, value.value)
  return result.ok ? { ok: true, preview: previewView(result.data, locale) } : failure(result.error)
}

/** Records the invoice (invoice_confirmation.record) and says what it did */
export async function recordInvoiceFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<RecordOutcome> {
  if (!Key.safeParse(idempotencyKey).success) return invalid('idempotencyKey')
  const parsed = FormInput.safeParse(input)
  if (!parsed.success) return invalid(String(parsed.error.issues[0]?.path[0] ?? 'input'))
  const value = cleaned(parsed.data)
  if (!value.ok) return value
  const result = await recordInvoice(ctx, value.value, { idempotencyKey: idempotencyKey as string })
  if (!result.ok) return failure(result.error)
  const recorded = result.data
  // The PO as it is now: the names of its lines, and what a PO still open waits for before it can close
  const po = await getInvoicePoView(ctx, value.value.poId)
  if (!po.ok) return failure(po.error)
  const parts = partsOf(
    po.data,
    recorded.allocation.map((a) => ({ poLineId: a.poLineId, netSatang: amountToSatang(a.net) })),
  )
  const giveBack = recorded.giveBack
  return {
    ok: true,
    done: {
      invoiceNo: value.value.invoiceNo,
      parts: parts.map(({ poLineId, description, budgetLine, amount }) => ({ poLineId, description, budgetLine, amount })),
      moves: movesOf(parts.map((p) => ({ budgetLine: p.budgetLineRef, netSatang: p.netSatang }))),
      vatWarning: recorded.vatWarning ? { expected: amountText(recorded.vatWarning.expected)!, given: amountText(recorded.vatWarning.given)! } : null,
      isFinal: value.value.isFinal,
      parsedFrom: recorded.parsedFrom,
      giveBack: giveBack ? giveBackView({ when: giveBack.when, amountSatang: amountToSatang(giveBack.amount), unsettledLines: giveBack.when === 'ON_CLOSE' ? po.data.unsettledLines : 0 }) : null,
      heldAfter: money(amountToSatang(recorded.heldAfter)),
      more: !value.value.isFinal && po.data.blocked === null,
    },
  }
}

/** Reads an e-Tax file (BR-IVC-05): the values to fill the form with, or why they cannot be read */
export async function readEtaxFor(ctx: Ctx, poId: string, fileName: string, content: Uint8Array): Promise<EtaxOutcome> {
  if (!z.uuid().safeParse(poId).success) return { ok: false, code: 'NOT_FOUND' }
  const result = await readEtaxFile(ctx, { poId, fileName, content })
  if (!result.ok) return failure(result.error)
  const { fileId, prefill, problems } = result.data
  return {
    ok: true,
    fileId,
    fileName: fileName.trim() || fileId,
    prefill: prefill
      ? { invoiceNo: prefill.invoiceNo, invoiceDate: prefill.invoiceDate, net: prefill.net, vat: prefill.vat, gross: prefill.gross, sellerTaxId: formatTaxId(prefill.sellerTaxId), sellerBranch: prefill.sellerBranch }
      : null,
    problems: problems.filter((p): p is EtaxProblemKey => ETAX_PROBLEMS.includes(p)),
  }
}
