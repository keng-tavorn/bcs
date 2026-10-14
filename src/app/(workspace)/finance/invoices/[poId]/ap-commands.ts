import { z } from 'zod'
import type { Ctx } from '@/server/context'
import { cancelInvoice, confirmInvoiceCoding, submitInvoice, updateInvoice } from '@/server/services/ap'
import { dismissMatchException, recheckInvoice, rejectInvoice, reopenInvoice, requestVarianceApproval } from '@/server/services/ap/exceptions'
import { toApFailure, type ApFailure, type ApOutcome } from '@/ui/ap/invoice/outcome'
import { cleanAmount } from '@/ui/finance/money'

// The commands behind the page of one tier-2 invoice and PROCUREMENT's list of differences (S8-13, FR-AP-101 FR-AP-102
// FR-AP-103 FR-AP-105 FR-AP-108), apart from the session and the page cache so tests run them with a context. Every
// input is parsed first, so a malformed call gets VALIDATION_FAILED and never a crash; amounts typed with thousands
// separators are cleaned. Then the S8 service decides and checks the permission again (BR-AUTH-05): a hidden button is
// never the guard. The idempotencyKey comes from the form, one per submission (spec §4.3).

const Key = z.uuid()
const Version = { invoiceId: z.uuid(), version: z.number().int().min(0) }
const REASON_MAX = 500
const Reason = z.string().max(REASON_MAX)

const invalid = (field: string, reason?: string): ApFailure => ({ ok: false, code: 'VALIDATION_FAILED', field, ...(reason ? { reason } : {}) })

type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; details?: Readonly<Record<string, unknown>> } }

function outcomeOf<T extends object>(result: ServiceResult<T>): ApOutcome {
  if (!result.ok) return toApFailure(result.error)
  const data = result.data as { status?: unknown; number?: unknown }
  return { ok: true, ...(typeof data.status === 'string' ? { status: data.status } : {}), ...(typeof data.number === 'string' ? { number: data.number } : {}) }
}

/** Parses the key and the input, or says which is wrong */
function parsed<S extends z.ZodType>(schema: S, input: unknown, idempotencyKey: unknown): { ok: true; value: z.infer<S>; key: string } | ApFailure {
  if (!Key.safeParse(idempotencyKey).success) return invalid('idempotencyKey')
  const r = schema.safeParse(input)
  if (!r.success) return invalid(String(r.error.issues[0]?.path[0] ?? 'input'))
  return { ok: true, value: r.data, key: idempotencyKey as string }
}

/** A reason a person must give: trimmed, not empty */
function reasonOf(value: string): string | null {
  const r = value.trim()
  return r ? r : null
}

// ---------- the draft: header and lines (invoice.update) ----------

const UpdateInput = z.object({
  ...Version,
  supplierInvoiceNo: z.string().max(200).optional(),
  invoiceDate: z.iso.date().optional(),
  priceIncludesVat: z.boolean().optional(),
  discount: z.string().max(40).optional(),
  statedVat: z.string().max(40).optional(),
  isFinal: z.boolean().optional(),
  lines: z.array(z.object({ poLineId: z.uuid(), quantity: z.string().max(40), unitPrice: z.string().max(40) })).max(200).optional(),
})

export async function updateApInvoiceFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ApOutcome> {
  const p = parsed(UpdateInput, input, idempotencyKey)
  if (!p.ok) return p
  const v = p.value
  const amount = (field: string, typed: string | undefined): string | undefined | ApFailure => {
    if (typed === undefined) return undefined
    const clean = cleanAmount(typed)
    return clean === null ? invalid(field, 'AMOUNT') : clean
  }
  const discount = amount('discount', v.discount)
  if (typeof discount === 'object') return discount
  const statedVat = amount('statedVat', v.statedVat)
  if (typeof statedVat === 'object') return statedVat
  const supplierInvoiceNo = v.supplierInvoiceNo?.trim()
  if (supplierInvoiceNo !== undefined && !supplierInvoiceNo) return invalid('supplierInvoiceNo', 'REQUIRED')
  const lines: Array<{ poLineId: string; quantity: string; unitPrice: string }> = []
  for (const l of v.lines ?? []) {
    const quantity = l.quantity.replace(/[,\s]/g, '')
    const unitPrice = cleanAmount(l.unitPrice)
    if (!/^\d{1,14}(\.\d{1,4})?$/.test(quantity)) return invalid('lines', 'QUANTITY_NOT_POSITIVE')
    if (unitPrice === null) return invalid('lines', 'AMOUNT')
    lines.push({ poLineId: l.poLineId, quantity, unitPrice })
  }
  const result = await updateInvoice(
    ctx,
    {
      invoiceId: v.invoiceId,
      version: v.version,
      ...(supplierInvoiceNo !== undefined ? { supplierInvoiceNo } : {}),
      ...(v.invoiceDate !== undefined ? { invoiceDate: v.invoiceDate } : {}),
      ...(v.priceIncludesVat !== undefined ? { priceIncludesVat: v.priceIncludesVat } : {}),
      ...(discount !== undefined ? { discount } : {}),
      ...(statedVat !== undefined ? { statedVat } : {}),
      ...(v.isFinal !== undefined ? { isFinal: v.isFinal } : {}),
      ...(v.lines !== undefined ? { lines } : {}),
    },
    { idempotencyKey: p.key },
  )
  return outcomeOf(result)
}

// ---------- coding (invoice.confirmCoding, FR-AP-108 AC2) ----------

const CodingInput = z.object({
  ...Version,
  lines: z
    .array(
      z.object({
        invoiceLineId: z.uuid(),
        accountCode: z.string().max(40),
        costCenterId: z.uuid(),
        costCenterReason: z.string().max(REASON_MAX).optional(),
        whtIncomeTypeCode: z.string().max(40).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
})

export async function confirmApCodingFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ApOutcome> {
  const p = parsed(CodingInput, input, idempotencyKey)
  if (!p.ok) return p
  const lines = []
  for (const l of p.value.lines) {
    const accountCode = l.accountCode.trim()
    if (!accountCode) return invalid('accountCode', 'REQUIRED')
    const reason = l.costCenterReason === undefined ? undefined : reasonOf(l.costCenterReason)
    lines.push({
      invoiceLineId: l.invoiceLineId,
      accountCode,
      costCenterId: l.costCenterId,
      ...(reason ? { costCenterReason: reason } : {}),
      ...(l.whtIncomeTypeCode !== undefined ? { whtIncomeTypeCode: l.whtIncomeTypeCode ? l.whtIncomeTypeCode : null } : {}),
    })
  }
  return outcomeOf(await confirmInvoiceCoding(ctx, { invoiceId: p.value.invoiceId, version: p.value.version, lines }, { idempotencyKey: p.key }))
}

// ---------- submit and cancel a draft ----------

const VersionInput = z.object(Version)
const ReasonInput = z.object({ ...Version, reason: Reason })

export async function submitApInvoiceFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ApOutcome> {
  const p = parsed(VersionInput, input, idempotencyKey)
  if (!p.ok) return p
  return outcomeOf(await submitInvoice(ctx, p.value, { idempotencyKey: p.key }))
}

export async function cancelApInvoiceFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ApOutcome> {
  const p = parsed(ReasonInput, input, idempotencyKey)
  if (!p.ok) return p
  const reason = reasonOf(p.value.reason)
  if (!reason) return invalid('reason', 'REASON_REQUIRED')
  return outcomeOf(await cancelInvoice(ctx, { invoiceId: p.value.invoiceId, version: p.value.version, reason }, { idempotencyKey: p.key }))
}

// ---------- the differences (FR-AP-103 AC2, BR-MATCH-10) ----------

export async function recheckApInvoiceFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ApOutcome> {
  const p = parsed(VersionInput, input, idempotencyKey)
  if (!p.ok) return p
  return outcomeOf(await recheckInvoice(ctx, p.value, { idempotencyKey: p.key }))
}

export async function reopenApInvoiceFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ApOutcome> {
  const p = parsed(VersionInput, input, idempotencyKey)
  if (!p.ok) return p
  return outcomeOf(await reopenInvoice(ctx, p.value, { idempotencyKey: p.key }))
}

export async function rejectApInvoiceFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ApOutcome> {
  const p = parsed(ReasonInput, input, idempotencyKey)
  if (!p.ok) return p
  const reason = reasonOf(p.value.reason)
  if (!reason) return invalid('reason', 'REASON_REQUIRED')
  return outcomeOf(await rejectInvoice(ctx, { invoiceId: p.value.invoiceId, version: p.value.version, reason }, { idempotencyKey: p.key }))
}

const DismissInput = z.object({ exceptionId: z.uuid(), reason: Reason })

export async function dismissApExceptionFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ApOutcome> {
  const p = parsed(DismissInput, input, idempotencyKey)
  if (!p.ok) return p
  const reason = reasonOf(p.value.reason)
  if (!reason) return invalid('reason', 'REASON_REQUIRED')
  return outcomeOf(await dismissMatchException(ctx, { exceptionId: p.value.exceptionId, reason }, { idempotencyKey: p.key }))
}

/** PROCUREMENT asks for a price variance to be approved under DOA INVOICE_EXCEPTION (FR-AP-105 AC2) */
export async function requestApVarianceFor(ctx: Ctx, input: unknown, idempotencyKey: unknown): Promise<ApOutcome> {
  const p = parsed(ReasonInput, input, idempotencyKey)
  if (!p.ok) return p
  const reason = reasonOf(p.value.reason)
  if (!reason) return invalid('reason', 'REASON_REQUIRED')
  return outcomeOf(await requestVarianceApproval(ctx, { invoiceId: p.value.invoiceId, version: p.value.version, reason }, { idempotencyKey: p.key }))
}
