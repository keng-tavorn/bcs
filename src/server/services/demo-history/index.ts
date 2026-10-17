import { createHash } from 'node:crypto'
import { TZDate } from '@date-fns/tz'
import { satangToAmount } from '@/core/money/dto'
import { BP_PER_WHOLE as BASIS_POINTS, QUANTITY_SCALE } from '@/core/money/constants'
import { documentTotals, parseQuantity, roundHalfUpDiv } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { apPolicyOf } from '@/lib/org-settings'
import { stepUpNeeded } from '@/core/pin'
import type { Result } from '@/core/result'
import { addBusinessMinutes, subtractBusinessMinutes, type BusinessCalendar } from '@/core/sla'
import { taxDateOf } from '@/core/vat'
import { systemClock } from '@/lib/clock'
import { MS_PER_DAY } from '@/lib/constants'
import { setEmailProvider } from '@/integrations/email-provider'
import { checkBucket, putObject } from '@/integrations/storage'
import { grantStepUp } from '@/server/auth/step-up'
import { makeCtx, type Ctx } from '@/server/context'
import { sendSupplierNotice, SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-notices'
import { escapeLike } from '@/server/db/like'
import { forTenant } from '@/server/db/tenant'
import { effectiveSodPolicy, loadBusinessCalendar } from '@/server/doa/policy'
import { approversWithoutPin, giveOneTimePins, randomDemoPin, takeBackOneTimePins, type OneTimePins } from '@/server/seed/pins'
import { budgetLineOn, type HistoryBudgetLines } from '@/server/seed/budget-keys'
import { etaxSampleXml, scannedInvoicePdf } from '@/server/seed/etax-sample'
import type { DemoHistoryRow } from '@/server/seed/sheets'
import type { RunOptions } from '../_pipeline'
import { decideTask } from '../approvals/decide'
import { completeUpload, requestUpload } from '../files'
import { confirmInvoiceCoding, createInvoice, submitInvoice, updateInvoice } from '../ap'
import { recheckPoInvoices, requestVarianceApproval } from '../ap/exceptions'
import { inboxFilePrefix } from '../ap/files'
import { receiveInboundEmail } from '../ap/inbox'
import { recordInvoice } from '../invoices'
import { markNotificationsRead } from '../notifications'
import { assignSupplier, consolidateNow } from '../procurement'
import { closePurchaseOrder, submitPo } from '../purchase-orders'
import { sendPurchaseOrder } from '../purchase-orders/send'
import { postGoodsReceipt, requestCloseShort } from '../receiving'
import { departmentReceivers } from '../receiving/receivers'
import { cancelRequest, createDraft, editRequest, submitRequest } from '../requests'
import { attachFile } from '../requests/attachments'
import { quotationAmounts } from './quotations'

export { budgetKeyLines } from '@/server/seed/budget-keys'
export { DemoHistoryNetError } from './quotations'
import { PAYMENT_HISTORY_KEY, seedPaymentHistory } from './payments'

// The demo history (spec D-01, §16.10 "ข้อมูล"): the requests of sheet Demo_History, made through the real services
// with the business clock set back, so every row ends in its status with real routes, decisions, budget movements,
// POs, receipts and invoices. Each row starts `daysAgo` days before the seed; a decision comes `hours` business
// hours after the submit, through the row's channel; a request still waiting has waited `hours` business hours at the
// time of the seed (core subtractBusinessMinutes), which is what the board shows (FR-VIS-001). The route of every row
// is checked against the rule, approver and escalation the sheet expects. Nothing is sent: the outbox of the past is
// written suppressed, and POs and the suppliers' e-mails about invoices (NEW-97) go to a mail provider that drops them. Every step has a fixed idempotency key, and an
// organization whose history is made in full is left alone, so the seed can run again. A row CANCELLED is taken back by
// its requester `hours` business hours after the send.
// Rows APPROVED stay in the pool with the supplier only suggested, so a consolidation round does not take them before
// the demo scene does (FR-P2P-001 AC2).
// A decision that needs a step-up — a request or PO whose amount the DOA counted is at or above the version's
// stepUpThreshold (FR-AUTH-005 AC2) — is made the way the approver makes it: right before it, the approver's PIN step-up
// for that document, on the row's channel (LIFF, otherwise WEB). The PIN is the one the seed gave the demo approvers
// (SEED_DEV_PIN, src/server/seed/pins.ts); without one (ADR-047 item 9: then nobody gets a PIN from the seed), the
// approvers without a PIN hold a one-time PIN while the history runs, taken back before it returns, whatever happens.
// The step-up runs on the real clock, as its 5-minute window is a security timer; the decision keeps its backdated
// business time. Before anything is written, every demo approver must hold that PIN.
// P1-02: the phase-1 sheet Request_History names a budget key rather than a line: a request uses the key's line of the fiscal
// year of the day it is sent (its tax date, as the request service checks it), so the history may span two fiscal years.
// Its rows also give their line (item, quantity, unit price) and their form's answers; a form that answers Y to
// processesPersonalData is sent with a DPA (ATT-DPA), as quotations go with an amount above ATT-QUOTES.

/** Business minutes between steps of the purchase-to-pay chain of a row (after its approval) */
const STEP_MINUTES = 30
const PO_DECISION_MINUTES = 120
/** A delivery comes this many business days after the PO is sent, the invoice one business day after the delivery */
const DELIVERY_DAYS = 2
const MINUTES_PER_HOUR = 60

export interface DemoHistoryReport {
  readonly seeded: boolean
  readonly byStatus: Readonly<Record<string, number>>
  /** S9-10: the payment runs of the past (module PAY on), and the invoices they paid */
  readonly paymentRuns?: number
  readonly paidInvoices?: number
  /** PAID rows' invoices with no working day to be paid on before the seed: left ready for payment */
  readonly unpaidInvoices?: number
}

type Step = { key: string; at: Date }

interface Context {
  readonly organizationId: string
  readonly now: Date
  readonly calendar: BusinessCalendar
  readonly businessDayMinutes: number
  readonly members: ReadonlyMap<string, string>
  readonly suppliers: ReadonlyMap<string, string>
  readonly sites: ReadonlyMap<string, string>
  readonly budgetLines: HistoryBudgetLines['budgetLines']
  readonly linesByYear: HistoryBudgetLines['linesByYear']
  readonly fiscalYears: HistoryBudgetLines['fiscalYears']
  readonly budgetKeys: HistoryBudgetLines['budgetKeys']
  /** The transaction PIN of the demo approvers, for the step-ups of their decisions (never logged or printed) */
  readonly pin: string
}

export interface DemoHistoryOptions {
  /**
   * The PIN the seed gave the demo approvers (SEED_DEV_PIN): their decisions step up with it. null when the seed gave none:
   * the approvers without a PIN then hold a one-time PIN while the history runs (giveOneTimePins), and none afterwards.
   */
  readonly pin: string | null
  /**
   * Phase 1 (P1-02): the lines of each budget key by fiscal year code, from sheet Budget (its columns budgetKey,
   * fiscalYear and code); needed when the rows name a budget key rather than a line
   */
  readonly budgetKeys?: ReadonlyMap<string, ReadonlyMap<string, string>>
}

/**
 * Some demo approvers do not hold the seed's PIN (they kept an older one, set their own, or are locked): the history would
 * stop at their first step-up, so it does not start. `codes` are their employee codes.
 */
export class DemoHistoryPinError extends Error {
  constructor(readonly codes: readonly string[]) {
    super(`demo approvers without the seed's PIN: ${codes.join(', ')}`)
    this.name = 'DemoHistoryPinError'
  }
}

function must<T>(row: DemoHistoryRow, what: string, result: Result<T>): T {
  if (!result.ok) throw new Error(`Demo_History ${row.ref} ${what}: ${result.error.code} ${JSON.stringify(result.error.details ?? {})}`)
  return result.data
}

/** Every idempotency key of the history starts so; a row's steps are `demo-history:<ref>:<step>` */
const HISTORY_KEY = 'demo-history:'
const keyOf = (row: DemoHistoryRow, step: string) => `${HISTORY_KEY}${row.ref}:${step}`
const optionsOf = (row: DemoHistoryRow, step: string): RunOptions => ({ idempotencyKey: keyOf(row, step), sender: null, suppressOutbox: true })

/** The step a row's replay ends with (a request still waiting ends at its send, with quotations or without) */
function lastSteps(row: DemoHistoryRow): readonly string[] {
  if (row.status === 'PENDING_APPROVAL') return ['submit', 'submit-with-quotations']
  if (row.status === 'CANCELLED') return ['cancel']
  if (row.status === 'ORDERED') return ['po-send']
  // a PO closed short ends at the approval of the close (S8-12 QTY_OVER)
  if (row.status === 'COMPLETED') return ['po-close', 'close-short-approve']
  return ['decide']
}

/** The file storage did not answer: the history stores quotations and the PDFs of POs, so it does not start */
export class DemoHistoryStorageError extends Error {
  constructor(readonly cause_: string) {
    super(`the file storage did not answer (${cause_}): the demo history needs it for quotations and the PDFs of purchase orders`)
    this.name = 'DemoHistoryStorageError'
  }
}

/** An earlier seed stopped half way through the history: only a fresh database gives the demo its numbers again */
export class DemoHistoryIncompleteError extends Error {
  constructor(readonly lastRef: string) {
    super(`the demo history of an earlier seed did not finish (its last row is ${lastRef}): reset the database and seed again`)
    this.name = 'DemoHistoryIncompleteError'
  }
}

/**
 * FR-AUTH-005 AC2: when the route's amount is at or above its version's stepUpThreshold, the approver gives the PIN for
 * this document right before deciding, on the channel of the decision (real time; the decision keeps its business time)
 */
async function stepUpIfNeeded(
  c: Context,
  row: DemoHistoryRow,
  approverCode: string,
  route: { readonly subjectType: 'REQUEST' | 'PURCHASE_ORDER' | 'INVOICE'; readonly subjectId: string; readonly amountSatang: bigint | null; readonly stepUpThresholdSatang: bigint | null },
  channel: Ctx['channel'],
): Promise<void> {
  if (!stepUpNeeded(route)) return
  const memberId = c.members.get(approverCode)
  if (!memberId) throw new Error(`Demo_History: no member ${approverCode}`)
  const granted = await grantStepUp(
    { organizationId: c.organizationId, memberId, subjectType: route.subjectType, subjectId: route.subjectId, method: 'PIN', pin: c.pin, channel: channel === 'LIFF' ? 'LIFF' : 'WEB' },
    systemClock.now(),
    { sender: null },
  )
  if (!granted.ok) throw new Error(`Demo_History ${row.ref}: the PIN step-up of ${approverCode} for ${route.subjectType} was refused (${granted.reason})`)
}

/** S8-12: the invoice price of a scenario over the PO price (docs/inputs scripts/inputs_p1/p1_history.py doc_samples) */
const PRICE_OVER_BP = 300n
const PRICE_WITHIN_TOL_BP = 50n

/**
 * S6 (BR-WF-06): a request whose facts match rules of the workflow in effect waits for its reviewers first. The history's
 * reviewers pass it on the web a business half hour after it is sent — never after the row's decision or the seed — one
 * task per slot (a slot's other tasks and a decided group's close with it), so its DOA step starts as the sheet expects.
 */
async function passReviewers(c: Context, row: DemoHistoryRow, requestId: string, submitAt: Date, decideAt: Date): Promise<void> {
  const db = forTenant(c.organizationId)
  const open = await db.approvalTask.findMany({
    where: { status: 'OPEN', step: { kind: 'REVIEW', status: 'ACTIVE', route: { subjectType: 'REQUEST', subjectId: requestId, status: 'ACTIVE' } } },
    select: { id: true, slotNo: true, assignee: { select: { employeeCode: true } } },
    orderBy: [{ slotNo: 'asc' }, { id: 'asc' }],
  })
  if (open.length === 0) return
  const soon = addBusinessMinutes(submitAt, STEP_MINUTES, c.calendar)
  const at = new Date(Math.min(soon.getTime(), decideAt.getTime(), c.now.getTime()))
  const done = new Set<number>()
  for (const task of open) {
    if (done.has(task.slotNo)) continue
    done.add(task.slotNo)
    // closed meanwhile by the result of its group (GROUP_DECIDED)
    if ((await db.approvalTask.findUnique({ where: { id: task.id }, select: { status: true } }))?.status !== 'OPEN') continue
    const step = `review-${task.slotNo}`
    must(row, step, await decideTask(memberCtx(c, task.assignee.employeeCode ?? '', at, 'WEB', keyOf(row, step)), { taskId: task.id, decision: 'APPROVE' }, optionsOf(row, step)))
  }
}

/**
 * S8-04, S8-12: the supplier's invoice of a completed row as a tier-2 invoice, through the real commands — a draft of
 * what was received, the number and date of the history, every line coded with its budget line's account code and cost
 * center (and the row's income type to withhold), then submitted and matched. The scenario of the sheet decides what the
 * supplier bills: the PO's prices and what was received (MATCH, SERVICE_2WAY, DUPLICATE); 0.5% over, kept within the
 * organization's tolerance (PRICE_WITHIN_TOL); 3% over (PRICE_OVER → EXCEPTION); everything ordered while part of it is
 * still to come (QTY_OVER → EXCEPTION QTY_NOT_RECEIVED). A supplier not registered for VAT bills no VAT (BR-VAT-04,
 * S8-20). The recorder is fin_officer, or the first other FINANCE member when fin_officer created the PO or received
 * its goods (BR-AP-05). Returns the invoice.
 */
async function historyInvoice(c: Context, row: DemoHistoryRow, poId: string, receiverId: string, at: Date, scenario: NonNullable<DemoHistoryRow['invoice']>['scenario']): Promise<{ invoiceId: string; recorder: string }> {
  const db = forTenant(c.organizationId)
  const po = await db.purchaseOrder.findUniqueOrThrow({
    where: { id: poId },
    select: { createdById: true, vatRateBp: true, kind: true, supplier: { select: { isVatRegistered: true } }, lines: { orderBy: { lineNo: 'asc' }, select: { id: true, quantity: true, receivedQuantity: true, unitPriceSatang: true, vatable: true } } },
  })
  const settings = await db.organization.findUniqueOrThrow({ where: { id: c.organizationId }, select: { settings: true } })
  const policy = apPolicyOf(settings.settings)
  const conflicts = new Set([po.createdById, receiverId])
  const finance = await db.roleAssignment.findMany({ where: { role: 'FINANCE', revokedAt: null, member: { status: 'ACTIVE' } }, select: { member: { select: { id: true, employeeCode: true } } } })
  const codes = finance.map((f) => f.member).filter((m) => m.employeeCode && !conflicts.has(m.id)).map((m) => m.employeeCode!).sort()
  const recorder = codes.includes('fin_officer') ? 'fin_officer' : codes[0]
  if (!recorder) throw new Error(`Demo_History ${row.ref}: no FINANCE member may record the invoice (BR-AP-05)`)
  const ctx = (step: string) => memberCtx(c, recorder, at, 'WEB', keyOf(row, step))
  const { invoiceId } = must(row, 'invoice draft', await createInvoice(ctx('invoice-draft'), { poId }, optionsOf(row, 'invoice-draft')))
  const draft = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { version: true } })

  // What the supplier bills, line by line
  const billed = po.lines.map((l) => {
    const qty = scenario === 'QTY_OVER' ? l.quantity.toString() : l.receivedQuantity.toString()
    let price = l.unitPriceSatang
    if (scenario === 'PRICE_OVER') price = roundHalfUpDiv(l.unitPriceSatang * (BASIS_POINTS + PRICE_OVER_BP), BASIS_POINTS)
    if (scenario === 'PRICE_WITHIN_TOL') {
      // 0.5% over, never more than the tolerance in baht of the line (BR-MATCH-07), so it matches within the tolerance
      const units = parseQuantity(qty)
      const most = l.unitPriceSatang + ((policy.priceTolSatang - 1n) * QUANTITY_SCALE) / (units > 0n ? units : QUANTITY_SCALE)
      const target = roundHalfUpDiv(l.unitPriceSatang * (BASIS_POINTS + PRICE_WITHIN_TOL_BP), BASIS_POINTS)
      price = target < most ? target : most
    }
    return { poLineId: l.id, quantity: qty, unitPriceSatang: price, vatable: l.vatable }
  })
  const totals = documentTotals(billed.map((b) => ({ quantity: b.quantity, unitPriceSatang: b.unitPriceSatang, vatable: b.vatable })), po.supplier.isVatRegistered ? (po.vatRateBp ?? 0) : 0, false)
  const changedLines = scenario === 'QTY_OVER' || scenario === 'PRICE_OVER' || scenario === 'PRICE_WITHIN_TOL'
  const edited = must(
    row,
    'invoice edit',
    await updateInvoice(
      ctx('invoice-edit'),
      {
        invoiceId,
        version: draft.version,
        supplierInvoiceNo: row.invoice?.invoiceNo ?? `INV-${row.ref}`,
        invoiceDate: localDate(at, c.calendar.timezone),
        statedVat: satangToAmount(totals.vat),
        isFinal: true,
        ...(changedLines ? { lines: billed.map((b) => ({ poLineId: b.poLineId, quantity: b.quantity, unitPrice: satangToAmount(b.unitPriceSatang), vatable: b.vatable })) } : {}),
      },
      optionsOf(row, 'invoice-edit'),
    ),
  )
  const lines = await db.invoiceLine.findMany({ where: { invoiceId }, select: { id: true, poLine: { select: { budgetLine: { select: { code: true, accountCode: true, costCenterId: true } } } } } })
  // the income type to withhold of a service row (BR-WHT-03); goods withhold nothing
  const whtIncomeTypeCode = po.kind === 'SERVICE' ? (row.invoice?.whtIncomeType ?? null) : null
  const coding = lines.map((l) => {
    const budget = l.poLine.budgetLine
    if (!budget.accountCode) throw new Error(`Demo_History ${row.ref}: budget line ${budget.code} has no account code to code the invoice with`)
    return { invoiceLineId: l.id, accountCode: budget.accountCode, costCenterId: budget.costCenterId, ...(row.invoice ? { whtIncomeTypeCode } : {}) }
  })
  const coded = must(row, 'invoice coding', await confirmInvoiceCoding(ctx('invoice-coding'), { invoiceId, version: edited.version, lines: coding }, optionsOf(row, 'invoice-coding')))
  must(row, 'invoice submit', await submitInvoice(ctx('invoice-submit'), { invoiceId, version: coded.version }, optionsOf(row, 'invoice-submit')))
  return { invoiceId, recorder }
}

/** S8-12 PRICE_OVER paid: PROCUREMENT asks for the variance and the DOA approver of INVOICE_EXCEPTION approves it */
async function approvedVariance(c: Context, row: DemoHistoryRow, invoiceId: string, askAt: Date, decideAt: Date): Promise<void> {
  const db = forTenant(c.organizationId)
  const version = (await db.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { version: true } })).version
  must(row, 'variance', await requestVarianceApproval(memberCtx(c, 'proc_officer', askAt, 'WEB', keyOf(row, 'variance')), { invoiceId, version, reason: 'ราคาวัสดุขึ้นตามที่ผู้ขายแจ้ง' }, optionsOf(row, 'variance')))
  const task = await db.approvalTask.findFirstOrThrow({
    where: { status: 'OPEN', step: { route: { subjectType: 'INVOICE', subjectId: invoiceId } } },
    select: { id: true, assignee: { select: { employeeCode: true } }, step: { select: { route: { select: { amountSatang: true, doaVersion: { select: { stepUpThresholdSatang: true } } } } } } },
  })
  const approver = task.assignee.employeeCode!
  await stepUpIfNeeded(c, row, approver, { subjectType: 'INVOICE', subjectId: invoiceId, amountSatang: task.step.route.amountSatang, stepUpThresholdSatang: task.step.route.doaVersion.stepUpThresholdSatang }, 'WEB')
  must(row, 'variance approve', await decideTask(memberCtx(c, approver, decideAt, 'WEB', keyOf(row, 'variance-approve')), { taskId: task.id, decision: 'APPROVE' }, optionsOf(row, 'variance-approve')))
}

/**
 * S8-12: the invoice inbox of an organization with PAY after its history — the second copy of each DUPLICATE row's
 * invoice that the supplier e-mailed again (a draft on the PO whose number the supplier already used: DUPLICATE_INVOICE
 * when submitted), and one e-Tax invoice of a MISSING row whose subject names no PO, waiting for FINANCE to choose it.
 * e-Tax issuers send their XML (synthesized from the history), the others a scanned PDF. Stored and received through
 * invoice.inbox.receive as the job would, once per Message-ID.
 */
async function historyInbox(c: Context, rows: readonly DemoHistoryRow[]): Promise<number> {
  const db = forTenant(c.organizationId)
  const settings = await db.organization.findUniqueOrThrow({ where: { id: c.organizationId }, select: { settings: true } })
  const address = (settings.settings as { ap?: { inboxAddress?: string } } | null)?.ap?.inboxAddress
  if (!address) return 0
  let received = 0
  const mail = async (row: DemoHistoryRow, poId: string, invoiceNo: string, withPoNumber: boolean) => {
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { number: true, netSatang: true, vatSatang: true, grossSatang: true, closedAt: true, supplier: { select: { nameTh: true, taxId: true, branchCode: true, email: true, eTaxIssuer: true, isVatRegistered: true } } } })
    const at = po.closedAt ?? c.now
    const vat = po.supplier.isVatRegistered ? po.vatSatang : 0n
    const issueDate = localDate(at, c.calendar.timezone)
    const etax = po.supplier.eTaxIssuer !== 'NONE' && po.supplier.taxId
    const content = etax
      ? etaxSampleXml({ invoiceNo, issueDate, sellerName: po.supplier.nameTh, sellerTaxId: po.supplier.taxId!, sellerBranch: po.supplier.branchCode, net: satangToAmount(po.netSatang), vat: satangToAmount(vat), gross: satangToAmount(po.netSatang + vat) })
      : scannedInvoicePdf([po.supplier.nameTh, invoiceNo, satangToAmount(po.netSatang + vat)])
    const mimeType = etax ? 'application/xml' : 'application/pdf'
    const key = `${inboxFilePrefix(c.organizationId)}${row.ref}-${invoiceNo.replace(/[^A-Za-z0-9-]/g, '')}.${etax ? 'xml' : 'pdf'}`
    await putObject(key, content, mimeType)
    const ctx = makeCtx({ organizationId: c.organizationId, actor: { type: 'SYSTEM', job: 'invoice-inbox-poll' }, channel: 'SYSTEM', now: at, requestId: keyOf(row, 'inbox') })
    must(
      row,
      'inbox',
      await receiveInboundEmail(
        ctx,
        {
          provider: 'seed',
          messageId: `${row.ref}.${invoiceNo}@history.bcs.local`,
          fromAddress: po.supplier.email ?? '',
          toAddress: address,
          subject: withPoNumber ? `ใบแจ้งหนี้ ${invoiceNo} ตาม ${po.number}` : `ใบแจ้งหนี้ ${invoiceNo}`,
          receivedAt: at.toISOString(),
          poRefsFound: withPoNumber && po.number ? [po.number] : [],
          files: [{ key, fileName: `${invoiceNo}.${etax ? 'xml' : 'pdf'}`, mimeType, sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), poId: withPoNumber ? poId : null }],
          skipped: [],
        },
        optionsOf(row, 'inbox'),
      ),
    )
    received++
  }
  for (const row of rows.filter((r) => r.status === 'COMPLETED' && r.invoice?.scenario === 'DUPLICATE')) {
    const invoice = await db.invoice.findFirst({ where: { supplierInvoiceNo: row.invoice!.invoiceNo ?? `INV-${row.ref}`, status: { notIn: ['CANCELLED', 'REJECTED'] } }, select: { poId: true, supplierInvoiceNo: true } })
    if (!invoice) throw new Error(`Demo_History ${row.ref}: the first invoice of a DUPLICATE row is missing`)
    await mail(row, invoice.poId, invoice.supplierInvoiceNo!, true)
  }
  // one MISSING row of an e-Tax issuer: its invoice comes now, by e-mail without a PO number
  const missing = rows.filter((r) => r.status === 'COMPLETED' && r.invoice?.scenario === 'MISSING')
  for (const row of missing) {
    const po = await db.purchaseOrder.findFirst({ where: { lines: { some: { sources: { some: { requestLine: { request: { title: row.title } } } } } }, supplier: { eTaxIssuer: { not: 'NONE' } } }, select: { id: true } })
    if (!po) continue
    await mail(row, po.id, `INV-${row.ref}`, false)
    break
  }
  return received
}

/** S8-12 QTY_OVER: the first receipt is a tenth short (at least one whole unit) of each line of more than one unit */
function shortOf(lines: ReadonlyArray<{ id: string; quantity: { toString(): string } }>): Map<string, bigint> {
  const out = new Map<string, bigint>()
  for (const l of lines) {
    const units = parseQuantity(l.quantity.toString()) / QUANTITY_SCALE
    if (units < 2n) continue
    const short = units / 10n > 1n ? units / 10n : 1n
    out.set(l.id, short * QUANTITY_SCALE)
  }
  return out
}

/** A member's context for one step; `step` names the events the step writes (Event.requestId), which are kept for good */
function memberCtx(c: Context, code: string, now: Date, channel: Ctx['channel'] = 'WEB', step?: string): Ctx {
  const memberId = c.members.get(code)
  if (!memberId) throw new Error(`Demo_History: no member ${code}`)
  return makeCtx({ organizationId: c.organizationId, actor: { type: 'USER', memberId }, channel, now, ...(step ? { requestId: step } : {}) })
}

/** Local date "YYYY-MM-DD" of an instant in the organization's time zone */
function localDate(at: Date, timezone: string): string {
  const local = new TZDate(at.getTime(), timezone)
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
}

/** The first business half hour of the day `daysAgo` days before now (the next business day when that one is not) */
function dayStart(c: Context, daysAgo: number): Date {
  const local = new TZDate(c.now.getTime() - daysAgo * MS_PER_DAY, c.calendar.timezone)
  const midnight = new TZDate(local.getFullYear(), local.getMonth(), local.getDate(), 0, 0, c.calendar.timezone)
  return addBusinessMinutes(new Date(midnight.getTime()), STEP_MINUTES, c.calendar)
}

/** A one-page PDF with a few lines of plain text: the file of a demo quotation (it never leaves the demo) */
function quotationPdf(lines: readonly string[]): Uint8Array {
  const text = lines.map((l, i) => `BT /F1 12 Tf 72 ${760 - i * 18} Td (${l.replace(/[()\\]/g, ' ')}) Tj ET`).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

/** A file uploaded by the member through the real upload path: presigned PUT, then the recorded upload (FR-PLT-004) */
async function upload(row: DemoHistoryRow, ctx: Ctx, step: string, fileName: string, content: Uint8Array): Promise<string> {
  const asked = must(row, `${step} request`, await requestUpload(ctx, { fileName, mimeType: 'application/pdf', sizeBytes: content.length }))
  const put = await fetch(asked.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: new Uint8Array(content) })
  if (!put.ok) throw new Error(`Demo_History ${row.ref} ${step}: the storage refused the upload (${put.status})`)
  return must(row, `${step} record`, await completeUpload(ctx, { ticket: asked.ticket }, { sender: null, suppressOutbox: true })).fileId
}

/**
 * Answers the request type's form asks for: the sheet's own (phase 1), or for the demo sheet derived from the title, IT
 * purchases of licences being software. Services and software lines need the day the service ends (forms.yaml).
 */
function formOf(row: DemoHistoryRow): { formData: Record<string, string>; needsEndDate: boolean } {
  if (row.form) {
    const formData = { ...row.form }
    return { formData, needsEndDate: row.requestType === 'HIRE_SERVICE' || (row.requestType === 'IT_PURCHASE' && formData.category === 'SOFTWARE') }
  }
  const screening = { processesPersonalData: 'N', accessesSystems: 'N', accessesPremises: 'N' }
  if (row.requestType === 'IT_PURCHASE') {
    const software = /ไลเซนส์|ซอฟต์แวร์/.test(row.title)
    return { formData: { category: software ? 'SOFTWARE' : 'HARDWARE', ...screening }, needsEndDate: software }
  }
  if (row.requestType === 'HIRE_SERVICE') return { formData: { scopeOfWork: row.title, servicePeriod: '1 เดือน', ...screening }, needsEndDate: true }
  return { formData: {}, needsEndDate: false }
}

async function routeOf(c: Context, requestId: string) {
  const route = await forTenant(c.organizationId).approvalRoute.findFirstOrThrow({
    where: { subjectType: 'REQUEST', subjectId: requestId, status: 'ACTIVE' },
    select: { ruleCode: true, escalatedFromRuleCode: true, steps: { select: { tasks: { where: { status: 'OPEN' }, select: { id: true, assignee: { select: { employeeCode: true } } } } } } },
  })
  const [task, ...more] = route.steps.flatMap((s) => s.tasks)
  if (!task || more.length) throw new Error(`a route with ${route.steps.flatMap((s) => s.tasks).length} open tasks`)
  // The sheet names the rule of the band the amount falls in; an escalated route keeps it as escalatedFromRuleCode
  return { rule: route.escalatedFromRuleCode ?? route.ruleCode, escalated: route.escalatedFromRuleCode !== null, taskId: task.id, approver: task.assignee.employeeCode ?? '' }
}

/**
 * The member who receives the goods (§2.4 gr.post, BR-SOD-02, BR-SOD-07, ADR-038 item 13): a RECEIVER of the requester's
 * department who approved neither the PR nor the PO, else the requester when the DOA in effect lets requesters receive.
 */
async function receiverOf(c: Context, requestId: string, poId: string, at: Date): Promise<string> {
  const db = forTenant(c.organizationId)
  return db.$transaction(async (tx) => {
    const request = await tx.request.findUniqueOrThrow({ where: { id: requestId }, select: { requesterMemberId: true, requesterDepartmentId: true } })
    // ADR-038 item 8: a delegate who approved and the delegator they acted for both count as approvers
    const decided = await tx.approvalTask.findMany({
      where: { status: 'APPROVED', step: { route: { OR: [{ subjectType: 'REQUEST', subjectId: requestId }, { subjectType: 'PURCHASE_ORDER', subjectId: poId }] } } },
      select: { decidedByMemberId: true, principalMemberId: true },
    })
    const approvers = new Set(decided.flatMap((t) => [t.decidedByMemberId, t.principalMemberId]))
    const receiver = (await departmentReceivers(tx, c.organizationId, [request.requesterDepartmentId], at)).find((m) => !approvers.has(m))
    if (receiver) return receiver
    const policy = await effectiveSodPolicy(tx, at)
    if (!policy.requesterMayReceive || approvers.has(request.requesterMemberId)) throw new Error('nobody may receive: no RECEIVER of the department and the requester may not')
    return request.requesterMemberId
  })
}

/**
 * The chat button approves only (§9.3): a row decided in LINE chat must be an approval below the version's step-up
 * threshold (BR-TOK-05) — a rejection or a return needs its reason in LIFF or on the web.
 */
export function lineChatRefusal(row: Pick<DemoHistoryRow, 'ref' | 'channel' | 'status'>, amountSatang: bigint | null, stepUpThresholdSatang: bigint | null): string | null {
  if (row.channel !== 'LINE_CHAT') return null
  if (row.status === 'REJECTED' || row.status === 'RETURNED') return `Demo_History ${row.ref}: a ${row.status.toLowerCase()} request needs its reason in LIFF or on the web, not the chat button`
  if (stepUpThresholdSatang !== null && amountSatang !== null && amountSatang >= stepUpThresholdSatang) return `Demo_History ${row.ref}: the amount needs the PIN (BR-TOK-05), so it cannot be approved from the chat button`
  return null
}

/** When a row is drafted, sent and decided (business time); a request still waiting has waited `hours` until now */
function timesOf(c: Context, row: DemoHistoryRow): { draftAt: Date; submitAt: Date; decideAt: Date } {
  const pending = row.status === 'PENDING_APPROVAL'
  const submitAt = pending ? subtractBusinessMinutes(c.now, row.hours * MINUTES_PER_HOUR, c.calendar) : addBusinessMinutes(dayStart(c, row.daysAgo), STEP_MINUTES, c.calendar)
  const draftAt = new Date(Math.min(dayStart(c, row.daysAgo).getTime(), subtractBusinessMinutes(submitAt, STEP_MINUTES, c.calendar).getTime()))
  return { draftAt, submitAt, decideAt: addBusinessMinutes(submitAt, row.hours * MINUTES_PER_HOUR, c.calendar) }
}

/**
 * The demo data names its fiscal year (sheet Budget): a row whose first day, or today, falls outside the fiscal year of
 * its budget line cannot be made — requests are refused outside the year of their line — so the history stops before
 * it writes anything and says which year the sheets need.
 */
/**
 * A phase-1 row is sent on a day for which sheet Budget has no line of its budget key (no fiscal year holds the day,
 * or the key has no line in it): the history stops before it writes anything and names the day and the key
 */
export class DemoHistoryNoBudgetLineError extends Error {
  constructor(
    readonly ref: string,
    readonly day: string,
    readonly budgetKey: string,
  ) {
    super(`Request_History ${ref}: sheet Budget has no line of ${budgetKey} in the fiscal year of ${day}`)
    this.name = 'DemoHistoryNoBudgetLineError'
  }
}

/** The budget line a row is sent with: the sheet's line, or the line of its key in the fiscal year of the send day */
function budgetLineOf(c: Context, row: DemoHistoryRow, submitAt: Date): string | undefined {
  return budgetLineOn(c, row.budget, taxDateOf(submitAt))
}


export class DemoHistoryOutOfYearError extends Error {
  constructor(
    readonly ref: string,
    readonly day: string,
    readonly fiscalYear: string,
    readonly startsOn: string,
    readonly endsOn: string,
  ) {
    super(`Demo_History ${ref}: ${day} is outside fiscal year ${fiscalYear} (${startsOn} to ${endsOn}) of its budget line`)
    this.name = 'DemoHistoryOutOfYearError'
  }
}

async function replay(c: Context, row: DemoHistoryRow): Promise<void> {
  const db = forTenant(c.organizationId)
  const pending = row.status === 'PENDING_APPROVAL'
  const { draftAt, submitAt, decideAt } = timesOf(c, row)
  if (!pending && decideAt > c.now) throw new Error(`Demo_History ${row.ref}: decided ${row.hours} business hours after ${row.daysAgo} days ago is in the future`)

  const { formData, needsEndDate } = formOf(row)
  const requester = (at: Date, step: string) => memberCtx(c, row.requester, at, 'WEB', keyOf(row, step))
  const site = row.site ? c.sites.get(row.site) : undefined
  const supplier = row.supplier ? c.suppliers.get(row.supplier) : undefined
  const budgetLineId = budgetLineOf(c, row, submitAt)
  if ((row.site && !site) || (row.supplier && !supplier) || !budgetLineId) throw new Error(`Demo_History ${row.ref}: unknown site, supplier or budget line`)
  const serviceEnd = needsEndDate ? localDate('daysAfterSeed' in row.serviceEnd ? new Date(c.now.getTime() + row.serviceEnd.daysAfterSeed * MS_PER_DAY) : new Date(draftAt.getTime() + row.serviceEnd.daysAfterDraft * MS_PER_DAY), c.calendar.timezone) : null
  const line = row.line ?? { description: row.title, quantity: '1', uom: row.requestType === 'BUY_GOODS' || row.requestType === 'IT_PURCHASE' ? 'รายการ' : 'งาน', unitPrice: row.net }
  const draft = must(
    row,
    'draft',
    await createDraft(
      requester(draftAt, 'draft'),
      {
        requestTypeCode: row.requestType,
        title: row.title,
        formData,
        budgetLineId,
        ...(site ? { deliverySiteId: site } : {}),
        // APPROVED rows wait in the pool: the supplier is only suggested (FR-P2P-001 AC2)
        ...(supplier ? { suggestedSupplierId: supplier } : {}),
        lines: [{ ...line, ...(serviceEnd ? { serviceEndDate: serviceEnd } : {}) }],
      },
      optionsOf(row, 'draft'),
    ),
  )
  const requestId = draft.requestId

  // Send; when the form's attachment rules ask for files — quotations above ATT-QUOTES' amount, a DPA when the supplier
  // processes personal data (ATT-DPA) — add them and send again
  // S6-13 (BR-DUP-05): the history's duplicates are found by the same check as any submit; the requester's reason is the
  // row's note (pattern DUPLICATE of Request_History), so the flag is written the way a person's would be
  const send = async (label: string) => {
    const first = await submitRequest(requester(submitAt, label), { requestId }, optionsOf(row, label))
    if (first.ok || first.error.details?.reason !== 'DUPLICATE_UNACKNOWLEDGED') return first
    return submitRequest(requester(submitAt, `${label}-reason`), { requestId, duplicateReason: row.note ?? `ข้อมูลสังเคราะห์ ${row.ref}` }, optionsOf(row, `${label}-reason`))
  }
  let sent = await send('submit')
  const unmet = !sent.ok && sent.error.code === 'ATTACHMENT_RULE_FAILED' ? new Set(((sent.error.details?.failures ?? []) as ReadonlyArray<{ rule: string }>).map((f) => f.rule)) : new Set<string>()
  const unknownRule = [...unmet].find((rule) => rule !== 'ATT-QUOTES' && rule !== 'ATT-DPA')
  if (unknownRule) throw new Error(`Demo_History ${row.ref}: the history cannot meet attachment rule ${unknownRule}`)
  if (unmet.has('ATT-DPA')) {
    const fileId = await upload(row, requester(draftAt, 'dpa'), 'dpa', `dpa-${row.ref}.pdf`, quotationPdf(['BCS demo data processing agreement', `${row.ref} ${row.supplier ?? ''}`]))
    must(row, 'attach DPA', await attachFile(requester(draftAt, 'dpa-attach'), { requestId, fileId, kind: 'DPA' }, optionsOf(row, 'dpa-attach')))
  }
  if (unmet.has('ATT-QUOTES')) {
    const names = [row.supplier ?? 'S0', 'ALT-1', 'ALT-2']
    // The chosen quotation at the row's net and two comparisons at exactly 104 % and 107 % of it, never rounded
    const amounts = quotationAmounts(row)
    const quotations = []
    for (const [i, amount] of amounts.entries()) {
      const fileId = await upload(row, requester(draftAt, `quote-${i + 1}`), `quote-${i + 1}`, `quotation-${row.ref}-${i + 1}.pdf`, quotationPdf(['BCS demo quotation', `${row.ref} ${names[i]}`, `THB ${satangToAmount(amount)} before VAT`]))
      quotations.push({ supplierName: i === 0 ? names[0]! : `ผู้เสนอราคาเปรียบเทียบ ${i}`, amount: satangToAmount(amount), includesVat: false, fileId, selected: i === 0 })
    }
    must(row, 'quotations', await editRequest(requester(draftAt, 'quotations'), { requestId, quotations }, optionsOf(row, 'quotations')))
  }
  if (unmet.size > 0) {
    sent = await send('submit-with-quotations')
  }
  must(row, 'submit', sent)
  await passReviewers(c, row, requestId, submitAt, decideAt)

  // The route is the one the sheet expects (BR-DOA-01..06)
  const route = await routeOf(c, requestId)
  if (route.rule !== row.expectedRule || route.approver !== row.expectedApprover || route.escalated !== row.escalated) {
    throw new Error(`Demo_History ${row.ref}: route ${route.rule} to ${route.approver}${route.escalated ? ' (escalated)' : ''}, the sheet expects ${row.expectedRule} to ${row.expectedApprover}${row.escalated ? ' (escalated)' : ''}`)
  }
  if (pending) return
  if (row.status === 'CANCELLED') {
    // The requester takes the request back `hours` business hours after sending it, before anyone decides (§2.4 NO_PO_YET)
    must(row, 'cancel', await cancelRequest(requester(decideAt, 'cancel'), { requestId, ...(row.note ? { reason: row.note } : {}) }, optionsOf(row, 'cancel')))
    return
  }

  const routed = await db.approvalRoute.findFirstOrThrow({ where: { subjectType: 'REQUEST', subjectId: requestId, status: 'ACTIVE' }, select: { amountSatang: true, doaVersion: { select: { stepUpThresholdSatang: true } } } })
  const refusal = lineChatRefusal(row, routed.amountSatang, routed.doaVersion.stepUpThresholdSatang)
  if (refusal) throw new Error(refusal)
  const decision = row.status === 'REJECTED' ? 'REJECT' : row.status === 'RETURNED' ? 'RETURN' : 'APPROVE'
  const reason = row.note ?? (decision === 'APPROVE' ? undefined : 'ตามหมายเหตุของผู้อนุมัติ')
  await stepUpIfNeeded(c, row, route.approver, { subjectType: 'REQUEST', subjectId: requestId, amountSatang: routed.amountSatang, stepUpThresholdSatang: routed.doaVersion.stepUpThresholdSatang }, row.channel!)
  must(row, 'decide', await decideTask(memberCtx(c, route.approver, decideAt, row.channel!, keyOf(row, 'decide')), { taskId: route.taskId, decision, ...(decision !== 'APPROVE' ? { reason } : {}) }, optionsOf(row, 'decide')))
  if (row.status !== 'ORDERED' && row.status !== 'COMPLETED') return

  // Purchase to pay (§6.4): supplier chosen in the pool, a PO of this request alone, approved, sent; then received,
  // invoiced and closed when the sheet says COMPLETED
  const chain: Step[] = []
  let t = decideAt
  const next = (key: string, minutes: number) => {
    t = addBusinessMinutes(t, minutes, c.calendar)
    if (t > c.now) throw new Error(`Demo_History ${row.ref}: step ${key} would be after the seed`)
    chain.push({ key, at: t })
    return t
  }
  const proc = (at: Date, step: string) => memberCtx(c, 'proc_officer', at, 'WEB', keyOf(row, step))
  const lines = await db.requestLine.findMany({ where: { requestId }, select: { id: true } })
  if (!supplier) throw new Error(`Demo_History ${row.ref}: an ordered request needs its supplier`)
  must(row, 'assign supplier', await assignSupplier(proc(next('assign', MINUTES_PER_HOUR), 'assign'), { requestLineIds: lines.map((l) => l.id), supplierId: supplier }, optionsOf(row, 'assign')))
  const round = must(row, 'consolidate', await consolidateNow(proc(next('consolidate', STEP_MINUTES), 'consolidate'), optionsOf(row, 'consolidate')))
  const pos = await db.purchaseOrder.findMany({ where: { id: { in: [...round.purchaseOrderIds] } }, select: { id: true, lines: { select: { id: true, quantity: true, sources: { select: { requestLine: { select: { requestId: true } } } } } } } })
  const po = pos.find((p) => p.lines.some((l) => l.sources.some((s) => s.requestLine.requestId === requestId)))
  if (!po || pos.length !== 1) throw new Error(`Demo_History ${row.ref}: the round made ${pos.length} POs`)
  must(row, 'submit PO', await submitPo(proc(next('po-submit', STEP_MINUTES), 'po-submit'), { poId: po.id }, optionsOf(row, 'po-submit')))
  const poTask = await db.approvalTask.findFirstOrThrow({
    where: { status: 'OPEN', step: { route: { subjectType: 'PURCHASE_ORDER', subjectId: po.id } } },
    select: { id: true, assignee: { select: { employeeCode: true } }, step: { select: { route: { select: { amountSatang: true, doaVersion: { select: { stepUpThresholdSatang: true } } } } } } },
  })
  const poRoute = poTask.step.route
  const poAt = next('po-approve', PO_DECISION_MINUTES)
  await stepUpIfNeeded(c, row, poTask.assignee.employeeCode!, { subjectType: 'PURCHASE_ORDER', subjectId: po.id, amountSatang: poRoute.amountSatang, stepUpThresholdSatang: poRoute.doaVersion.stepUpThresholdSatang }, 'WEB')
  must(row, 'approve PO', await decideTask(memberCtx(c, poTask.assignee.employeeCode!, poAt, 'WEB', keyOf(row, 'po-approve')), { taskId: poTask.id, decision: 'APPROVE' }, optionsOf(row, 'po-approve')))
  must(row, 'send PO', await sendPurchaseOrder(proc(next('po-send', STEP_MINUTES), 'po-send'), { poId: po.id }, optionsOf(row, 'po-send')))
  if (row.status === 'ORDERED') return

  const grAt = next('gr', DELIVERY_DAYS * c.businessDayMinutes)
  const receiverId = await receiverOf(c, requestId, po.id, grAt)
  const receiver = (at: Date, step: string) => makeCtx({ organizationId: c.organizationId, actor: { type: 'USER', memberId: receiverId }, channel: 'WEB', now: at, requestId: keyOf(row, step) })
  // S8-04 (BR-IVC-06): an organization with PAY on records the supplier's invoice as a tier-2 invoice and matches it;
  // S8-12 plays the scenario of the row (a row of the demo sheet, or without one, matches)
  const pay = (await db.orgModule.count({ where: { module: 'PAY', enabled: true } })) > 0
  const scenario = pay ? (row.invoice?.scenario ?? 'MATCH') : null
  const paid = row.invoice?.paymentStatus === 'PAID'
  const short = scenario === 'QTY_OVER' ? shortOf(po.lines) : new Map<string, bigint>()
  must(
    row,
    'receive',
    await postGoodsReceipt(receiver(grAt, 'gr'), { poId: po.id, deliveryNoteNo: `DN-${row.ref}`, lines: po.lines.map((l) => ({ poLineId: l.id, received: formatQuantity(parseQuantity(l.quantity.toString()) - (short.get(l.id) ?? 0n)) })) }, optionsOf(row, 'gr')),
  )
  const invoiceAt = next('invoice', c.businessDayMinutes)
  if (!pay) {
    const totals = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, select: { netSatang: true, vatSatang: true } })
    must(
      row,
      'invoice',
      await recordInvoice(memberCtx(c, 'fin_officer', invoiceAt, 'WEB', keyOf(row, 'invoice')), { poId: po.id, invoiceNo: `INV-${row.ref}`, invoiceDate: localDate(invoiceAt, c.calendar.timezone), net: satangToAmount(totals.netSatang), vat: satangToAmount(totals.vatSatang), isFinal: true }, optionsOf(row, 'invoice')),
    )
  } else if (scenario !== 'MISSING') {
    // MISSING: no invoice ever came; the PO keeps holding what was received (BR-BUD-06)
    const { invoiceId } = await historyInvoice(c, row, po.id, receiverId, invoiceAt, scenario!)
    // PRICE_OVER paid by S9: the variance was approved under DOA INVOICE_EXCEPTION; the others wait in EXCEPTION
    if (scenario === 'PRICE_OVER' && paid) await approvedVariance(c, row, invoiceId, next('variance', STEP_MINUTES), next('variance-approve', PO_DECISION_MINUTES))
    if (scenario === 'QTY_OVER' && short.size > 0) {
      if (paid) {
        // the rest came later and the invoice matched again by SYSTEM (job invoice-auto-recheck, BR-MATCH-10)
        const restAt = next('gr-rest', DELIVERY_DAYS * c.businessDayMinutes)
        const rest = must(row, 'receive rest', await postGoodsReceipt(receiver(restAt, 'gr-rest'), { poId: po.id, deliveryNoteNo: `DN-${row.ref}-2`, lines: [...short].map(([poLineId, q]) => ({ poLineId, received: formatQuantity(q) })) }, optionsOf(row, 'gr-rest')))
        const [rechecked] = await recheckPoInvoices(c.organizationId, po.id, `gr:${rest.grId}`, restAt)
        if (!rechecked?.ok || rechecked.data.status !== 'READY_FOR_PAYMENT') throw new Error(`Demo_History ${row.ref}: the invoice did not match after the rest came`)
      } else {
        // the rest never comes: PROCUREMENT closes the PO short and its approver approves; the invoice stays EXCEPTION
        must(row, 'close short', await requestCloseShort(proc(next('close-short', MINUTES_PER_HOUR), 'close-short'), { poId: po.id, reason: 'ผู้ขายส่งไม่ครบและจะไม่ส่งส่วนที่เหลือ' }, optionsOf(row, 'close-short')))
        const task = await db.approvalTask.findFirstOrThrow({
          where: { status: 'OPEN', step: { route: { subjectType: 'VARIANCE', subjectId: { in: (await db.variance.findMany({ where: { poId: po.id, disposition: 'CLOSE_SHORT' }, select: { id: true } })).map((v) => v.id) } } } },
          select: { id: true, assignee: { select: { employeeCode: true } } },
        })
        must(row, 'close short approve', await decideTask(memberCtx(c, task.assignee.employeeCode!, next('close-short-approve', PO_DECISION_MINUTES), 'WEB', keyOf(row, 'close-short-approve')), { taskId: task.id, decision: 'APPROVE' }, optionsOf(row, 'close-short-approve')))
        return
      }
    }
  }
  must(row, 'close PO', await closePurchaseOrder(proc(next('po-close', MINUTES_PER_HOUR), 'po-close'), { poId: po.id }, optionsOf(row, 'po-close')))
}

/** Whether any step of the history has been made in the organization (its events, or a command still in CommandLog) */
export async function demoHistoryStarted(organizationId: string): Promise<boolean> {
  const db = forTenant(organizationId)
  const made = (await db.event.count({ where: { requestId: { startsWith: escapeLike(HISTORY_KEY) } } })) + (await db.commandLog.count({ where: { idempotencyKey: { contains: escapeLike(HISTORY_KEY) } } }))
  return made > 0
}

/**
 * P1-11: rows of one part of the history at most, so that each part the staging reset runs as its own Inngest step ends
 * well inside one call of /api/inngest (maxDuration 300 s): a row of phase 1 takes up to about 3 s on this machine
 * (pnpm db:reset:p1, 2026-10-17), and a statement on staging is slower (Vercel and Neon in Singapore)
 */
export const HISTORY_ROWS_PER_PART = 10

/**
 * A part of the history, in the order the whole history makes them: rows decided or cancelled (oldest first) → the
 * payment runs of the past → what those told people marked read → the rows still waiting → the invoice inbox
 */
export type DemoHistoryPart = { readonly kind: 'DONE' | 'WAITING'; readonly refs: readonly string[] } | { readonly kind: 'PAYMENTS' | 'READ' | 'INBOX' }

/** Decided and cancelled requests first, oldest first; then the requests still waiting, whose task notices stay new */
function orderRows(rows: readonly DemoHistoryRow[]) {
  const ordered = [...rows].sort((a, b) => b.daysAgo - a.daysAgo || a.ref.localeCompare(b.ref))
  return { done: ordered.filter((r) => r.status !== 'PENDING_APPROVAL'), waiting: ordered.filter((r) => r.status === 'PENDING_APPROVAL') }
}

/** The parts of a history, none for a sheet without rows */
export function demoHistoryParts(rows: readonly DemoHistoryRow[], rowsPerPart: number = HISTORY_ROWS_PER_PART): DemoHistoryPart[] {
  if (!Number.isInteger(rowsPerPart) || rowsPerPart < 1) throw new RangeError(`rowsPerPart must be a whole number from 1 (${rowsPerPart})`)
  if (rows.length === 0) return []
  const { done, waiting } = orderRows(rows)
  const slices = (list: readonly DemoHistoryRow[], kind: 'DONE' | 'WAITING'): DemoHistoryPart[] =>
    Array.from({ length: Math.ceil(list.length / rowsPerPart) }, (_, i) => ({ kind, refs: list.slice(i * rowsPerPart, (i + 1) * rowsPerPart).map((r) => r.ref) }))
  return [...slices(done, 'DONE'), { kind: 'PAYMENTS' }, { kind: 'READ' }, ...slices(waiting, 'WAITING'), { kind: 'INBOX' }]
}

/** A part of the history was made before, in full or in part: only a fresh reset gives the demo its numbers again */
export class DemoHistoryPartMadeError extends Error {
  constructor(readonly part: number) {
    super(`part ${part + 1} of the demo history was made before (in full or in part): reset staging again`)
    this.name = 'DemoHistoryPartMadeError'
  }
}

/** Whether any step of this part has been made: the idempotency keys of its steps, in its events or CommandLog */
async function partStarted(organizationId: string, part: DemoHistoryPart): Promise<boolean> {
  const db = forTenant(organizationId)
  if (part.kind === 'INBOX') {
    // the inbox mails of a row are keyed demo-history:<ref>:inbox
    const inbox = { startsWith: escapeLike(HISTORY_KEY), endsWith: escapeLike(':inbox') }
    return (await db.event.count({ where: { requestId: inbox } })) + (await db.commandLog.count({ where: { idempotencyKey: { contains: escapeLike(HISTORY_KEY), endsWith: escapeLike(':inbox') } } })) > 0
  }
  const prefixes = 'refs' in part ? part.refs.map((ref) => `${HISTORY_KEY}${ref}:`) : part.kind === 'PAYMENTS' ? [PAYMENT_HISTORY_KEY] : [`${HISTORY_KEY}read:`]
  const events = await db.event.count({ where: { OR: prefixes.map((p) => ({ requestId: { startsWith: escapeLike(p) } })) } })
  const commands = await db.commandLog.count({ where: { OR: prefixes.map((p) => ({ idempotencyKey: { contains: escapeLike(p) } })) } })
  return events + commands > 0
}

/** Reads the organization, checks every row and builds what the parts of the history share; writes nothing */
async function historyContext(organizationId: string, rows: readonly DemoHistoryRow[], now: Date, options: DemoHistoryOptions): Promise<Context> {
  const db = forTenant(organizationId)
  const calendar = await db.$transaction((tx) => loadBusinessCalendar(tx, organizationId))
  // A row that names a budget key needs the lines of each key by fiscal year: without them every row would be refused
  // as if sheet Budget lacked its line
  if (!options.budgetKeys && rows.some((row) => 'key' in row.budget)) throw new TypeError('seedDemoHistory: rows name budget keys but options.budgetKeys is missing (budgetKeyLines of sheet Budget)')
  const [members, suppliers, sites, fiscal, years] = await Promise.all([
    db.member.findMany({ where: { status: 'ACTIVE', employeeCode: { not: null } }, select: { id: true, employeeCode: true } }),
    db.supplier.findMany({ select: { id: true, code: true } }),
    db.deliverySite.findMany({ select: { id: true, code: true } }),
    db.budgetLine.findMany({ select: { id: true, code: true, fiscalYear: { select: { code: true, startsOn: true, endsOn: true } } } }),
    db.fiscalYear.findMany({ select: { code: true, startsOn: true, endsOn: true } }),
  ])
  const [startH, startM] = calendar.start.split(':').map(Number)
  const [endH, endM] = calendar.end.split(':').map(Number)
  const c: Context = {
    organizationId,
    now,
    calendar,
    businessDayMinutes: endH! * MINUTES_PER_HOUR + endM! - (startH! * MINUTES_PER_HOUR + startM!),
    members: new Map(members.map((m) => [m.employeeCode!, m.id])),
    suppliers: new Map(suppliers.map((s) => [s.code, s.id])),
    sites: new Map(sites.map((s) => [s.code, s.id])),
    budgetLines: new Map(fiscal.map((b) => [b.code, b.id])),
    linesByYear: new Map(fiscal.map((b) => [`${b.fiscalYear.code}|${b.code}`, b.id])),
    fiscalYears: years.map((y) => ({ code: y.code, startsOn: y.startsOn.toISOString().slice(0, 10), endsOn: y.endsOn.toISOString().slice(0, 10) })),
    budgetKeys: options.budgetKeys ?? new Map(),
    // The seed's PIN, or a one-time PIN when the seed gave none (see above)
    pin: options.pin ?? randomDemoPin(),
  }

  // Every row of the demo sheet lies inside the fiscal year of its budget line, from its first day to today; every row
  // of phase 1 has its key's line in the fiscal year of the day it is sent
  const yearOf = new Map(fiscal.map((b) => [b.code, b.fiscalYear]))
  const dateText = (day: Date) => day.toISOString().slice(0, 10)
  for (const row of rows) {
    if ('key' in row.budget) {
      const { submitAt } = timesOf(c, row)
      if (!budgetLineOf(c, row, submitAt)) throw new DemoHistoryNoBudgetLineError(row.ref, taxDateOf(submitAt), row.budget.key)
      continue
    }
    const year = yearOf.get(row.budget.line)
    if (!year) continue
    for (const at of [timesOf(c, row).draftAt, now]) {
      const day = localDate(at, calendar.timezone)
      if (day < dateText(year.startsOn) || day > dateText(year.endsOn)) throw new DemoHistoryOutOfYearError(row.ref, day, year.code, dateText(year.startsOn), dateText(year.endsOn))
    }
  }
  // Every row's quotations can be made exactly, whether or not its form will ask for them: the sheet gives its nets in
  // whole baht (HistoryRow), and a net that is not is refused here with DemoHistoryNetError, before anything is written,
  // rather than half way through the history (quotations.ts)
  for (const row of rows) quotationAmounts(row)
  return c
}

/**
 * Runs `make` with what every part needs before it writes: the approvers holding the PIN they step up with, the bucket
 * answering, and POs of the past sent nowhere; the one-time PINs (no SEED_DEV_PIN) are taken back whatever happens
 */
async function withHistoryReady<T>(c: Context, options: DemoHistoryOptions, make: () => Promise<T>): Promise<T> {
  // Without the seed's PIN, the approvers without a PIN hold the one-time PIN until the history returns or stops
  let oneTime: OneTimePins = new Map()
  try {
    if (options.pin === null) oneTime = await giveOneTimePins(c.organizationId, c.pin, c.now)
    // The approvers step up with that PIN for their high-amount decisions (FR-AUTH-005 AC2): every one of them holds it
    const withoutPin = await approversWithoutPin(c.organizationId, c.pin, c.now)
    if (withoutPin.length > 0) throw new DemoHistoryPinError(withoutPin)

    // Quotations and the PDFs of POs are files: the bucket has to answer before anything is written
    try {
      await checkBucket()
    } catch (error) {
      throw new DemoHistoryStorageError(error instanceof Error ? error.name : String(error))
    }

    // POs of the past go nowhere
    setEmailProvider({ send: async () => ({ messageId: 'demo-history' }) })
    try {
      return await make()
    } finally {
      setEmailProvider(null)
    }
  } finally {
    await takeBackOneTimePins(c.organizationId, oneTime)
  }
}

/** The time of the step that wrote each invoice e-mail to a supplier (BR-AP-08) */
const INVOICE_NOTICE_TIMES: Readonly<Record<string, 'submittedAt' | 'readyAt' | 'rejectedAt'>> = {
  [SUPPLIER_TEMPLATES.invoiceReceived]: 'submittedAt',
  [SUPPLIER_TEMPLATES.invoiceReady]: 'readyAt',
  [SUPPLIER_TEMPLATES.invoiceRejected]: 'rejectedAt',
}

/**
 * NEW-97 (BR-AP-08): the e-mails the invoices of the past wrote to their suppliers (received, ready for payment,
 * rejected) went out at the time of the step that wrote them, through the history's fake sender (withHistoryReady), and
 * are SENT with their event then: the job supplier-notice-send finds none of them PENDING, so no supplier of the demo
 * is e-mailed about an invoice of the past (on staging its sweep runs every 30 minutes). Called after each row and after
 * the inbox, well before the sweep takes a notice a minute old. A notice of a command after the seed is sent by the job.
 */
async function sendHistoryInvoiceNotices(c: Context): Promise<void> {
  const db = forTenant(c.organizationId)
  const pending = await db.supplierNotice.findMany({
    where: { status: 'PENDING', subjectType: 'Invoice', templateKey: { in: Object.keys(INVOICE_NOTICE_TIMES) } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, templateKey: true, subjectId: true },
  })
  if (pending.length === 0) return
  const invoices = await db.invoice.findMany({ where: { id: { in: [...new Set(pending.map((n) => n.subjectId))] } }, select: { id: true, submittedAt: true, readyAt: true, rejectedAt: true } })
  const byId = new Map(invoices.map((i) => [i.id, i]))
  for (const notice of pending) {
    const at = byId.get(notice.subjectId)?.[INVOICE_NOTICE_TIMES[notice.templateKey]!]
    if (!at) throw new Error(`Demo_History: the ${notice.templateKey} e-mail of invoice ${notice.subjectId} has no time of the step that wrote it`)
    await sendSupplierNotice(c.organizationId, notice.id, at)
  }
}

/** Makes one part; `done` are every row decided or cancelled, in order (the payment runs and the inbox look at them all) */
async function makePart(c: Context, part: DemoHistoryPart, rows: readonly DemoHistoryRow[], done: readonly DemoHistoryRow[]): Promise<DemoHistoryReport> {
  const db = forTenant(c.organizationId)
  const byStatus: Record<string, number> = {}
  if (part.kind === 'DONE' || part.kind === 'WAITING') {
    const byRef = new Map(rows.map((r) => [r.ref, r]))
    for (const ref of part.refs) {
      const row = byRef.get(ref)
      if (!row) throw new Error(`Demo_History: part names row ${ref}, which the sheet does not have`)
      await replay(c, row)
      await sendHistoryInvoiceNotices(c)
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    }
    return { seeded: true, byStatus }
  }
  if (part.kind === 'PAYMENTS') {
    // S9-10: the invoices the sheet marks PAID, paid by the weekly runs of the past (before their notices are read)
    if (!(await db.orgModule.count({ where: { module: 'PAY', enabled: true } }))) return { seeded: true, byStatus }
    const paid = done.flatMap((row) => (row.invoice?.paymentStatus === 'PAID' && row.invoice.scenario !== 'MISSING' && row.supplier ? [{ supplierCode: row.supplier, invoiceNo: row.invoice.invoiceNo ?? `INV-${row.ref}` }] : []))
    const payments = await seedPaymentHistory(c, paid)
    return { seeded: true, byStatus, paymentRuns: payments.runs, paidInvoices: payments.invoices, unpaidInvoices: payments.left }
  }
  if (part.kind === 'READ') {
    for (const [code] of c.members) {
      const marked = await markNotificationsRead(memberCtx(c, code, c.now, 'WEB', `${HISTORY_KEY}read:${code}`), { all: true }, { idempotencyKey: `${HISTORY_KEY}read:${code}`, sender: null, suppressOutbox: true })
      if (!marked.ok && marked.error.code !== 'NOT_FOUND') throw new Error(`Demo_History: marking ${code}'s notifications read: ${marked.error.code}`)
    }
    return { seeded: true, byStatus }
  }
  // S8-12: what waits in the invoice inbox, after the history so FINANCE sees it as new
  if (await db.orgModule.count({ where: { module: 'PAY', enabled: true } })) {
    await historyInbox(c, done)
    await sendHistoryInvoiceNotices(c)
  }
  return { seeded: true, byStatus }
}

/** The reports of the parts as one: statuses added up, the payment runs from the part that made them */
export function joinHistoryReports(reports: readonly DemoHistoryReport[]): DemoHistoryReport {
  const byStatus: Record<string, number> = {}
  let payments: Pick<DemoHistoryReport, 'paymentRuns' | 'paidInvoices' | 'unpaidInvoices'> = {}
  for (const report of reports) {
    for (const [status, n] of Object.entries(report.byStatus)) byStatus[status] = (byStatus[status] ?? 0) + n
    if (report.paymentRuns !== undefined) payments = { paymentRuns: report.paymentRuns, paidInvoices: report.paidInvoices ?? 0, unpaidInvoices: report.unpaidInvoices ?? 0 }
  }
  return { seeded: reports.some((r) => r.seeded), byStatus, ...payments }
}

/**
 * D-01: the demo history of one organization. A history made in full before is left alone; one that an earlier seed
 * stopped half way (a storage that was down, a row the routes refused) throws DemoHistoryIncompleteError rather than
 * leave the board and the dashboard with numbers the demo does not expect. `options.pin` is the PIN the seed gave the
 * demo approvers: a history that is yet to be made needs every one of them to hold it (DemoHistoryPinError otherwise).
 * null: the seed gave none, and the approvers without a PIN hold a one-time PIN only while the history runs.
 */
export async function seedDemoHistory(organizationId: string, rows: readonly DemoHistoryRow[], now: Date, options: DemoHistoryOptions): Promise<DemoHistoryReport> {
  const db = forTenant(organizationId)
  const { done, waiting } = orderRows(rows)
  const last = [...done, ...waiting].at(-1)
  if (!last) return { seeded: false, byStatus: {} }
  // What the history made is read from its events, which are kept for good (CommandLog only for 90 days, §6.2): every
  // step's events carry the step's key as their requestId. The last row's last step made → the history is whole.
  if (await demoHistoryStarted(organizationId)) {
    if (await db.event.count({ where: { requestId: { in: lastSteps(last).map((step) => keyOf(last, step)) } } })) return { seeded: false, byStatus: {} }
    throw new DemoHistoryIncompleteError(last.ref)
  }
  const c = await historyContext(organizationId, rows, now, options)
  return withHistoryReady(c, options, async () => {
    const reports: DemoHistoryReport[] = []
    for (const part of demoHistoryParts(rows)) reports.push(await makePart(c, part, rows, done))
    return joinHistoryReports(reports)
  })
}

/**
 * P1-11: part `index` of demoHistoryParts(rows) alone, for the staging reset, which runs each part as its own Inngest
 * step. Every part takes the same `now` (the reset's), so the rows fall on the days the whole history gives them. A part
 * is made once: the first part refuses an organization whose history has started, any other part one whose steps it
 * finds (DemoHistoryPartMadeError, say a step Inngest ran again after its call died); the parts run in order because
 * the job awaits each step before the next.
 */
export async function seedDemoHistoryPart(organizationId: string, rows: readonly DemoHistoryRow[], now: Date, options: DemoHistoryOptions, index: number): Promise<DemoHistoryReport> {
  const parts = demoHistoryParts(rows)
  const part = parts[index]
  if (!part) throw new RangeError(`the demo history has ${parts.length} parts, not part ${index + 1}`)
  if (index === 0 ? await demoHistoryStarted(organizationId) : await partStarted(organizationId, part)) throw new DemoHistoryPartMadeError(index)
  const c = await historyContext(organizationId, rows, now, options)
  return withHistoryReady(c, options, () => makePart(c, part, rows, orderRows(rows).done))
}
