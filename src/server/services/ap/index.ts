import { z } from 'zod'
import { normalizeInvoiceNo } from '@/core/invoice'
import { invoiceLineNets } from '@/core/matching'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { lineNet, parseQuantity } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { retentionOf } from '@/core/retention'
import { taxDateOf } from '@/core/vat'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { AiAssistInput, applyAiAssist, assertNoPendingAiReview } from '../ai/assist-contract'
import { issueDocumentNumber } from '../numbering'
import { fail, guard, INVOICEABLE_PO_STATUSES, lockedInvoice, SUBJECT, type Fail } from './common'
import { INVOICED_STATUSES, runMatch } from './match-run'
export { INVOICEABLE_PO_STATUSES } from './common'
import { readyNotice } from './exceptions'
import { enqueueSupplierNotice, SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-notices'
import { claimTrack } from './track'
import { checkIncomeTypes, defaultIncomeType } from './wht'
import { suggestionsFor } from './coding'
import { readStoredInvoiceFile, sourceOfStoredFile } from './files'
import type { EtaxContentReading } from '../invoices/etax'

// Tier-2 invoices (spec FR-AP-101 FR-AP-102 FR-AP-105 FR-AP-108, docs/sub-specs/S8.md, §7.18 BR-AP-01 to BR-AP-13):
// FINANCE makes a draft from an uploaded file against a PO, edits it, confirms the account code and cost center of
// every line, and submits it. Submitting numbers it (numbering.AP) and matches it (./match-run.ts): a match moves it
// to READY_FOR_PAYMENT with the budget, a difference to EXCEPTION. Every command needs module PAY (BR-AP-13) and goes
// through runCommand. A draft moves no money (FR-AP-101 AC6).

/** What each PO line can still be invoiced: goods what was received, services what was confirmed, less other invoices */
async function invoiceableQuantities(tx: TenantTx, po: { lines: ReadonlyArray<{ id: string; receivedQuantity: { toString(): string } }> }) {
  const invoiced = await tx.invoiceLine.groupBy({
    by: ['poLineId'],
    where: { poLineId: { in: po.lines.map((l) => l.id) }, invoice: { status: { in: [...INVOICED_STATUSES] } } },
    _sum: { quantity: true },
  })
  return new Map(
    po.lines.map((l) => {
      const used = parseQuantity((invoiced.find((i) => i.poLineId === l.id)?._sum.quantity ?? 0).toString())
      const left = parseQuantity(l.receivedQuantity.toString()) - used
      return [l.id, left > 0n ? left : 0n]
    }),
  )
}

// ---------- invoice.create (FR-AP-101 AC1) ----------

/** The PO a draft is made on, locked: it must be able to take a tier-2 invoice (BR-MATCH-05, BR-IVC-06) */
export async function lockPoForDraft(tx: TenantTx, ctx: Ctx, poId: string, command: string) {
  const [id] = await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [poId])
  if (!id) return fail('NOT_FOUND', 'purchase order not found')
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } }, supplier: { select: { taxId: true, defaultWhtIncomeTypeCode: true } } } })
  if (!(INVOICEABLE_PO_STATUSES as readonly string[]).includes(po.status)) return fail('INVALID_STATE_TRANSITION', `an invoice is not made on a ${po.status} purchase order`, { from: po.status, command })
  // BR-IVC-06: the PO takes tier-2 invoices from now on (PAY is on: the caller's guard)
  const track = await claimTrack(tx, po, 'MATCHING', true)
  if (!track.ok) return track
  return { ok: true as const, po }
}

type PoForDraft = Extract<Awaited<ReturnType<typeof lockPoForDraft>>, { ok: true }>['po']

export interface DraftSource {
  readonly channel: 'UPLOAD' | 'EMAIL'
  /** The stored file read again (./files.ts readStoredInvoiceFile), or none */
  readonly file: { readonly fileId: string; readonly reading: EtaxContentReading } | null
  readonly inboundEmailId: string | null
  /** The member who made it; null when the inbox job did */
  readonly createdById: string | null
}

/**
 * A draft on a PO locked by lockPoForDraft (FR-AP-101 AC1 AC2, BR-IVC-07): an e-Tax file of the PO's supplier fills the
 * header; the lines come from what is still to invoice. The same file read the same way gives the same draft whether it
 * was uploaded or came by e-mail (FR-AP-101 AC4).
 */
export async function draftOnPo(tx: TenantTx, ctx: Ctx, po: PoForDraft, source: DraftSource): Promise<{ ok: true; invoiceId: string; prefill: 'MANUAL' | 'ETAX_XML'; event: EventDraft } | Fail> {
  const { file } = source
  if (file && (await fileInUse(tx, file.fileId))) return fail('VALIDATION_FAILED', 'the invoice file is already the file of another invoice', { field: 'sourceFileId', reason: 'FILE_IN_USE' })
  const prefill = file && 'prefill' in file.reading && file.reading.prefill.sellerTaxId === po.supplier.taxId ? file.reading.prefill : null
  // the row is whole from its first write (gross = net + stated VAT, INV-AP-04); recalculate adds the lines
  const statedVatSatang = prefill ? amountToSatang(prefill.vat) : 0n
  const left = await invoiceableQuantities(tx, po)
  const lines = po.lines.filter((l) => (left.get(l.id) ?? 0n) > 0n)
  const invoice = await tx.invoice.create({
    data: {
      organizationId: ctx.organizationId,
      poId: po.id,
      supplierId: po.supplierId,
      channel: source.channel,
      prefill: prefill ? 'ETAX_XML' : 'MANUAL',
      fieldSources: prefill ? { supplierInvoiceNo: 'ETAX_XML', invoiceDate: 'ETAX_XML', statedVat: 'ETAX_XML' } : {},
      inboundEmailId: source.inboundEmailId,
      sourceFileId: file ? file.fileId : null,
      supplierInvoiceNo: prefill?.invoiceNo ?? null,
      supplierInvoiceNoNormalized: prefill ? normalizeInvoiceNo(prefill.invoiceNo) : null,
      invoiceDate: prefill ? new Date(`${prefill.invoiceDate}T00:00:00Z`) : null,
      priceIncludesVat: false,
      vatRateBp: po.vatRateBp,
      statedVatSatang,
      grossSatang: statedVatSatang,
      payableSatang: statedVatSatang,
      retentionBp: po.retentionBp,
      createdById: source.createdById,
    },
    select: { id: true },
  })
  if (lines.length > 0) {
    await tx.invoiceLine.createMany({
      data: lines.map((l, i) => ({
        organizationId: ctx.organizationId,
        invoiceId: invoice.id,
        lineNo: i + 1,
        poLineId: l.id,
        description: l.description,
        quantity: formatQuantity(left.get(l.id)!),
        uom: l.uom,
        unitPriceSatang: l.unitPriceSatang,
        vatable: l.vatable,
        whtIncomeTypeCode: defaultIncomeType(po, po.supplier),
      })),
    })
  }
  await recalculate(tx, invoice.id)
  if (file) await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId: file.fileId, subjectType: 'Invoice', subjectId: invoice.id, kind: prefill ? 'ETAX' : 'INVOICE' } })
  const kind = prefill ? ('ETAX_XML' as const) : ('MANUAL' as const)
  return {
    ok: true,
    invoiceId: invoice.id,
    prefill: kind,
    event: { type: 'invoice.drafted', aggregateType: 'Invoice', aggregateId: invoice.id, data: { poId: po.id, supplierId: po.supplierId, channel: source.channel, prefill: kind, agentActionId: null, sourceFileId: file ? file.fileId : null, lineCount: lines.length } },
  }
}

const CreateInput = z.strictObject({
  poId: z.uuid(),
  /** A file the member uploaded for this PO (./files.ts uploadInvoiceFile) */
  sourceFileId: z.uuid().nullable().optional(),
})

export const createInvoiceCommand = defineCommand({
  name: 'invoice.create',
  capability: 'invoice.record',
  input: CreateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ invoiceId: string; prefill: 'MANUAL' | 'ETAX_XML' }>> {
    const who = await guard(tx, ctx, 'invoice.record')
    if (!who.ok) return who
    const file = input.sourceFileId ? await readStoredInvoiceFile(tx, { organizationId: ctx.organizationId, memberId: who.memberId, fileId: input.sourceFileId, poId: input.poId }) : null
    if (file && !file.ok) return fail('VALIDATION_FAILED', 'the invoice file must be one you uploaded for this purchase order, unchanged', { field: 'sourceFileId', reason: file.reason })
    const locked = await lockPoForDraft(tx, ctx, input.poId, 'invoice.create')
    if (!locked.ok) return locked
    const draft = await draftOnPo(tx, ctx, locked.po, { channel: 'UPLOAD', file: file ? file.file : null, inboundEmailId: null, createdById: who.memberId })
    if (!draft.ok) return draft
    return { ok: true, result: { invoiceId: draft.invoiceId, prefill: draft.prefill }, events: [draft.event] }
  },
})

/** A file is the paper of one invoice only, tier 1 or tier 2; run under the PO's lock */
async function fileInUse(tx: TenantTx, fileId: string): Promise<boolean> {
  const [tier1, tier2] = await Promise.all([tx.invoiceConfirmation.count({ where: { sourceFileId: fileId } }), tx.invoice.count({ where: { sourceFileId: fileId, status: { notIn: ['CANCELLED', 'REJECTED'] } } })])
  return tier1 + tier2 > 0
}

/**
 * The amounts of a draft from its lines (BR-MATCH-06, BR-VAT-07): each line's amount before VAT less its share of the
 * foot discount, the invoice's amount before VAT, its total with the VAT it states, and what is owed (total less
 * retention, BR-RET-03 — retention is 0 until S8-09). The VAT the invoice should have is checked when it is submitted.
 */
async function recalculate(tx: TenantTx, invoiceId: string, money: { discountSatang?: bigint; statedVatSatang?: bigint } = {}): Promise<boolean> {
  const stored = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  const invoice = { ...stored, ...money }
  const lines = invoice.lines.map((l) => ({ poLine: l.lineNo, qty: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang, vatable: l.vatable }))
  const total = lines.reduce((a, l) => a + lineNet(l.qty, l.unitPriceSatang), 0n)
  if (invoice.discountSatang > total) return false
  const discount = invoice.discountSatang
  const { amounts, discounts, nets } = invoiceLineNets({ lines, discountSatang: discount, priceIncludesVat: invoice.priceIncludesVat }, invoice.vatRateBp ?? 0)
  for (const [i, l] of invoice.lines.entries()) {
    await tx.invoiceLine.update({ where: { id: l.id }, data: { amountSatang: amounts[i]!, discountSatang: discounts[i]!, netSatang: nets[i]! } })
  }
  const net = nets.reduce((a, b) => a + b, 0n)
  const gross = net + invoice.statedVatSatang
  // BR-RET-03: the retention of the amount before VAT, held back from what is owed
  const retention = retentionOf(net, invoice.retentionBp)
  await tx.invoice.update({ where: { id: invoiceId }, data: { discountSatang: discount, statedVatSatang: invoice.statedVatSatang, netSatang: net, grossSatang: gross, retentionSatang: retention, payableSatang: gross - retention } })
  return true
}

// ---------- invoice.update (BR-AP-03: aiAssist in the same transaction) ----------

const Amount = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/)
const Quantity = z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/)

const UpdateInput = z.strictObject({
  invoiceId: z.uuid(),
  version: z.number().int().min(0),
  supplierInvoiceNo: z.string().trim().min(1).max(60).optional(),
  invoiceDate: z.iso.date().optional(),
  priceIncludesVat: z.boolean().optional(),
  discount: Amount.optional(),
  statedVat: Amount.optional(),
  isFinal: z.boolean().optional(),
  lines: z
    .array(z.strictObject({ poLineId: z.uuid(), quantity: Quantity, unitPrice: Amount, vatable: z.boolean().optional(), description: z.string().trim().min(1).max(500).optional() }))
    .max(200)
    .optional(),
  aiAssist: AiAssistInput.optional(),
})

export const updateInvoiceCommand = defineCommand({
  name: 'invoice.update',
  capability: 'invoice.record',
  input: UpdateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ invoiceId: string; version: number }>> {
    const who = await guard(tx, ctx, 'invoice.record')
    if (!who.ok) return who
    const locked = await lockedInvoice(tx, ctx, input.invoiceId, 'invoice.update', input.version)
    if (!locked.ok) return locked
    const invoice = locked.invoice
    const changed: string[] = []
    const sources = { ...((invoice.fieldSources as Record<string, string> | null) ?? {}) }
    const data: Record<string, unknown> = {}
    // money columns are written together by recalculate (gross = net + stated VAT is a CHECK)
    const money: { discountSatang?: bigint; statedVatSatang?: bigint } = {}
    if (input.supplierInvoiceNo !== undefined) {
      Object.assign(data, { supplierInvoiceNo: input.supplierInvoiceNo, supplierInvoiceNoNormalized: normalizeInvoiceNo(input.supplierInvoiceNo) })
      changed.push('supplierInvoiceNo')
    }
    if (input.invoiceDate !== undefined) {
      data.invoiceDate = new Date(`${input.invoiceDate}T00:00:00Z`)
      changed.push('invoiceDate')
    }
    if (input.priceIncludesVat !== undefined) {
      data.priceIncludesVat = input.priceIncludesVat
      changed.push('priceIncludesVat')
    }
    if (input.discount !== undefined) {
      money.discountSatang = amountToSatang(input.discount)
      changed.push('discount')
    }
    if (input.statedVat !== undefined) {
      money.statedVatSatang = amountToSatang(input.statedVat)
      changed.push('statedVat')
    }
    if (input.isFinal !== undefined) {
      data.isFinal = input.isFinal
      changed.push('isFinal')
    }
    if (input.lines !== undefined) {
      // BR-MATCH-05: lines of the invoice's PO, each PO line once
      const poLines = await tx.poLine.findMany({ where: { poId: invoice.poId }, select: { id: true, description: true, uom: true, vatable: true } })
      const ids = input.lines.map((l) => l.poLineId)
      if (new Set(ids).size !== ids.length) return fail('VALIDATION_FAILED', 'a PO line appears twice on the invoice', { field: 'lines', reason: 'PO_LINE_TWICE' })
      if (ids.some((id) => !poLines.some((p) => p.id === id))) return fail('VALIDATION_FAILED', 'every line must be a line of the invoice’s purchase order', { field: 'lines', reason: 'NOT_A_PO_LINE' })
      if (input.lines.some((l) => parseQuantity(l.quantity) <= 0n)) return fail('VALIDATION_FAILED', 'a quantity above zero is needed', { field: 'lines', reason: 'QUANTITY_NOT_POSITIVE' })
      // The coding of a PO line stays with it (FR-AP-108: confirmed once per line)
      const coding = new Map(invoice.lines.map((l) => [l.poLineId, l]))
      // The differences of earlier runs stay as history; they no longer point at the lines that are replaced
      await tx.matchException.updateMany({ where: { invoiceId: invoice.id, invoiceLineId: { not: null } }, data: { invoiceLineId: null } })
      await tx.invoiceLine.deleteMany({ where: { invoiceId: invoice.id } })
      await tx.invoiceLine.createMany({
        data: input.lines.map((l, i) => {
          const po = poLines.find((p) => p.id === l.poLineId)!
          const kept = coding.get(l.poLineId)
          return {
            organizationId: ctx.organizationId,
            invoiceId: invoice.id,
            lineNo: i + 1,
            poLineId: l.poLineId,
            description: l.description ?? po.description,
            quantity: l.quantity,
            uom: po.uom,
            unitPriceSatang: amountToSatang(l.unitPrice),
            vatable: l.vatable ?? po.vatable,
            whtIncomeTypeCode: kept?.whtIncomeTypeCode ?? null,
            accountCode: kept?.accountCode ?? null,
            costCenterId: kept?.costCenterId ?? null,
            codingSource: kept?.codingSource ?? 'NONE',
            costCenterReason: kept?.costCenterReason ?? null,
            codingConfirmedById: kept?.codingConfirmedById ?? null,
            codingConfirmedAt: kept?.codingConfirmedAt ?? null,
          }
        }),
      })
      changed.push('lines')
    }
    // A value a person typed is no longer the file's or the AI's (labels only, BR-AP-03)
    for (const field of changed) delete sources[field]
    const assist = await applyAiAssist(tx, ctx, SUBJECT(invoice.id), input.aiAssist)
    if (!assist.ok) return { ok: false, error: assist.error }
    if (changed.length === 0 && !input.aiAssist) return fail('VALIDATION_FAILED', 'nothing to change', { field: 'invoiceId', reason: 'NO_CHANGE' })
    await tx.invoice.update({ where: { id: invoice.id }, data: { ...data, fieldSources: sources, version: { increment: 1 } } })
    if (!(await recalculate(tx, invoice.id, money))) return fail('VALIDATION_FAILED', 'the discount is above the invoice amount', { field: 'discount', reason: 'DISCOUNT_ABOVE_AMOUNT' })
    const after = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { version: true, netSatang: true, statedVatSatang: true } })
    const events: EventDraft[] = [
      ...(changed.length ? [{ type: 'invoice.updated', aggregateType: 'Invoice', aggregateId: invoice.id, data: { changed, netSatang: after.netSatang.toString(), statedVatSatang: after.statedVatSatang.toString() } }] : []),
      ...assist.data,
    ]
    return { ok: true, result: { invoiceId: invoice.id, version: after.version }, events }
  },
})

// ---------- invoice.confirmCoding (FR-AP-108 AC2, BR-AP-10) ----------

const CodingInput = z.strictObject({
  invoiceId: z.uuid(),
  version: z.number().int().min(0),
  lines: z.array(z.strictObject({ invoiceLineId: z.uuid(), accountCode: z.string().trim().min(1).max(40), costCenterId: z.uuid(), costCenterReason: z.string().trim().min(1).max(500).optional(), whtIncomeTypeCode: z.string().trim().min(1).max(40).nullable().optional() })).min(1).max(200),
})

export const confirmCodingCommand = defineCommand({
  name: 'invoice.confirmCoding',
  capability: 'invoice.record',
  input: CodingInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ invoiceId: string; version: number }>> {
    const who = await guard(tx, ctx, 'invoice.record')
    if (!who.ok) return who
    const locked = await lockedInvoice(tx, ctx, input.invoiceId, 'invoice.update', input.version)
    if (!locked.ok) return locked
    const invoice = locked.invoice
    const lineIds = input.lines.map((l) => l.invoiceLineId)
    if (new Set(lineIds).size !== lineIds.length) return fail('VALIDATION_FAILED', 'a line appears twice', { field: 'lines', reason: 'LINE_TWICE' })
    const poLines = await tx.poLine.findMany({ where: { id: { in: invoice.lines.map((l) => l.poLineId) } }, select: { id: true, budgetLine: { select: { accountCode: true, costCenterId: true } } } })
    const codes = await tx.accountCode.findMany({ where: { code: { in: input.lines.map((l) => l.accountCode) }, active: true }, select: { code: true } })
    const centers = await tx.costCenter.findMany({ where: { id: { in: input.lines.map((l) => l.costCenterId) }, active: true }, select: { id: true } })
    // BR-WHT-03: FINANCE may change a line's income type with its coding
    const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: invoice.supplierId }, select: { payeeType: true } })
    const types = await checkIncomeTypes(tx, input.lines.map((l) => l.whtIncomeTypeCode).filter((c): c is string => !!c), supplier.payeeType)
    if (!types.ok) return types
    // BR-AP-10: a code chosen as the history offered it says so
    const offered = await suggestionsFor(tx, invoice.id, ctx.now)
    const confirmed: Array<{ invoiceLineId: string; accountCode: string; costCenterId: string; source: 'HISTORY' | 'BUDGET_LINE' | 'MANUAL'; whtIncomeTypeCode: string | null }> = []
    for (const l of input.lines) {
      const line = invoice.lines.find((x) => x.id === l.invoiceLineId)
      if (!line) return fail('VALIDATION_FAILED', 'the line is not on this invoice', { field: 'lines', reason: 'NOT_A_LINE', invoiceLineId: l.invoiceLineId })
      if (!codes.some((c) => c.code === l.accountCode)) return fail('VALIDATION_FAILED', 'the account code is not one of the organization’s active codes', { field: 'accountCode', reason: 'ACCOUNT_CODE_UNKNOWN', accountCode: l.accountCode })
      if (!centers.some((c) => c.id === l.costCenterId)) return fail('VALIDATION_FAILED', 'the cost center is not one of the organization’s active cost centers', { field: 'costCenterId', reason: 'COST_CENTER_UNKNOWN' })
      const budget = poLines.find((p) => p.id === line.poLineId)!.budgetLine
      // BR-AP-10: another cost center than the budget line's needs a reason; the budget does not change
      if (l.costCenterId !== budget.costCenterId && !l.costCenterReason) return fail('VALIDATION_FAILED', 'a reason is needed for another cost center than the budget line’s', { field: 'costCenterReason', reason: 'COST_CENTER_REASON_REQUIRED' })
      const suggestion = offered.find((s) => s.invoiceLineId === line.id)
      const source = suggestion?.source === 'HISTORY' && suggestion.accountCode === l.accountCode ? 'HISTORY' : l.accountCode === budget.accountCode ? 'BUDGET_LINE' : 'MANUAL'
      await tx.invoiceLine.update({
        where: { id: line.id },
        data: { accountCode: l.accountCode, costCenterId: l.costCenterId, costCenterReason: l.costCenterId === budget.costCenterId ? null : l.costCenterReason!, codingSource: source, codingConfirmedById: who.memberId, codingConfirmedAt: ctx.now, ...(l.whtIncomeTypeCode !== undefined ? { whtIncomeTypeCode: l.whtIncomeTypeCode } : {}) },
      })
      confirmed.push({ invoiceLineId: line.id, accountCode: l.accountCode, costCenterId: l.costCenterId, source, whtIncomeTypeCode: l.whtIncomeTypeCode !== undefined ? l.whtIncomeTypeCode : line.whtIncomeTypeCode })
    }
    const after = await tx.invoice.update({ where: { id: invoice.id }, data: { version: { increment: 1 } }, select: { version: true } })
    return { ok: true, result: { invoiceId: invoice.id, version: after.version }, events: [{ type: 'invoice.coding_confirmed', aggregateType: 'Invoice', aggregateId: invoice.id, data: { lines: confirmed } }] }
  },
})

// ---------- invoice.submit (BR-AP-04, BR-AP-05, BR-MATCH-12) ----------

const SubmitInput = z.strictObject({ invoiceId: z.uuid(), version: z.number().int().min(0) })

export interface SubmittedInvoice {
  readonly invoiceId: string
  readonly number: string
  readonly status: 'READY_FOR_PAYMENT' | 'EXCEPTION'
  readonly exceptions: ReadonlyArray<{ type: string; amount: string; lineNo: number | null }>
}

export const submitInvoiceCommand = defineCommand({
  name: 'invoice.submit',
  capability: 'invoice.record',
  input: SubmitInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<SubmittedInvoice>> {
    const who = await guard(tx, ctx, 'invoice.record')
    if (!who.ok) return who
    // The PO first, then the invoice (the order every command of an invoice takes)
    const head = await tx.invoice.findFirst({ where: { id: input.invoiceId }, select: { poId: true } })
    if (!head) return fail('NOT_FOUND', 'invoice not found')
    await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [head.poId])
    const locked = await lockedInvoice(tx, ctx, input.invoiceId, 'invoice.submit_matched', input.version)
    if (!locked.ok) return locked
    const invoice = locked.invoice
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: invoice.poId }, select: { id: true, status: true, supplierId: true, createdById: true, supplier: { select: { taxId: true } } } })

    // BR-AP-04 and BR-MATCH-05
    if (invoice.supplierId !== po.supplierId) return fail('VALIDATION_FAILED', 'the supplier is not the supplier of the purchase order', { field: 'supplierId', reason: 'SUPPLIER_NOT_PO' })
    if (!(INVOICEABLE_PO_STATUSES as readonly string[]).includes(po.status)) return fail('INVALID_STATE_TRANSITION', `an invoice is not submitted on a ${po.status} purchase order`, { from: po.status, command: 'invoice.submit' })
    if (!invoice.supplierInvoiceNoNormalized) return fail('VALIDATION_FAILED', 'the supplier’s invoice number is needed', { field: 'supplierInvoiceNo', reason: 'REQUIRED' })
    if (!invoice.invoiceDate) return fail('VALIDATION_FAILED', 'the invoice date is needed', { field: 'invoiceDate', reason: 'REQUIRED' })
    if (invoice.invoiceDate.toISOString().slice(0, 10) > taxDateOf(ctx.now)) return fail('VALIDATION_FAILED', 'the invoice date is after today', { field: 'invoiceDate', reason: 'IN_THE_FUTURE' })
    if (invoice.lines.length === 0) return fail('VALIDATION_FAILED', 'an invoice needs at least one line', { field: 'lines', reason: 'REQUIRED' })
    if (invoice.netSatang <= 0n) return fail('VALIDATION_FAILED', 'an amount before VAT above zero is needed', { field: 'lines', reason: 'AMOUNT_NOT_POSITIVE' })
    const unconfirmed = invoice.lines.filter((l) => !l.codingConfirmedAt || !l.accountCode || !l.costCenterId).map((l) => l.lineNo)
    if (unconfirmed.length) return fail('CODING_NOT_CONFIRMED', 'confirm the account code of every line first', { lines: unconfirmed.join(', ') })
    const active = await tx.accountCode.findMany({ where: { code: { in: invoice.lines.map((l) => l.accountCode!) }, active: true }, select: { code: true } })
    const inactive = invoice.lines.filter((l) => !active.some((a) => a.code === l.accountCode)).map((l) => l.lineNo)
    if (inactive.length) return fail('CODING_NOT_CONFIRMED', 'an account code is no longer active', { lines: inactive.join(', ') })
    // BR-WHT-03, BR-WHT-04: every income type of the lines is set up, active, and fits the payee
    const payee = await tx.supplier.findUniqueOrThrow({ where: { id: invoice.supplierId }, select: { payeeType: true } })
    const types = await checkIncomeTypes(tx, invoice.lines.map((l) => l.whtIncomeTypeCode).filter((c): c is string => !!c), payee.payeeType)
    if (!types.ok) return types
    // BR-AP-03: values the AI filled in and nobody confirmed yet stop the invoice
    const pending = await assertNoPendingAiReview(tx, ctx, SUBJECT(invoice.id))
    if (!pending.ok) return { ok: false, error: pending.error }

    // BR-AP-05: whoever records the invoice did not create the PO or receive its goods (OQ-127)
    const receivers = await tx.goodsReceipt.findMany({ where: { poId: po.id, status: 'POSTED' }, select: { receiverMemberId: true } })
    const rule = po.createdById === who.memberId ? 'PO_CREATOR' : receivers.some((r) => r.receiverMemberId === who.memberId) ? 'GR_RECEIVER' : null
    if (rule) {
      return {
        ok: false,
        error: { code: 'SOD_VIOLATION', message: 'whoever created the purchase order or received its goods does not record its invoice', details: { rule: 'BR-AP-05', reason: rule } },
        auditEvents: [{ type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: invoice.id, data: { rule: 'BR-AP-05', action: 'invoice.submit', subjectType: 'INVOICE', subjectId: invoice.id, actorMemberId: who.memberId } }],
      }
    }

    // BR-IVC-07: where the values came from, decided again from the stored file
    let prefill = invoice.prefill
    if (invoice.sourceFileId && invoice.prefill !== 'AI_READING') {
      const stored = await readStoredInvoiceFile(tx, { organizationId: ctx.organizationId, memberId: null, fileId: invoice.sourceFileId, poId: po.id })
      prefill = stored.ok && sourceOfStoredFile(stored.file, po.supplier.taxId, invoice) ? 'ETAX_XML' : 'MANUAL'
    }

    // A number is never used twice (BR-NUM-01): an invoice reopened and submitted again keeps its own
    const number = invoice.number ?? (await issueDocumentNumber(tx, ctx, { document: 'AP' }))
    await tx.invoice.update({ where: { id: invoice.id }, data: { number, prefill, recordedById: who.memberId, submittedAt: ctx.now } })
    const run = await runMatch(tx, ctx, invoice.id, 'USER')
    if (!run.ok) {
      return run.refusal.code === 'TAX_RATE_NOT_CONFIGURED'
        ? fail('TAX_RATE_NOT_CONFIGURED', 'no VAT rate covers the invoice date', { date: run.refusal.date })
        : fail('DUPLICATE_INVOICE', 'the supplier already has an invoice with this number', { invoiceNo: run.refusal.invoiceNo })
    }
    const events: EventDraft[] = [
      {
        type: 'invoice.submitted',
        aggregateType: 'Invoice',
        aggregateId: invoice.id,
        data: {
          number,
          supplierInvoiceNoNormalized: invoice.supplierInvoiceNoNormalized,
          netSatang: invoice.netSatang.toString(),
          statedVatSatang: invoice.statedVatSatang.toString(),
          grossSatang: invoice.grossSatang.toString(),
          matchId: run.data.matchId,
        },
      },
      ...run.data.events,
    ]
    // BR-AP-08: the supplier hears the invoice was received, and when it is ready for payment
    const received = await enqueueSupplierNotice(tx, ctx, {
      templateKey: SUPPLIER_TEMPLATES.invoiceReceived,
      supplierId: invoice.supplierId,
      subjectType: 'Invoice',
      subjectId: invoice.id,
      dedupeKey: `invoice_received:${invoice.id}`,
      data: { number, supplierInvoiceNo: invoice.supplierInvoiceNo },
    })
    const ready = run.data.status === 'READY_FOR_PAYMENT' ? await readyNotice(tx, ctx, invoice.id) : null
    events.push(...received.events, ...(ready?.events ?? []))
    return {
      ok: true,
      notifications: [...run.data.notifications, ...received.notifications, ...(ready?.notifications ?? [])],
      outbox: [...received.outbox, ...(ready?.outbox ?? [])],
      result: { invoiceId: invoice.id, number, status: run.data.status, exceptions: run.data.exceptions.map((e) => ({ type: e.type, amount: satangToAmount(e.amountSatang), lineNo: e.lineNo })) },
      events,
    }
  },
})

// ---------- invoice.cancel (FR-AP-101 AC6) ----------

const CancelInput = z.strictObject({ invoiceId: z.uuid(), version: z.number().int().min(0), reason: z.string().trim().min(1).max(500) })

export const cancelInvoiceCommand = defineCommand({
  name: 'invoice.cancel',
  capability: 'invoice.record',
  input: CancelInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ invoiceId: string }>> {
    const who = await guard(tx, ctx, 'invoice.record')
    if (!who.ok) return who
    const locked = await lockedInvoice(tx, ctx, input.invoiceId, 'invoice.cancel', input.version)
    if (!locked.ok) return locked
    await tx.invoice.update({ where: { id: input.invoiceId }, data: { status: locked.to, cancelledAt: ctx.now, cancelReason: input.reason, version: { increment: 1 } } })
    return { ok: true, result: { invoiceId: input.invoiceId }, events: [{ type: 'invoice.cancelled', aggregateType: 'Invoice', aggregateId: input.invoiceId, data: { reason: input.reason } }] }
  },
})

// ---------- invoice.createDraftFromReading (for S13, BR-AP-03) ----------

const ReadingInput = z.strictObject({
  /** The file the AI read (stored by S13 or uploaded) */
  fileId: z.uuid(),
  poId: z.uuid(),
  /** When the reading names the supplier: it must be the PO's */
  supplierId: z.uuid().optional(),
  /** The AgentAction of S13 whose reading this is (no foreign key until S13 adds the table) */
  agentActionId: z.uuid(),
  supplierInvoiceNo: z.string().trim().min(1).max(60).optional(),
  invoiceDate: z.iso.date().optional(),
  statedVat: Amount.optional(),
  discount: Amount.optional(),
  priceIncludesVat: z.boolean().optional(),
  lines: z.array(z.strictObject({ poLineId: z.uuid(), quantity: Quantity, unitPrice: Amount, vatable: z.boolean().optional() })).min(1).max(200).optional(),
  aiAssist: AiAssistInput.optional(),
})

/**
 * A draft from the values an AI read off an invoice (FR-AP-101 AC5): the actor is the member who accepted the reading,
 * never the agent (BR-AI-01); prefill AI_READING, and fieldSources names each value the AI gave, for the labels only.
 * What the member confirmed of the AI's values goes through applyAiAssist in this transaction (S13 makes it real); the
 * submit stops while values wait for review (assertNoPendingAiReview). An e-Tax file uses the upload path instead.
 */
export const createDraftFromReadingCommand = defineCommand({
  name: 'invoice.createDraftFromReading',
  capability: 'invoice.record',
  input: ReadingInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ invoiceId: string }>> {
    const who = await guard(tx, ctx, 'invoice.record')
    if (!who.ok) return who
    const file = await tx.fileObject.findFirst({ where: { id: input.fileId, status: 'AVAILABLE' }, select: { id: true } })
    if (!file) return fail('VALIDATION_FAILED', 'the file is not available', { field: 'fileId', reason: 'FILE' })
    const [poId] = await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [input.poId])
    if (!poId) return fail('NOT_FOUND', 'purchase order not found')
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
    if (!(INVOICEABLE_PO_STATUSES as readonly string[]).includes(po.status)) return fail('INVALID_STATE_TRANSITION', `an invoice is not made on a ${po.status} purchase order`, { from: po.status, command: 'invoice.createDraftFromReading' })
    if (input.supplierId && input.supplierId !== po.supplierId) return fail('VALIDATION_FAILED', 'the supplier is not the supplier of the purchase order', { field: 'supplierId', reason: 'SUPPLIER_NOT_PO' })
    const track = await claimTrack(tx, po, 'MATCHING', true)
    if (!track.ok) return track
    if (await fileInUse(tx, file.id)) return fail('VALIDATION_FAILED', 'the invoice file is already the file of another invoice', { field: 'fileId', reason: 'FILE_IN_USE' })

    let lines: Array<{ poLineId: string; description: string; quantity: string; uom: string; unitPriceSatang: bigint; vatable: boolean }>
    if (input.lines) {
      const ids = input.lines.map((l) => l.poLineId)
      if (new Set(ids).size !== ids.length) return fail('VALIDATION_FAILED', 'a PO line appears twice on the invoice', { field: 'lines', reason: 'PO_LINE_TWICE' })
      if (input.lines.some((l) => parseQuantity(l.quantity) <= 0n)) return fail('VALIDATION_FAILED', 'a quantity above zero is needed', { field: 'lines', reason: 'QUANTITY_NOT_POSITIVE' })
      const resolved = []
      for (const l of input.lines) {
        const pl = po.lines.find((p) => p.id === l.poLineId)
        if (!pl) return fail('VALIDATION_FAILED', 'every line must be a line of the invoice’s purchase order', { field: 'lines', reason: 'NOT_A_PO_LINE' })
        resolved.push({ poLineId: pl.id, description: pl.description, quantity: l.quantity, uom: pl.uom, unitPriceSatang: amountToSatang(l.unitPrice), vatable: l.vatable ?? pl.vatable })
      }
      lines = resolved
    } else {
      const left = await invoiceableQuantities(tx, po)
      lines = po.lines
        .filter((l) => (left.get(l.id) ?? 0n) > 0n)
        .map((l) => ({ poLineId: l.id, description: l.description, quantity: formatQuantity(left.get(l.id)!), uom: l.uom, unitPriceSatang: l.unitPriceSatang, vatable: l.vatable }))
    }
    const fieldSources: Record<string, string> = {}
    for (const field of ['supplierInvoiceNo', 'invoiceDate', 'statedVat', 'discount', 'priceIncludesVat', 'lines'] as const) if (input[field] !== undefined) fieldSources[field] = 'AI_READING'

    const invoice = await tx.invoice.create({
      data: {
        organizationId: ctx.organizationId,
        poId: po.id,
        supplierId: po.supplierId,
        channel: 'UPLOAD',
        prefill: 'AI_READING',
        fieldSources,
        agentActionId: input.agentActionId,
        sourceFileId: file.id,
        supplierInvoiceNo: input.supplierInvoiceNo ?? null,
        supplierInvoiceNoNormalized: input.supplierInvoiceNo ? normalizeInvoiceNo(input.supplierInvoiceNo) : null,
        invoiceDate: input.invoiceDate ? new Date(`${input.invoiceDate}T00:00:00Z`) : null,
        priceIncludesVat: input.priceIncludesVat ?? false,
        vatRateBp: po.vatRateBp,
        retentionBp: po.retentionBp,
        createdById: who.memberId,
      },
      select: { id: true },
    })
    if (lines.length > 0) await tx.invoiceLine.createMany({ data: lines.map((l, i) => ({ organizationId: ctx.organizationId, invoiceId: invoice.id, lineNo: i + 1, ...l })) })
    const money = { ...(input.statedVat ? { statedVatSatang: amountToSatang(input.statedVat) } : {}), ...(input.discount ? { discountSatang: amountToSatang(input.discount) } : {}) }
    if (!(await recalculate(tx, invoice.id, money))) return fail('VALIDATION_FAILED', 'the discount is above the invoice amount', { field: 'discount', reason: 'DISCOUNT_ABOVE_AMOUNT' })
    await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId: file.id, subjectType: 'Invoice', subjectId: invoice.id, kind: 'INVOICE' } })
    // BR-AP-03: in this transaction; before S13 an aiAssist is MODULE_DISABLED and nothing is made
    const assist = await applyAiAssist(tx, ctx, SUBJECT(invoice.id), input.aiAssist)
    if (!assist.ok) return { ok: false, error: assist.error }
    const events: EventDraft[] = [
      {
        type: 'invoice.drafted',
        aggregateType: 'Invoice',
        aggregateId: invoice.id,
        data: { poId: po.id, supplierId: po.supplierId, channel: 'UPLOAD', prefill: 'AI_READING', agentActionId: input.agentActionId, sourceFileId: file.id, lineCount: lines.length },
      },
      ...assist.data,
    ]
    return { ok: true, result: { invoiceId: invoice.id }, events }
  },
})

export function createDraftFromReading(ctx: Ctx, input: z.input<typeof ReadingInput>, options: RunOptions) {
  return runCommand(ctx, createDraftFromReadingCommand, input, options)
}

export function createInvoice(ctx: Ctx, input: z.input<typeof CreateInput>, options: RunOptions) {
  return runCommand(ctx, createInvoiceCommand, input, options)
}
export function updateInvoice(ctx: Ctx, input: z.input<typeof UpdateInput>, options: RunOptions) {
  return runCommand(ctx, updateInvoiceCommand, input, options)
}
export function confirmInvoiceCoding(ctx: Ctx, input: z.input<typeof CodingInput>, options: RunOptions) {
  return runCommand(ctx, confirmCodingCommand, input, options)
}
export function submitInvoice(ctx: Ctx, input: z.input<typeof SubmitInput>, options: RunOptions) {
  return runCommand(ctx, submitInvoiceCommand, input, options)
}
export function cancelInvoice(ctx: Ctx, input: z.input<typeof CancelInput>, options: RunOptions) {
  return runCommand(ctx, cancelInvoiceCommand, input, options)
}
