import { TZDate } from '@date-fns/tz'
import { satangToAmount } from '@/core/money/dto'
import { stepUpNeeded } from '@/core/pin'
import type { Result } from '@/core/result'
import { addBusinessMinutes, subtractBusinessMinutes, type BusinessCalendar } from '@/core/sla'
import { taxDateOf } from '@/core/vat'
import { systemClock } from '@/lib/clock'
import { MS_PER_DAY } from '@/lib/constants'
import { setEmailProvider } from '@/integrations/email-provider'
import { checkBucket } from '@/integrations/storage'
import { grantStepUp } from '@/server/auth/step-up'
import { makeCtx, type Ctx } from '@/server/context'
import { escapeLike } from '@/server/db/like'
import { forTenant } from '@/server/db/tenant'
import { effectiveSodPolicy, loadBusinessCalendar } from '@/server/doa/policy'
import { approversWithoutPin, giveOneTimePins, randomDemoPin, takeBackOneTimePins, type OneTimePins } from '@/server/seed/pins'
import { budgetLineOn, type HistoryBudgetLines } from '@/server/seed/budget-keys'
import type { DemoHistoryRow } from '@/server/seed/sheets'
import type { RunOptions } from '../_pipeline'
import { decideTask } from '../approvals/decide'
import { completeUpload, requestUpload } from '../files'
import { recordInvoice } from '../invoices'
import { markNotificationsRead } from '../notifications'
import { assignSupplier, consolidateNow } from '../procurement'
import { closePurchaseOrder, submitPo } from '../purchase-orders'
import { sendPurchaseOrder } from '../purchase-orders/send'
import { postGoodsReceipt } from '../receiving'
import { departmentReceivers } from '../receiving/receivers'
import { cancelRequest, createDraft, editRequest, submitRequest } from '../requests'
import { attachFile } from '../requests/attachments'
import { quotationAmounts } from './quotations'

export { budgetKeyLines } from '@/server/seed/budget-keys'
export { DemoHistoryNetError } from './quotations'

// The demo history (spec D-01, §16.10 "ข้อมูล"): the requests of sheet Demo_History, made through the real services
// with the business clock set back, so every row ends in its status with real routes, decisions, budget movements,
// POs, receipts and invoices. Each row starts `daysAgo` days before the seed; a decision comes `hours` business
// hours after the submit, through the row's channel; a request still waiting has waited `hours` business hours at the
// time of the seed (core subtractBusinessMinutes), which is what the board shows (FR-VIS-001). The route of every row
// is checked against the rule, approver and escalation the sheet expects. Nothing is sent: the outbox of the past is
// written suppressed and POs go to a mail provider that drops them. Every step has a fixed idempotency key, and an
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
  if (row.status === 'COMPLETED') return ['po-close']
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
  route: { readonly subjectType: 'REQUEST' | 'PURCHASE_ORDER'; readonly subjectId: string; readonly amountSatang: bigint | null; readonly stepUpThresholdSatang: bigint | null },
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
  let sent = await submitRequest(requester(submitAt, 'submit'), { requestId }, optionsOf(row, 'submit'))
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
    sent = await submitRequest(requester(submitAt, 'submit-with-quotations'), { requestId }, optionsOf(row, 'submit-with-quotations'))
  }
  must(row, 'submit', sent)

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
  const receiver = makeCtx({ organizationId: c.organizationId, actor: { type: 'USER', memberId: receiverId }, channel: 'WEB', now: grAt, requestId: keyOf(row, 'gr') })
  must(row, 'receive', await postGoodsReceipt(receiver, { poId: po.id, deliveryNoteNo: `DN-${row.ref}`, lines: po.lines.map((l) => ({ poLineId: l.id, received: l.quantity.toString() })) }, optionsOf(row, 'gr')))
  const invoiceAt = next('invoice', c.businessDayMinutes)
  const totals = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, select: { netSatang: true, vatSatang: true } })
  must(
    row,
    'invoice',
    await recordInvoice(memberCtx(c, 'fin_officer', invoiceAt, 'WEB', keyOf(row, 'invoice')), { poId: po.id, invoiceNo: `INV-${row.ref}`, invoiceDate: localDate(invoiceAt, c.calendar.timezone), net: satangToAmount(totals.netSatang), vat: satangToAmount(totals.vatSatang), isFinal: true }, optionsOf(row, 'invoice')),
  )
  must(row, 'close PO', await closePurchaseOrder(proc(next('po-close', MINUTES_PER_HOUR), 'po-close'), { poId: po.id }, optionsOf(row, 'po-close')))
}

/**
 * D-01: the demo history of one organization. A history made in full before is left alone; one that an earlier seed
 * stopped half way (a storage that was down, a row the routes refused) throws DemoHistoryIncompleteError rather than
 * leave the board and the dashboard with numbers the demo does not expect. `options.pin` is the PIN the seed gave the
 * demo approvers: a history that is yet to be made needs every one of them to hold it (DemoHistoryPinError otherwise).
 * null: the seed gave none, and the approvers without a PIN hold a one-time PIN only while the history runs.
 */
/** Whether any step of the history has been made in the organization (its events, or a command still in CommandLog) */
export async function demoHistoryStarted(organizationId: string): Promise<boolean> {
  const db = forTenant(organizationId)
  const made = (await db.event.count({ where: { requestId: { startsWith: escapeLike(HISTORY_KEY) } } })) + (await db.commandLog.count({ where: { idempotencyKey: { contains: escapeLike(HISTORY_KEY) } } }))
  return made > 0
}

export async function seedDemoHistory(organizationId: string, rows: readonly DemoHistoryRow[], now: Date, options: DemoHistoryOptions): Promise<DemoHistoryReport> {
  const db = forTenant(organizationId)
  // Decided and cancelled requests first, oldest first; then what they told people is marked read; then the requests
  // still waiting, whose task notices stay new (the board and the bell of the demo)
  const ordered = [...rows].sort((a, b) => b.daysAgo - a.daysAgo || a.ref.localeCompare(b.ref))
  const done = ordered.filter((r) => r.status !== 'PENDING_APPROVAL')
  const waiting = ordered.filter((r) => r.status === 'PENDING_APPROVAL')
  const last = [...done, ...waiting].at(-1)
  if (!last) return { seeded: false, byStatus: {} }
  // What the history made is read from its events, which are kept for good (CommandLog only for 90 days, §6.2): every
  // step's events carry the step's key as their requestId. The last row's last step made → the history is whole.
  if (await demoHistoryStarted(organizationId)) {
    if (await db.event.count({ where: { requestId: { in: lastSteps(last).map((step) => keyOf(last, step)) } } })) return { seeded: false, byStatus: {} }
    throw new DemoHistoryIncompleteError(last.ref)
  }

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

  // Without the seed's PIN, the approvers without a PIN hold the one-time PIN until the history returns or stops
  let oneTime: OneTimePins = new Map()
  try {
    if (options.pin === null) oneTime = await giveOneTimePins(organizationId, c.pin, now)
    // The approvers step up with that PIN for their high-amount decisions (FR-AUTH-005 AC2): every one of them holds it
    const withoutPin = await approversWithoutPin(organizationId, c.pin, now)
    if (withoutPin.length > 0) throw new DemoHistoryPinError(withoutPin)

    // Quotations and the PDFs of POs are files: the bucket has to answer before anything is written
    try {
      await checkBucket()
    } catch (error) {
      throw new DemoHistoryStorageError(error instanceof Error ? error.name : String(error))
    }

    // POs of the past go nowhere
    setEmailProvider({ send: async () => ({ messageId: 'demo-history' }) })
    const byStatus: Record<string, number> = {}
    try {
      for (const row of done) {
        await replay(c, row)
        byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
      }
      for (const [code] of c.members) {
        const marked = await markNotificationsRead(memberCtx(c, code, now, 'WEB', `${HISTORY_KEY}read:${code}`), { all: true }, { idempotencyKey: `${HISTORY_KEY}read:${code}`, sender: null, suppressOutbox: true })
        if (!marked.ok && marked.error.code !== 'NOT_FOUND') throw new Error(`Demo_History: marking ${code}'s notifications read: ${marked.error.code}`)
      }
      for (const row of waiting) {
        await replay(c, row)
        byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
      }
    } finally {
      setEmailProvider(null)
    }
    return { seeded: true, byStatus }
  } finally {
    await takeBackOneTimePins(organizationId, oneTime)
  }
}
