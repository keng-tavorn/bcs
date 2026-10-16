import { z } from 'zod'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { cancelApprovedPaymentRun, generatePaymentFile, markPaymentRunSentToBank, regeneratePaymentFile, requestPaymentFileDownload, revertPaymentRunSent } from '@/server/services/payments/files'
import { recordPaymentResults, resendPaymentAdvice } from '@/server/services/payments/results'
import { addPaymentDocuments, cancelPaymentRun, createPaymentRun, removePaymentDocuments, setPaymentFlagReason, submitPaymentRun } from '@/server/services/payments/runs'
import { paymentRunState, proposedDocuments } from '@/server/services/payments/view'
import { toPayFailure, type PayFailure, type PayOutcome } from '@/ui/payments/outcome'

// The commands behind the payment run screens (S9-09: /finance/payments/new and /finance/payments/[id]), apart from the
// session and the page cache so tests run them with a context. Every input is parsed first, so a malformed call gets
// VALIDATION_FAILED and never a crash; then the S9 service decides and checks the capability, module PAY, the preparer
// (BR-PAY-09) and the run's state again, so a hidden button is never the guard (BR-AUTH-05). Each command runs with the
// idempotencyKey of its form (spec §4.3); "สร้างร่าง" runs two commands, the second under the form's key with
// ":documents" after it, so the same submission sent twice makes one draft with its documents once. The download is a
// POST: the command writes who downloaded which version, then answers an address made now (never a GET, BR-BANK-08).

const Key = z.uuid()
const Id = z.uuid()
const Version = z.number().int().min(0)
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const Reason = z.string().max(REASON_MAX_LENGTH)
const REASON_MIN = 3
const REFERENCE_MAX = 100

const invalid = (field: string, reason?: string): PayFailure => ({ ok: false, code: 'VALIDATION_FAILED', field, ...(reason ? { reason } : {}) })
const BAD_KEY = invalid('idempotencyKey')
const firstField = (error: z.ZodError) => error.issues[0]?.path.map(String).join('.') || 'input'

type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; details?: Readonly<Record<string, unknown>> } }
const done = <T,>(result: ServiceResult<T>): PayOutcome => (result.ok ? { ok: true } : toPayFailure(result.error))

/** A reason the member wrote: trimmed, at least three letters (the services' rule), said at its field otherwise */
function reasonOf(value: string): string | PayFailure {
  const reason = value.trim()
  return reason.length < REASON_MIN ? invalid('reason', 'REQUIRED') : reason
}

/** Parses the input and the key, or says which field is wrong */
function parse<S extends z.ZodType>(schema: S, input: unknown, idempotencyKey: unknown): { ok: true; data: z.infer<S>; key: string } | PayFailure {
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const parsed = schema.safeParse(input)
  if (!parsed.success) return invalid(firstField(parsed.error))
  return { ok: true, data: parsed.data, key: idempotencyKey as string }
}

// ---------- /finance/payments/new ----------

const CreateInput = z.strictObject({ payerBankAccountId: Id, payDate: Day })

/**
 * "สร้างร่าง" (FR-PAY-101 AC1): the draft from the payer and the pay date the member chose, then the documents the
 * proposal of that date takes (BR-PAY-03: invoices due by the pay date, every released retention). A draft whose
 * documents could not go in is still made: the outcome says why, and the member adds them on its page.
 */
export async function createRunFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PayOutcome> {
  const p = parse(CreateInput, input, idempotencyKey)
  if (!p.ok) return p
  const created = await createPaymentRun(ctx, p.data, { idempotencyKey: p.key })
  if (!created.ok) return toPayFailure(created.error)
  const paymentRunId = created.data.paymentRunId
  const state = await paymentRunState(ctx, paymentRunId)
  if (!state.ok) return { ok: true, paymentRunId, added: 0, addFailure: toPayFailure(state.error) }
  // the same submission again: its documents went in the first time
  if (state.data.version > 0 || state.data.documentCount > 0) return { ok: true, paymentRunId, added: state.data.documentCount }
  const docs = await proposedDocuments(ctx, created.data.payDate)
  if (!docs.ok) return { ok: true, paymentRunId, added: 0, addFailure: toPayFailure(docs.error) }
  const count = docs.data.invoiceIds.length + docs.data.retentionIds.length
  if (count === 0) return { ok: true, paymentRunId, added: 0 }
  const added = await addPaymentDocuments(ctx, { paymentRunId, version: state.data.version, ...docs.data }, { idempotencyKey: `${p.key}:documents` })
  return added.ok ? { ok: true, paymentRunId, added: count } : { ok: true, paymentRunId, added: 0, addFailure: toPayFailure(added.error) }
}

// ---------- the draft (its preparer) ----------

const DocumentsInput = z.strictObject({ paymentRunId: Id, version: Version, invoiceIds: z.array(Id).max(500), retentionIds: z.array(Id).max(500) })

/** Adds the documents ticked in the Sheet (BR-PAY-03, BR-PAY-05: one item per supplier) */
export async function addDocumentsFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PayOutcome> {
  const p = parse(DocumentsInput, input, idempotencyKey)
  if (!p.ok) return p
  if (p.data.invoiceIds.length + p.data.retentionIds.length === 0) return invalid('invoiceIds', 'NOTHING_CHOSEN')
  return done(await addPaymentDocuments(ctx, p.data, { idempotencyKey: p.key }))
}

/** Takes documents out of the draft: S8 makes them ready for payment again */
export async function removeDocumentsFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PayOutcome> {
  const p = parse(DocumentsInput, input, idempotencyKey)
  if (!p.ok) return p
  if (p.data.invoiceIds.length + p.data.retentionIds.length === 0) return invalid('invoiceIds', 'NOTHING_CHOSEN')
  return done(await removePaymentDocuments(ctx, p.data, { idempotencyKey: p.key }))
}

const FlagReasonInput = z.strictObject({ paymentRunId: Id, version: Version, supplierId: Id, reason: Reason })

/** BR-PAY-06: the preparer's reason for the flags of a supplier's item, which the approver reads */
export async function setFlagReasonFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PayOutcome> {
  const p = parse(FlagReasonInput, input, idempotencyKey)
  if (!p.ok) return p
  const reason = reasonOf(p.data.reason)
  if (typeof reason !== 'string') return reason
  return done(await setPaymentFlagReason(ctx, { ...p.data, reason }, { idempotencyKey: p.key }))
}

const RunInput = z.strictObject({ paymentRunId: Id, version: Version })

/** "ส่งขออนุมัติ" (BR-PAY-08): the run gets its number and goes to its approver under DOA PAYMENT_RUN */
export async function submitRunFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PayOutcome> {
  const p = parse(RunInput, input, idempotencyKey)
  if (!p.ok) return p
  const result = await submitPaymentRun(ctx, p.data, { idempotencyKey: p.key })
  return result.ok ? { ok: true, number: result.data.number } : toPayFailure(result.error)
}

const ReasonInput = z.strictObject({ paymentRunId: Id, version: Version, reason: Reason })

/** A draft or a run waiting for approval, cancelled by its preparer with a reason: every document back to S8 */
export async function cancelDraftFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PayOutcome> {
  const p = parse(ReasonInput, input, idempotencyKey)
  if (!p.ok) return p
  const reason = reasonOf(p.data.reason)
  if (typeof reason !== 'string') return reason
  return done(await cancelPaymentRun(ctx, { ...p.data, reason }, { idempotencyKey: p.key }))
}

// ---------- the bank file (FINANCE) ----------

/** BR-BANK-04 to BR-BANK-06: the file of an approved run, checked first */
export async function generateFileFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PayOutcome> {
  const p = parse(RunInput, input, idempotencyKey)
  if (!p.ok) return p
  return done(await generatePaymentFile(ctx, p.data, { idempotencyKey: p.key }))
}

const ConfirmedReasonInput = ReasonInput.extend({ confirmNotSentToBank: z.boolean() })

/** BR-BANK-07: a new version with a reason; after a download, with the word that the old one was not sent to the bank */
export async function regenerateFileFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PayOutcome> {
  const p = parse(ConfirmedReasonInput, input, idempotencyKey)
  if (!p.ok) return p
  const reason = reasonOf(p.data.reason)
  if (typeof reason !== 'string') return reason
  return done(await regeneratePaymentFile(ctx, { ...p.data, reason }, { idempotencyKey: p.key }))
}

const DownloadInput = z.strictObject({ paymentRunId: Id, paymentFileId: Id })

/** The file in use, downloaded through the POST command: an address of five minutes made for this answer */
export async function downloadFileFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PayOutcome> {
  const p = parse(DownloadInput, input, idempotencyKey)
  if (!p.ok) return p
  const result = await requestPaymentFileDownload(ctx, p.data, { idempotencyKey: p.key })
  return result.ok ? { ok: true, url: result.data.url, fileName: result.data.fileName } : toPayFailure(result.error)
}

/** BR-PAY-11: FINANCE says the file in use went to the bank (the system sends nothing, NG-2) */
export async function markSentFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PayOutcome> {
  const p = parse(RunInput, input, idempotencyKey)
  if (!p.ok) return p
  return done(await markPaymentRunSentToBank(ctx, p.data, { idempotencyKey: p.key }))
}

/** FR-PAY-103 AC5: taken back with a reason while no result is recorded */
export async function revertSentFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PayOutcome> {
  const p = parse(ReasonInput, input, idempotencyKey)
  if (!p.ok) return p
  const reason = reasonOf(p.data.reason)
  if (typeof reason !== 'string') return reason
  return done(await revertPaymentRunSent(ctx, { ...p.data, reason }, { idempotencyKey: p.key }))
}

/** BR-PAY-10: an approved run, or one with its file, cancelled by FINANCE; after a download with "not sent to the bank" */
export async function cancelApprovedFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PayOutcome> {
  const p = parse(ConfirmedReasonInput, input, idempotencyKey)
  if (!p.ok) return p
  const reason = reasonOf(p.data.reason)
  if (typeof reason !== 'string') return reason
  return done(await cancelApprovedPaymentRun(ctx, { ...p.data, reason }, { idempotencyKey: p.key }))
}

// ---------- the results (FINANCE) ----------

const Reference = z.string().max(REFERENCE_MAX * 2)
const ItemResult = z.discriminatedUnion('outcome', [
  z.strictObject({ paymentRunItemId: Id, outcome: z.literal('PAID'), paidOn: Day, bankReference: Reference }),
  z.strictObject({ paymentRunItemId: Id, outcome: z.literal('FAILED'), reason: Reason }),
])
const ResultsInput = z.union([
  z.strictObject({ paymentRunId: Id, version: Version, items: z.array(ItemResult).min(1).max(500) }),
  z.strictObject({
    paymentRunId: Id,
    version: Version,
    allPaidExcept: z.strictObject({ paidOn: Day, bankReference: Reference, failed: z.array(z.strictObject({ paymentRunItemId: Id, reason: Reason })).max(500) }),
  }),
])

/** An optional reference: empty means none; longer than the bank's field is said at the field */
function referenceOf(value: string): string | undefined | PayFailure {
  const ref = value.trim()
  if (!ref) return undefined
  return ref.length > REFERENCE_MAX ? invalid('bankReference', 'TOO_LONG') : ref
}

/**
 * FR-PAY-103 AC1 to AC3: the results chosen item by item, or "paid, all but these" — final in phase 1 (OQ-136), so the
 * screen asks first. A failure needs its reason; a reference is optional.
 */
export async function recordResultsFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PayOutcome> {
  const p = parse(ResultsInput, input, idempotencyKey)
  if (!p.ok) return p
  const d = p.data
  let command: Parameters<typeof recordPaymentResults>[1]
  if ('items' in d) {
    const items = []
    for (const r of d.items) {
      if (r.outcome === 'PAID') {
        const ref = referenceOf(r.bankReference)
        if (typeof ref === 'object') return ref
        items.push({ paymentRunItemId: r.paymentRunItemId, outcome: 'PAID' as const, paidOn: r.paidOn, ...(ref ? { bankReference: ref } : {}) })
      } else {
        const reason = reasonOf(r.reason)
        if (typeof reason !== 'string') return reason
        items.push({ paymentRunItemId: r.paymentRunItemId, outcome: 'FAILED' as const, reason })
      }
    }
    command = { paymentRunId: d.paymentRunId, version: d.version, items }
  } else {
    const ref = referenceOf(d.allPaidExcept.bankReference)
    if (typeof ref === 'object') return ref
    const failed = []
    for (const f of d.allPaidExcept.failed) {
      const reason = reasonOf(f.reason)
      if (typeof reason !== 'string') return reason
      failed.push({ paymentRunItemId: f.paymentRunItemId, reason })
    }
    command = { paymentRunId: d.paymentRunId, version: d.version, allPaidExcept: { paidOn: d.allPaidExcept.paidOn, ...(ref ? { bankReference: ref } : {}), failed } }
  }
  const result = await recordPaymentResults(ctx, command, { idempotencyKey: p.key })
  return result.ok ? { ok: true, completed: result.data.completed } : toPayFailure(result.error)
}

const ResendInput = z.strictObject({ paymentRunItemId: Id, reason: Reason })

/** BR-PAY-13: the payment advice of a paid item sent again, with a reason */
export async function resendAdviceFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<PayOutcome> {
  const p = parse(ResendInput, input, idempotencyKey)
  if (!p.ok) return p
  const reason = reasonOf(p.data.reason)
  if (typeof reason !== 'string') return reason
  return done(await resendPaymentAdvice(ctx, { ...p.data, reason }, { idempotencyKey: p.key }))
}
