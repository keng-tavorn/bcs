import { z } from 'zod'
import { formatSatang } from '@/core/money/format'
import { buildItem, checkPayDate, flagsKey, nextRunDate, proposeDocuments, type ItemDocument, type PayCalendar, type PaymentFlag, type Weekday } from '@/core/payment'
import { err, ok, type Result } from '@/core/result'
import { checkSod, recentBankChangeProposers, type RecentBankChanges } from '@/core/sod'
import { PAYMENT_RUN_MACHINE, transition, type PaymentRunCommand, type PaymentRunState } from '@/core/state-machines'
import { taxDateOf } from '@/core/vat'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { paymentSettingsOf } from '@/lib/org-settings'
import { authorize, isAllowed, loadPrincipal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { itemFlagsNow, REASON_FLAGS, supplierFacts, type SupplierFacts } from '@/server/queries/payment-runs'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { fail, type Fail } from '../ap/common'
import { holdInvoicesForPayment, releaseInvoicesFromPayment } from '../ap/payment'
import { holdRetentionsForPayment, releaseRetentionsFromPayment } from '../ap/retention'
import { invoiceWhtLines, retentionWhtLines } from '../ap/wht'
import { closeRoute, startRoute } from '../approvals/route'
import { rootDepartmentId } from '../bank-accounts'
import { requireModule } from '../modules'
import { issueDocumentNumber } from '../numbering'

// Preparing and sending a payment run (S9-05, docs/sub-specs/S9.md, BR-PAY-01 to BR-PAY-09, BR-SOD-10, ADR-133,
// ADR-134, FR-PAY-101). FINANCE drafts a run from one ACTIVE account of the organization on a working pay date
// (proposed from payment.runWeekdays and the holidays, OQ-130), adds READY_FOR_PAYMENT invoices and RELEASABLE
// retentions — each held by S8 in the same transaction, the rows locked in id order, so a document is in one live run
// at most (INV-PAY-01) — and the run keeps one item per supplier with what it pays, the tax withheld at payment and
// what is transferred (core/payment, S8's bases). Only the preparer edits the draft (BR-PAY-09). A document taken out
// of a draft leaves it with its link (a draft never had a file), and goes back to S8 ready for payment. Sending checks
// the date again, gives each item its sequence by supplier code and a snapshot of the supplier's ACTIVE account,
// recomputes amounts and flags — the flags that need the preparer's reason must have one — and routes the run under DOA
// PAYMENT_RUN with what is transferred, in the root department's name, the preparer, the invoices' recorders and the
// proposers of a recent change of an account it pays into kept off the route (BR-PAY-08, BR-DOA-06). Whoever changed an
// account the run pays into within payment.recentBankChangeDays of the pay date may not prepare it (BR-SOD-10). A
// cancelled draft or waiting run lets every document go. Every command needs module PAY (BR-PAY-01). Events carry ids,
// amounts and last four digits only (BR-BANK-08).

const MIN_REASON_LENGTH = 3
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const asDate = (d: string) => new Date(`${d}T00:00:00Z`)
const dayOf = (d: Date) => d.toISOString().slice(0, 10)

type RunRow = NonNullable<Awaited<ReturnType<typeof readRun>>>

function readRun(tx: TenantTx, id: string) {
  return tx.paymentRun.findFirst({ where: { id } })
}

/** FINANCE with paymentRun.prepare of an organization with PAY switched on */
async function preparer(tx: TenantTx, ctx: Ctx): Promise<{ ok: true; memberId: string } | Fail> {
  const allowed = await authorize(tx, ctx, 'paymentRun.prepare')
  if (!allowed.ok) return { ok: false, error: allowed.error }
  if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'only a member prepares a payment run')
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return { ok: false, error: pay.error }
  return { ok: true, memberId: allowed.data.memberId }
}

/** The run locked (INV-PLT-03), the command checked against its state machine and the version the screen read */
async function lockedRun(tx: TenantTx, ctx: Ctx, id: string, command: PaymentRunCommand, version?: number): Promise<{ ok: true; run: RunRow; to: PaymentRunState } | Fail> {
  const [locked] = await lockRowsForUpdate(tx, 'PaymentRun', ctx.organizationId, [id])
  const run = locked ? await readRun(tx, id) : null
  if (!run) return fail('NOT_FOUND', 'payment run not found')
  const moved = transition(PAYMENT_RUN_MACHINE, run.status as PaymentRunState, command)
  if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${run.status}`, { from: run.status, command })
  if (version !== undefined && run.version !== version) return fail('CONFLICT_VERSION', 'the run changed since it was read', { version: run.version })
  return { ok: true, run, to: moved.to }
}

/** BR-PAY-09: the draft is its preparer's alone; others see it and hand it over by cancelling and preparing again */
const preparedBy = (run: RunRow, memberId: string): Fail | null =>
  run.preparedById === memberId ? null : fail('FORBIDDEN', 'only the preparer changes this run', { capability: 'paymentRun.prepare' })

async function payCalendar(tx: TenantTx, ctx: Ctx): Promise<PayCalendar> {
  const calendar = await loadBusinessCalendar(tx, ctx.organizationId)
  return { workdays: calendar.workdays, holidays: calendar.holidays }
}

async function settingsOf(tx: TenantTx, ctx: Ctx) {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  return { settings: org.settings, payment: paymentSettingsOf(org.settings) }
}

/** BR-PAY-02: a working day, today or later in Thai time */
async function checkDate(tx: TenantTx, ctx: Ctx, payDate: string): Promise<Fail | null> {
  let checked
  try {
    checked = checkPayDate(payDate, ctx.now, await payCalendar(tx, ctx))
  } catch {
    return fail('VALIDATION_FAILED', 'the pay date is not a calendar day', { field: 'payDate', reason: 'FORMAT' })
  }
  return checked.ok ? null : fail('PAYMENT_DATE_INVALID', `the pay date ${payDate} cannot be used`, { date: payDate, reason: checked.reason })
}

/** BR-PAY-02, OQ-130: the next run day from today; a calendar with no working day on a run weekday within a year is refused */
async function proposedPayDate(tx: TenantTx, ctx: Ctx, payment: { readonly runWeekdays: readonly Weekday[]; readonly holidayShift: 'PREVIOUS' | 'NEXT' }): Promise<string | Fail> {
  try {
    return nextRunDate(taxDateOf(ctx.now), payment, await payCalendar(tx, ctx))
  } catch {
    return fail('VALIDATION_FAILED', 'no working day to pay on within a year: check the business calendar and the run weekdays', { field: 'payDate', reason: 'NO_WORKING_DAY' })
  }
}

/** BR-PAY-01: the run pays from an ACTIVE account of the organization */
async function checkPayer(tx: TenantTx, payerBankAccountId: string): Promise<{ ok: true; fileTemplateCode: string } | Fail> {
  const payer = await tx.bankAccount.findFirst({ where: { id: payerBankAccountId }, select: { ownerKind: true, status: true, fileTemplateCode: true } })
  if (!payer || payer.ownerKind !== 'ORGANIZATION' || payer.status !== 'ACTIVE' || !payer.fileTemplateCode) return fail('VALIDATION_FAILED', 'the run pays from an account of the organization in force', { field: 'payerBankAccountId', reason: 'PAYER_NOT_ACTIVE' })
  return { ok: true, fileTemplateCode: payer.fileTemplateCode }
}

// ---------- what a run would pay: proposal (BR-PAY-02, BR-PAY-03) ----------

export interface RunProposal {
  readonly payDate: string
  readonly payers: ReadonlyArray<{ readonly id: string; readonly code: string | null; readonly bankCode: string; readonly last4: string; readonly fileTemplateCode: string | null }>
  readonly documents: ReadonlyArray<{ readonly kind: 'INVOICE' | 'RETENTION'; readonly id: string; readonly supplierId: string; readonly number: string | null; readonly dueDate: string | null; readonly payableSatang: string }>
}

/**
 * FR-PAY-101 AC1: the pay date proposed from the run weekdays and the holidays (or the date asked), the payer accounts
 * in force, and what the run would take: invoices ready for payment due on or before the pay date, and every
 * released retention. A document already in a live run is not ready (S8 holds it), so it is not proposed.
 */
export async function proposePaymentRun(ctx: Ctx, input: { readonly payDate?: string } = {}): Promise<Result<RunProposal>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    if (principal.kind !== 'member' || !isAllowed(principal, 'paymentRun.prepare')) return err('FORBIDDEN', 'you may not prepare a payment run', { capability: 'paymentRun.prepare' })
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return pay
    const { payment } = await settingsOf(tx, ctx)
    const proposed = input.payDate ?? (await proposedPayDate(tx, ctx, payment))
    if (typeof proposed !== 'string') return { ok: false, error: proposed.error }
    const payDate = proposed
    if (input.payDate !== undefined) {
      const refused = await checkDate(tx, ctx, payDate)
      if (refused) return { ok: false, error: refused.error }
    }
    const payers = await tx.bankAccount.findMany({ where: { ownerKind: 'ORGANIZATION', status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { createdAt: 'asc' }], select: { id: true, code: true, bankCode: true, accountNo: true, fileTemplateCode: true } })
    const invoices = await tx.invoice.findMany({ where: { kind: 'INVOICE', status: 'READY_FOR_PAYMENT' }, orderBy: [{ dueDate: 'asc' }, { number: 'asc' }], select: { id: true, supplierId: true, number: true, dueDate: true, payableSatang: true } })
    const retentions = await tx.retention.findMany({ where: { status: 'RELEASABLE' }, orderBy: [{ releaseDueOn: 'asc' }, { id: 'asc' }], select: { id: true, supplierId: true, amountSatang: true, invoice: { select: { number: true } } } })
    const docs = [
      ...invoices.map((i) => ({ kind: 'INVOICE' as const, id: i.id, supplierId: i.supplierId, number: i.number, dueDate: i.dueDate ? dayOf(i.dueDate) : null, payableSatang: i.payableSatang.toString() })),
      ...retentions.map((r) => ({ kind: 'RETENTION' as const, id: r.id, supplierId: r.supplierId, number: r.invoice.number, dueDate: null, payableSatang: r.amountSatang.toString() })),
    ]
    return ok({ payDate, payers: payers.map((p) => ({ id: p.id, code: p.code, bankCode: p.bankCode, last4: p.accountNo.slice(-4), fileTemplateCode: p.fileTemplateCode })), documents: proposeDocuments(payDate, docs) })
  })
}

// ---------- paymentRun.create ----------

const CreateInput = z.strictObject({ payerBankAccountId: z.uuid(), payDate: day.optional() })

export const createPaymentRunCommand = defineCommand({
  name: 'paymentRun.create',
  capability: 'paymentRun.prepare',
  input: CreateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentRunId: string; payDate: string }>> {
    const who = await preparer(tx, ctx)
    if (!who.ok) return who
    const { payment } = await settingsOf(tx, ctx)
    const proposed = input.payDate ?? (await proposedPayDate(tx, ctx, payment))
    if (typeof proposed !== 'string') return proposed
    const payDate = proposed
    const refused = await checkDate(tx, ctx, payDate)
    if (refused) return refused
    const payer = await checkPayer(tx, input.payerBankAccountId)
    if (!payer.ok) return payer
    const run = await tx.paymentRun.create({
      data: { organizationId: ctx.organizationId, payDate: asDate(payDate), payerBankAccountId: input.payerBankAccountId, fileTemplateCode: payer.fileTemplateCode, preparedById: who.memberId },
      select: { id: true },
    })
    return { ok: true, result: { paymentRunId: run.id, payDate }, events: [{ type: 'payment_run.drafted', aggregateType: 'PaymentRun', aggregateId: run.id, data: { payDate, payerBankAccountId: input.payerBankAccountId } }] }
  },
})

export function createPaymentRun(ctx: Ctx, input: z.input<typeof CreateInput>, options: RunOptions) {
  return runCommand(ctx, createPaymentRunCommand, input, options)
}

// ---------- paymentRun.update ----------

const UpdateInput = z.strictObject({ paymentRunId: z.uuid(), version: z.number().int().min(0), payDate: day.optional(), payerBankAccountId: z.uuid().optional() })

export const updatePaymentRunCommand = defineCommand({
  name: 'paymentRun.update',
  capability: 'paymentRun.prepare',
  input: UpdateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentRunId: string; version: number }>> {
    const who = await preparer(tx, ctx)
    if (!who.ok) return who
    const found = await lockedRun(tx, ctx, input.paymentRunId, 'paymentRun.update', input.version)
    if (!found.ok) return found
    const notPreparer = preparedBy(found.run, who.memberId)
    if (notPreparer) return notPreparer
    if (input.payDate === undefined && input.payerBankAccountId === undefined) return fail('VALIDATION_FAILED', 'nothing to change', { reason: 'NOTHING' })
    const fields: string[] = []
    const data: { payDate?: Date; payerBankAccountId?: string; fileTemplateCode?: string } = {}
    if (input.payDate !== undefined) {
      const refused = await checkDate(tx, ctx, input.payDate)
      if (refused) return refused
      data.payDate = asDate(input.payDate)
      fields.push('payDate')
    }
    if (input.payerBankAccountId !== undefined) {
      const payer = await checkPayer(tx, input.payerBankAccountId)
      if (!payer.ok) return payer
      data.payerBankAccountId = input.payerBankAccountId
      data.fileTemplateCode = payer.fileTemplateCode
      fields.push('payerBankAccountId')
    }
    const updated = await tx.paymentRun.update({ where: { id: found.run.id }, data: { ...data, version: { increment: 1 } }, select: { version: true } })
    // the flags depend on the pay date (BANK_ACCOUNT_RECENTLY_CHANGED): every item again
    const refreshed = await refreshRun(tx, ctx, found.run.id)
    if (!refreshed.ok) return refreshed
    return { ok: true, result: { paymentRunId: found.run.id, version: updated.version }, events: [{ type: 'payment_run.updated', aggregateType: 'PaymentRun', aggregateId: found.run.id, data: { fields } }] }
  },
})

export function updatePaymentRun(ctx: Ctx, input: z.input<typeof UpdateInput>, options: RunOptions) {
  return runCommand(ctx, updatePaymentRunCommand, input, options)
}

// ---------- the items: amounts, flags, SoD ----------

/** BR-SOD-10: the changes in force of the accounts the run pays into, against its pay date */
function recentChangesOf(payDate: string, recentBankChangeDays: number, facts: Iterable<SupplierFacts>): RecentBankChanges {
  const changes = [...facts].flatMap((f) => (f.account?.proposerMemberId ? [{ proposerMemberId: f.account.proposerMemberId, effectiveOn: f.account.activatedOn }] : []))
  return { payDate, recentBankChangeDays, changes }
}

/** BR-SOD-10 at adding and at sending: refused with security.sod_blocked, kept although the command rolls back */
function prepareSod(run: { id: string }, memberId: string, recent: RecentBankChanges, action: string): (Fail & { auditEvents: EventDraft[] }) | null {
  const sod = checkSod({ kind: 'PREPARE_PAYMENT', actorMemberId: memberId, recentBankChanges: recent }, { approverMayReceive: false, requesterMayReceive: true })
  if (sod.ok) return null
  return {
    ok: false,
    error: { code: 'SOD_VIOLATION', message: 'separation of duties', details: { rule: sod.rule } },
    auditEvents: [{ type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: run.id, data: { rule: sod.rule, action, subjectType: 'PAYMENT_RUN', subjectId: run.id, actorMemberId: memberId } }],
  }
}

/**
 * BR-PAY-04 to BR-PAY-06 for every item of the run, from its live documents: what it pays, the tax per group (its
 * PaymentRunItemWht rows written again), what is transferred, its flags; then the run's totals. An item that would
 * transfer nothing is refused (PAYMENT_ITEM_NOT_POSITIVE) and so the command that made it.
 */
async function refreshRun(tx: TenantTx, ctx: Ctx, paymentRunId: string): Promise<{ ok: true; items: Array<{ id: string; supplier: SupplierFacts; flags: PaymentFlag[]; requiresReason: boolean; flagReason: string | null; transferSatang: bigint }> } | Fail> {
  const run = await tx.paymentRun.findUniqueOrThrow({ where: { id: paymentRunId } })
  const { settings, payment } = await settingsOf(tx, ctx)
  const items = await tx.paymentRunItem.findMany({ where: { paymentRunId }, include: { supplier: { select: { code: true } } } })
  const links = await tx.paymentRunDocument.findMany({ where: { paymentRunId, status: 'HELD' }, include: { retention: { select: { id: true, invoiceId: true, amountSatang: true } } } })
  const invoiceLines = await invoiceWhtLines(tx, settings, links.filter((l) => l.invoiceId).map((l) => l.invoiceId!))
  const retentionLines = await retentionWhtLines(tx, settings, links.filter((l) => l.retention).map((l) => l.retention!))
  const facts = await supplierFacts(tx, items.map((i) => i.supplierId))
  const payDate = dayOf(run.payDate)
  const out = []
  let payable = 0n
  let wht = 0n
  let documents = 0
  for (const item of [...items].sort((a, b) => (a.supplier.code < b.supplier.code ? -1 : 1))) {
    const mine = links.filter((l) => l.paymentRunItemId === item.id)
    const docs: ItemDocument[] = mine.map((l) => ({
      kind: l.docKind,
      doc: l.invoiceId ?? l.retentionId!,
      payableSatang: l.payableSatang,
      whtLines: (l.invoiceId ? invoiceLines.get(l.invoiceId) : retentionLines.get(l.retentionId!)) ?? [],
    }))
    const built = buildItem(docs)
    if (!built.ok) {
      return built.code === 'PAYMENT_ITEM_NOT_POSITIVE'
        ? fail('PAYMENT_ITEM_NOT_POSITIVE', `what supplier ${item.supplier.code} is transferred must be more than nothing`, { supplier: item.supplier.code, transfer: formatSatang(built.transferSatang) })
        : fail('VALIDATION_FAILED', 'a tax base of the item is negative', { reason: built.reason, supplier: item.supplier.code })
    }
    const supplier = facts.get(item.supplierId)!
    const docIds = mine.map((l) => l.invoiceId ?? l.retentionId!)
    const flagged = await itemFlagsNow(tx, { payDate, recentBankChangeDays: payment.recentBankChangeDays, supplier, docIds })
    await tx.paymentRunItemWht.deleteMany({ where: { paymentRunItemId: item.id } })
    if (built.whtLines.length) await tx.paymentRunItemWht.createMany({ data: built.whtLines.map((l) => ({ organizationId: ctx.organizationId, paymentRunItemId: item.id, incomeType: l.incomeType, rateBp: l.rateBp, baseSatang: l.baseSatang, whtSatang: l.whtSatang })) })
    // BR-PAY-06: the preparer's reason answers the flags it was given for; a flag needing one that was not there then
    // asks for it again, so the approver never reads a reason written for another flag
    const before = new Set(item.flags)
    const newReasonFlag = flagged.flags.some((f) => REASON_FLAGS.includes(f) && !before.has(f))
    const flagReason = newReasonFlag ? null : item.flagReason
    await tx.paymentRunItem.update({ where: { id: item.id }, data: { payableSatang: built.payableSatang, whtSatang: built.whtSatang, transferSatang: built.transferSatang, flags: [...flagged.flags], flagReason } })
    payable += built.payableSatang
    wht += built.whtSatang
    documents += mine.length
    out.push({ id: item.id, supplier, flags: [...flagged.flags], requiresReason: flagged.requiresReason, flagReason, transferSatang: built.transferSatang })
  }
  await tx.paymentRun.update({ where: { id: paymentRunId }, data: { totalPayableSatang: payable, totalWhtSatang: wht, totalTransferSatang: payable - wht, itemCount: items.length, documentCount: documents } })
  return { ok: true, items: out }
}

// ---------- paymentRun.addDocuments ----------

const DocumentsInput = z.strictObject({
  paymentRunId: z.uuid(),
  version: z.number().int().min(0),
  invoiceIds: z.array(z.uuid()).max(500).default([]),
  retentionIds: z.array(z.uuid()).max(500).default([]),
})

export const addPaymentDocumentsCommand = defineCommand({
  name: 'paymentRun.addDocuments',
  capability: 'paymentRun.prepare',
  input: DocumentsInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentRunId: string; version: number; itemCount: number; totalTransferSatang: string }>> {
    const who = await preparer(tx, ctx)
    if (!who.ok) return who
    const found = await lockedRun(tx, ctx, input.paymentRunId, 'paymentRun.addDocuments', input.version)
    if (!found.ok) return found
    const { run } = found
    const notPreparer = preparedBy(run, who.memberId)
    if (notPreparer) return notPreparer
    if (input.invoiceIds.length + input.retentionIds.length === 0) return fail('VALIDATION_FAILED', 'name a document to add', { field: 'invoiceIds', reason: 'REQUIRED' })
    if (new Set(input.invoiceIds).size !== input.invoiceIds.length || new Set(input.retentionIds).size !== input.retentionIds.length) return fail('VALIDATION_FAILED', 'name each document once', { field: 'invoiceIds', reason: 'TWICE' })
    const events: EventDraft[] = []
    // BR-PAY-03, INV-PAY-01: S8 holds them, locking their rows in id order; a document not ready or held by another
    // run is DOCUMENT_NOT_PAYABLE
    const notPayable = async (kind: 'INVOICE' | 'RETENTION', id: string | undefined): Promise<Fail> => {
      const row = id ? (kind === 'INVOICE' ? await tx.invoice.findFirst({ where: { id }, select: { number: true } }) : await tx.retention.findFirst({ where: { id }, select: { invoice: { select: { number: true } } } })) : null
      const number = row ? ('number' in row ? row.number : row.invoice.number) : null
      return fail('DOCUMENT_NOT_PAYABLE', `${kind} ${number ?? id ?? ''} is not ready for payment or is in another payment run`, { kind, id: id ?? null, number: number ?? '' })
    }
    if (input.invoiceIds.length) {
      const held = await holdInvoicesForPayment(tx, ctx, { invoiceIds: input.invoiceIds, paymentRunId: run.id })
      if (!held.ok) return held.error.code === 'INVALID_STATE_TRANSITION' || held.error.code === 'NOT_FOUND' || held.error.details?.reason === 'NOT_AN_INVOICE' ? notPayable('INVOICE', held.error.details?.invoiceId as string | undefined) : held
      events.push(...held.events)
    }
    if (input.retentionIds.length) {
      const held = await holdRetentionsForPayment(tx, ctx, { retentionIds: input.retentionIds, paymentRunId: run.id })
      if (!held.ok) return held.error.code === 'INVALID_STATE_TRANSITION' || held.error.code === 'NOT_FOUND' ? notPayable('RETENTION', held.error.details?.retentionId as string | undefined) : held
      events.push(...held.events)
    }
    const invoices = input.invoiceIds.length ? await tx.invoice.findMany({ where: { id: { in: input.invoiceIds } }, select: { id: true, supplierId: true, payableSatang: true } }) : []
    const retentions = input.retentionIds.length ? await tx.retention.findMany({ where: { id: { in: input.retentionIds } }, select: { id: true, supplierId: true, amountSatang: true } }) : []
    const docs = [
      ...invoices.map((i) => ({ docKind: 'INVOICE' as const, invoiceId: i.id, retentionId: null, supplierId: i.supplierId, payableSatang: i.payableSatang })),
      ...retentions.map((r) => ({ docKind: 'RETENTION' as const, invoiceId: null, retentionId: r.id, supplierId: r.supplierId, payableSatang: r.amountSatang })),
    ]
    // BR-SOD-10: whoever changed an account the run would pay into may not prepare it
    const supplierIds = [...new Set([...docs.map((d) => d.supplierId), ...(await tx.paymentRunItem.findMany({ where: { paymentRunId: run.id }, select: { supplierId: true } })).map((i) => i.supplierId)])]
    const facts = await supplierFacts(tx, supplierIds)
    const { payment } = await settingsOf(tx, ctx)
    const blocked = prepareSod(run, who.memberId, recentChangesOf(dayOf(run.payDate), payment.recentBankChangeDays, facts.values()), 'paymentRun.addDocuments')
    if (blocked) return blocked
    // one item per supplier (BR-PAY-05), made when its first document comes in
    const items = new Map((await tx.paymentRunItem.findMany({ where: { paymentRunId: run.id }, select: { id: true, supplierId: true } })).map((i) => [i.supplierId, i.id]))
    for (const supplierId of new Set(docs.map((d) => d.supplierId))) {
      if (!items.has(supplierId)) items.set(supplierId, (await tx.paymentRunItem.create({ data: { organizationId: ctx.organizationId, paymentRunId: run.id, supplierId }, select: { id: true } })).id)
    }
    await tx.paymentRunDocument.createMany({
      data: docs.map((d) => ({ organizationId: ctx.organizationId, paymentRunId: run.id, paymentRunItemId: items.get(d.supplierId)!, docKind: d.docKind, invoiceId: d.invoiceId, retentionId: d.retentionId, payableSatang: d.payableSatang })),
    })
    const refreshed = await refreshRun(tx, ctx, run.id)
    if (!refreshed.ok) return refreshed
    const updated = await tx.paymentRun.update({ where: { id: run.id }, data: { version: { increment: 1 } }, select: { version: true, itemCount: true, totalTransferSatang: true } })
    events.unshift({ type: 'payment_run.documents_added', aggregateType: 'PaymentRun', aggregateId: run.id, data: { invoiceIds: input.invoiceIds, retentionIds: input.retentionIds, itemCount: updated.itemCount, totalTransferSatang: updated.totalTransferSatang.toString() } })
    return { ok: true, result: { paymentRunId: run.id, version: updated.version, itemCount: updated.itemCount, totalTransferSatang: updated.totalTransferSatang.toString() }, events }
  },
})

export function addPaymentDocuments(ctx: Ctx, input: z.input<typeof DocumentsInput>, options: RunOptions) {
  return runCommand(ctx, addPaymentDocumentsCommand, input, options)
}

// ---------- paymentRun.removeDocuments ----------

const RemoveInput = DocumentsInput.extend({ reason: z.string().trim().min(MIN_REASON_LENGTH).max(REASON_MAX_LENGTH).default('เอาออกจากร่างรอบจ่าย') })

export const removePaymentDocumentsCommand = defineCommand({
  name: 'paymentRun.removeDocuments',
  capability: 'paymentRun.prepare',
  input: RemoveInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentRunId: string; version: number; itemCount: number; totalTransferSatang: string }>> {
    const who = await preparer(tx, ctx)
    if (!who.ok) return who
    const found = await lockedRun(tx, ctx, input.paymentRunId, 'paymentRun.removeDocuments', input.version)
    if (!found.ok) return found
    const { run } = found
    const notPreparer = preparedBy(run, who.memberId)
    if (notPreparer) return notPreparer
    if (input.invoiceIds.length + input.retentionIds.length === 0) return fail('VALIDATION_FAILED', 'name a document to take out', { field: 'invoiceIds', reason: 'REQUIRED' })
    if (new Set(input.invoiceIds).size !== input.invoiceIds.length || new Set(input.retentionIds).size !== input.retentionIds.length) return fail('VALIDATION_FAILED', 'name each document once', { field: 'invoiceIds', reason: 'TWICE' })
    const links = await tx.paymentRunDocument.findMany({ where: { paymentRunId: run.id, status: 'HELD', OR: [{ invoiceId: { in: input.invoiceIds } }, { retentionId: { in: input.retentionIds } }] }, select: { id: true, paymentRunItemId: true, invoiceId: true, retentionId: true } })
    if (links.length === 0 || links.length !== input.invoiceIds.length + input.retentionIds.length) return fail('NOT_FOUND', 'a document named is not in this run', { field: 'invoiceIds' })
    const events: EventDraft[] = []
    // S8 makes them ready for payment again; a draft never had a file, so the link goes with them
    if (input.invoiceIds.length) {
      const released = await releaseInvoicesFromPayment(tx, ctx, { invoiceIds: input.invoiceIds, reason: input.reason })
      if (!released.ok) return released
      events.push(...released.events)
    }
    if (input.retentionIds.length) {
      const released = await releaseRetentionsFromPayment(tx, ctx, { retentionIds: input.retentionIds, reason: input.reason })
      if (!released.ok) return released
      events.push(...released.events)
    }
    await tx.paymentRunDocument.deleteMany({ where: { id: { in: links.map((l) => l.id) } } })
    // an item left without documents leaves the run
    for (const itemId of new Set(links.map((l) => l.paymentRunItemId))) {
      if ((await tx.paymentRunDocument.count({ where: { paymentRunItemId: itemId } })) === 0) {
        await tx.paymentRunItemWht.deleteMany({ where: { paymentRunItemId: itemId } })
        await tx.paymentRunItem.delete({ where: { id: itemId } })
      }
    }
    const refreshed = await refreshRun(tx, ctx, run.id)
    if (!refreshed.ok) return refreshed
    const updated = await tx.paymentRun.update({ where: { id: run.id }, data: { version: { increment: 1 } }, select: { version: true, itemCount: true, totalTransferSatang: true } })
    events.unshift({ type: 'payment_run.documents_removed', aggregateType: 'PaymentRun', aggregateId: run.id, data: { invoiceIds: input.invoiceIds, retentionIds: input.retentionIds, itemCount: updated.itemCount, totalTransferSatang: updated.totalTransferSatang.toString() } })
    return { ok: true, result: { paymentRunId: run.id, version: updated.version, itemCount: updated.itemCount, totalTransferSatang: updated.totalTransferSatang.toString() }, events }
  },
})

export function removePaymentDocuments(ctx: Ctx, input: z.input<typeof RemoveInput>, options: RunOptions) {
  return runCommand(ctx, removePaymentDocumentsCommand, input, options)
}

// ---------- paymentRun.setFlagReason ----------

const FlagReasonInput = z.strictObject({ paymentRunId: z.uuid(), version: z.number().int().min(0), supplierId: z.uuid(), reason: z.string().trim().min(MIN_REASON_LENGTH).max(REASON_MAX_LENGTH) })

export const setFlagReasonCommand = defineCommand({
  name: 'paymentRun.setFlagReason',
  capability: 'paymentRun.prepare',
  input: FlagReasonInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentRunId: string; version: number }>> {
    const who = await preparer(tx, ctx)
    if (!who.ok) return who
    const found = await lockedRun(tx, ctx, input.paymentRunId, 'paymentRun.setFlagReason', input.version)
    if (!found.ok) return found
    const notPreparer = preparedBy(found.run, who.memberId)
    if (notPreparer) return notPreparer
    // the reason answers the item's flags as they are now: worked out again before it is written
    const refreshed = await refreshRun(tx, ctx, found.run.id)
    if (!refreshed.ok) return refreshed
    const item = await tx.paymentRunItem.findFirst({ where: { paymentRunId: found.run.id, supplierId: input.supplierId }, select: { id: true, flags: true } })
    if (!item) return fail('NOT_FOUND', 'the supplier has no item in this run', { field: 'supplierId' })
    await tx.paymentRunItem.update({ where: { id: item.id }, data: { flagReason: input.reason } })
    const updated = await tx.paymentRun.update({ where: { id: found.run.id }, data: { version: { increment: 1 } }, select: { version: true } })
    return { ok: true, result: { paymentRunId: found.run.id, version: updated.version }, events: [{ type: 'payment_run_item.flag_reason_set', aggregateType: 'PaymentRunItem', aggregateId: item.id, data: { paymentRunId: found.run.id, supplierId: input.supplierId, flags: item.flags } }] }
  },
})

export function setPaymentFlagReason(ctx: Ctx, input: z.input<typeof FlagReasonInput>, options: RunOptions) {
  return runCommand(ctx, setFlagReasonCommand, input, options)
}

// ---------- paymentRun.submit ----------

const SubmitInput = z.strictObject({ paymentRunId: z.uuid(), version: z.number().int().min(0) })

export const submitPaymentRunCommand = defineCommand({
  name: 'paymentRun.submit',
  capability: 'paymentRun.prepare',
  input: SubmitInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentRunId: string; number: string; routeId: string; flagsKey: string }>> {
    const who = await preparer(tx, ctx)
    if (!who.ok) return who
    const found = await lockedRun(tx, ctx, input.paymentRunId, 'paymentRun.submit', input.version)
    if (!found.ok) return found
    const { run, to } = found
    const notPreparer = preparedBy(run, who.memberId)
    if (notPreparer) return notPreparer
    const payDate = dayOf(run.payDate)
    const refusedDate = await checkDate(tx, ctx, payDate)
    if (refusedDate) return refusedDate
    const payer = await checkPayer(tx, run.payerBankAccountId)
    if (!payer.ok) return payer
    const refreshed = await refreshRun(tx, ctx, run.id)
    if (!refreshed.ok) return refreshed
    if (refreshed.items.length === 0) return fail('VALIDATION_FAILED', 'a run pays one supplier at least', { field: 'invoiceIds', reason: 'EMPTY' })
    // BR-PAY-05: every supplier is paid into an approved account in force
    const noAccount = refreshed.items.find((i) => !i.supplier.account)
    if (noAccount) return fail('BANK_ACCOUNT_NOT_APPROVED', `supplier ${noAccount.supplier.code} has no approved bank account`, { supplier: noAccount.supplier.code })
    // BR-PAY-06: the first four flags need the preparer's reason
    const unexplained = refreshed.items.find((i) => i.requiresReason && !i.flagReason)
    if (unexplained) {
      const flag = unexplained.flags.find((f) => REASON_FLAGS.includes(f))!
      return fail('PAYMENT_FLAG_REASON_REQUIRED', `the item of ${unexplained.supplier.code} has flag ${flag}: give a reason first`, { supplier: unexplained.supplier.code, flag })
    }
    const { payment } = await settingsOf(tx, ctx)
    const recent = recentChangesOf(payDate, payment.recentBankChangeDays, refreshed.items.map((i) => i.supplier))
    const blocked = prepareSod(run, who.memberId, recent, 'paymentRun.submit')
    if (blocked) return blocked
    // BR-PAY-05, ADR-133: the sequence by supplier code and the payee as the register says now
    const ordered = [...refreshed.items].sort((a, b) => (a.supplier.code < b.supplier.code ? -1 : 1))
    // a resubmitted run is numbered again from 1 (seq is unique per run)
    await tx.paymentRunItem.updateMany({ where: { paymentRunId: run.id }, data: { seq: null } })
    for (const [i, item] of ordered.entries()) {
      const account = item.supplier.account!
      await tx.paymentRunItem.update({ where: { id: item.id }, data: { seq: i + 1, bankAccountId: account.id, payeeBankCode: account.bankCode, payeeAccountNo: account.accountNo, payeeAccountName: account.accountName } })
    }
    const key = flagsKey(ordered.map((i) => ({ code: i.supplier.code, flags: i.flags })))
    // BR-PAY-08: DOA PAYMENT_RUN with what is transferred; the preparer, the recorders of its invoices (a retention
    // counts its invoice's) and the proposers of a recent change of its accounts are kept off the route (BR-DOA-06)
    const totals = await tx.paymentRun.findUniqueOrThrow({ where: { id: run.id }, select: { totalTransferSatang: true } })
    const recorders = await invoiceRecordersOf(tx, run.id)
    const department = await rootDepartmentId(tx)
    if (!department) return fail('VALIDATION_FAILED', 'the organization has no departments', { reason: 'NO_DEPARTMENT' })
    const number = run.number ?? (await issueDocumentNumber(tx, ctx, { document: 'PAY' }))
    const route = await startRoute(
      tx,
      ctx,
      { type: 'PAYMENT_RUN', id: run.id, label: `${number} รอบจ่าย` },
      {
        documentType: 'PAYMENT_RUN',
        amount: { netSatang: totals.totalTransferSatang, vatSatang: 0n },
        requesterMemberId: run.preparedById,
        chargedDepartmentId: department,
        conflictMemberIds: [...new Set([run.preparedById, ...recorders, ...recentBankChangeProposers(recent)])],
        at: ctx.now,
      },
    )
    if (!route.ok) return { ok: false, error: route.error }
    await tx.paymentRun.update({ where: { id: run.id }, data: { number, status: to, flagsKey: key, fileTemplateCode: payer.fileTemplateCode, submittedAt: ctx.now, currentRouteId: route.data.routeId, version: { increment: 1 } } })
    const resubmitted = run.number !== null
    return {
      ok: true,
      result: { paymentRunId: run.id, number, routeId: route.data.routeId, flagsKey: key },
      events: [
        {
          type: resubmitted ? 'payment_run.resubmitted' : 'payment_run.submitted',
          aggregateType: 'PaymentRun',
          aggregateId: run.id,
          data: { number, routeId: route.data.routeId, payDate, itemCount: ordered.length, totalTransferSatang: totals.totalTransferSatang.toString(), flaggedItems: ordered.filter((i) => i.flags.length > 0).length },
        },
        ...route.data.events,
      ],
      notifications: route.data.notifications,
    }
  },
})

export function submitPaymentRun(ctx: Ctx, input: z.input<typeof SubmitInput>, options: RunOptions) {
  return runCommand(ctx, submitPaymentRunCommand, input, options)
}

/** BR-SOD-04: who recorded the invoices of the run's live documents (a retention counts its invoice's recorder) */
export async function invoiceRecordersOf(tx: TenantTx, paymentRunId: string): Promise<string[]> {
  const links = await tx.paymentRunDocument.findMany({
    where: { paymentRunId, status: { in: ['HELD', 'PAID'] } },
    select: { invoice: { select: { recordedById: true, createdById: true } }, retention: { select: { invoice: { select: { recordedById: true, createdById: true } } } } },
  })
  return [...new Set(links.map((l) => l.invoice ?? l.retention?.invoice).map((i) => i?.recordedById ?? i?.createdById).filter((m): m is string => !!m))]
}

// ---------- paymentRun.cancel (a draft or a run waiting for approval: its preparer) ----------

const CancelInput = z.strictObject({ paymentRunId: z.uuid(), version: z.number().int().min(0), reason: z.string().trim().min(MIN_REASON_LENGTH).max(REASON_MAX_LENGTH) })

export const cancelPaymentRunCommand = defineCommand({
  name: 'paymentRun.cancel',
  capability: 'paymentRun.prepare',
  input: CancelInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ paymentRunId: string }>> {
    const who = await preparer(tx, ctx)
    if (!who.ok) return who
    const found = await lockedRun(tx, ctx, input.paymentRunId, 'paymentRun.cancel', input.version)
    if (!found.ok) return found
    const { run, to } = found
    // BR-PAY-10: after approval a run is cancelled by FINANCE with the file's rules (S9-07)
    if (run.status !== 'DRAFT' && run.status !== 'PENDING_APPROVAL') return fail('INVALID_STATE_TRANSITION', 'an approved run is cancelled with its file’s rules', { from: run.status, command: 'paymentRun.cancel' })
    const notPreparer = preparedBy(run, who.memberId)
    if (notPreparer) return notPreparer
    const events: EventDraft[] = []
    if (run.status === 'PENDING_APPROVAL') events.push(...(await closeRoute(tx, { type: 'PAYMENT_RUN', id: run.id }, 'CANCELLED', 'REQUEST_CANCELLED')))
    const released = await releaseAll(tx, ctx, run.id, input.reason, false)
    if (!released.ok) return released
    events.push(...released.events)
    await tx.paymentRun.update({ where: { id: run.id }, data: { status: to, cancelledAt: ctx.now, cancelReason: input.reason, currentRouteId: null, version: { increment: 1 } } })
    return {
      ok: true,
      result: { paymentRunId: run.id },
      // the reason stays on the run (cancelReason): free text never goes into Event.data
      events: [{ type: 'payment_run.cancelled', aggregateType: 'PaymentRun', aggregateId: run.id, data: { from: run.status, afterExport: false, documentCount: released.count } }, ...events],
    }
  },
})

export function cancelPaymentRun(ctx: Ctx, input: z.input<typeof CancelInput>, options: RunOptions) {
  return runCommand(ctx, cancelPaymentRunCommand, input, options)
}

/**
 * Lets every document of the run go (cancelled, or rejected at approval): the links RELEASED with the reason, and S8
 * makes the invoices ready for payment and the retentions releasable again. afterExport marks them for the flag
 * PREVIOUSLY_EXPORTED of a later run (BR-PAY-06, OQ-136).
 */
export async function releaseAll(tx: TenantTx, ctx: Ctx, paymentRunId: string, reason: string, afterExport: boolean): Promise<{ ok: true; events: EventDraft[]; count: number } | Fail> {
  const links = await tx.paymentRunDocument.findMany({ where: { paymentRunId, status: 'HELD' }, select: { id: true, invoiceId: true, retentionId: true } })
  const events: EventDraft[] = []
  const invoiceIds = links.flatMap((l) => (l.invoiceId ? [l.invoiceId] : []))
  const retentionIds = links.flatMap((l) => (l.retentionId ? [l.retentionId] : []))
  if (invoiceIds.length) {
    const released = await releaseInvoicesFromPayment(tx, ctx, { invoiceIds, reason })
    if (!released.ok) return released
    events.push(...released.events)
  }
  if (retentionIds.length) {
    const released = await releaseRetentionsFromPayment(tx, ctx, { retentionIds, reason })
    if (!released.ok) return released
    events.push(...released.events)
  }
  if (links.length) await tx.paymentRunDocument.updateMany({ where: { id: { in: links.map((l) => l.id) } }, data: { status: 'RELEASED', releaseReason: reason, releasedAfterExport: afterExport } })
  return { ok: true, events, count: links.length }
}

/** Open payment runs and bank account changes, for switching PAY off (OQ-33): their numbers, or ids for drafts */
export async function openPaymentDocuments(tx: TenantTx): Promise<string[]> {
  const runs = await tx.paymentRun.findMany({ where: { status: { notIn: ['COMPLETED', 'REJECTED', 'CANCELLED'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20, select: { id: true, number: true } })
  const changes = await tx.bankAccountChange.findMany({ where: { status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20, select: { id: true, number: true } })
  return [...runs.map((r) => r.number ?? r.id), ...changes.map((c) => c.number ?? c.id)]
}
