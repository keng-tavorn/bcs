import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { fund, reserve } from '@/core/budget'
import { applyBudget } from '@/server/budget/ledger'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { enqueueSupplierNotice, sendSupplierNotice, SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-notices'
import { renderNotification } from '@/server/notifications/templates'
import { decideTask } from '@/server/services/approvals/decide'
import { dismissMatchException, recheckInvoice, recheckPoInvoices, rejectInvoice, reopenInvoice, requestVarianceApproval } from '@/server/services/ap/exceptions'
import { messagesTo } from '../support/mailpit'
import { stepUpForTask } from '../support/pin'
import { AP_NOW, apOrg, codedDraft, fin, key, ok, receive, sentPo, submit, type ApOrg } from '../support/ap'

// S8-06 (FR-AP-103, FR-AP-105, BR-MATCH-09, BR-MATCH-10, BR-AP-05 to BR-AP-09, ADR-126): what happens to an invoice the
// match did not pass — checked again (by hand and after a goods receipt), reopened, rejected with the supplier told, a
// possible duplicate dismissed, and a price variance approved under DOA INVOICE_EXCEPTION with the budget held at the
// last approval (or refused BUDGET_INSUFFICIENT with the task still open). E-mails to the supplier go through
// SupplierNotice to Mailpit, each once.

let ap: ApOrg
beforeAll(async () => {
  ap = await apOrg()
})

const proc = () => ap.org.ctxOf('proc_officer', AP_NOW)
const versionOf = async (invoiceId: string) => (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).version
const statusOf = async (invoiceId: string) => (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status
const openTaskOf = (invoiceId: string) => prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectType: 'INVOICE', subjectId: invoiceId } } } })
const codeOf = (memberId: string) => Object.entries(ap.org.member).find(([, id]) => id === memberId)![0]

/**
 * The date of the next invoice of the file: each 4 days before the one before, so invoices of the same total of the same
 * supplier are never possible duplicates of each other (BR-MATCH-12) unless a test makes one on purpose
 */
let invoiceCount = 0
const nextDate = () => new Date(Date.UTC(2026, 9, 10 - 4 * ++invoiceCount)).toISOString().slice(0, 10)

/** A PO received in full and an invoice priced over beyond the tolerance (PRICE_OVER 100.00 on 1,000.00) */
async function priceOverInvoice(options: { fund?: bigint } = {}) {
  const date = nextDate()
  const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }], options.fund ? { fund: options.fund } : {})
  await receive(ap, po, { 0: '1' })
  const draft = await codedDraft(ap, po, { no: `PO-${randomUUID().slice(0, 6)}`, date, vat: '77.00', lines: [{ line: 0, quantity: '1', unitPrice: '1100.00' }] })
  expect(ok(await submit(ap, draft))).toMatchObject({ status: 'EXCEPTION', exceptions: [{ type: 'PRICE_OVER', amount: '100.00' }] })
  return { po, invoiceId: draft.invoiceId }
}

describe('[FR-AP-105/AC2] [FR-AP-105/AC3] a price variance approved under DOA INVOICE_EXCEPTION', () => {
  it('routes by the variance with its VAT to the DM of the budget line’s department, and the last approval holds the variance and makes the invoice ready (GC-MATCH-26)', async () => {
    const { po, invoiceId } = await priceOverInvoice()
    const r = ok(await requestVarianceApproval(proc(), { invoiceId, version: await versionOf(invoiceId), reason: 'ราคาน้ำมันขึ้น' }, key()))
    expect(r.status).toBe('PENDING_APPROVAL')
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectType: 'INVOICE', subjectId: invoiceId } })
    expect(route).toMatchObject({ ruleCode: 'IE-01' })
    expect(await prisma.matchException.findMany({ where: { invoiceId, type: 'PRICE_OVER', status: 'ACCEPT_REQUESTED' } })).toHaveLength(1)
    const task = (await openTaskOf(invoiceId))!
    expect(task.assigneeMemberId).toBe(ap.org.member.dm_con)
    const held = async () => (await prisma.budgetAllocation.findFirstOrThrow({ where: { sourceType: 'PO_LINE', sourceId: po.lines[0]!.id } }))
    await stepUpForTask(task.id, task.assigneeMemberId)
    ok(await decideTask(ap.org.ctxOf('dm_con', AP_NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({ status: 'READY_FOR_PAYMENT', payableSatang: 117_700n })
    expect(await held()).toMatchObject({ committedSatang: 0n, actualSatang: 110_000n })
    expect(await prisma.matchException.count({ where: { invoiceId, status: 'APPROVED' } })).toBe(1)
    const events = (await prisma.event.findMany({ where: { aggregateId: invoiceId }, select: { type: true } })).map((e) => e.type)
    expect(events).toEqual(expect.arrayContaining(['invoice.variance_submitted', 'invoice.variance_approved', 'invoice.ready']))
    // the asker and the recorder hear the decision
    expect(await prisma.notification.count({ where: { templateKey: 'invoice.variance_decided', subjectId: invoiceId } })).toBe(2)
  })

  it('[FR-AP-105/AC3] a budget line short by 0.01 refuses the approval BUDGET_INSUFFICIENT: everything rolls back and the task stays open (GC-MATCH-27)', async () => {
    const { po, invoiceId } = await priceOverInvoice()
    ok(await requestVarianceApproval(proc(), { invoiceId, version: await versionOf(invoiceId), reason: 'ขึ้นราคา' }, key()))
    // leave 99.99 available on the budget line: 0.01 short of the 100.00 the variance needs
    const balance = await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId: po.budgetLineId } })
    const ctx = systemCtx(ap.org.organizationId, AP_NOW, 'test')
    await forTenant(ap.org.organizationId).$transaction(async (tx) => {
      const r = await applyBudget(tx, ctx, [{ budgetLineId: po.budgetLineId, document: { type: 'REQUEST', id: randomUUID() }, run: (s) => reserve(s, [{ requestLineId: randomUUID(), amount: balance.availableSatang - 9_999n }]) }])
      if (!r.ok) throw new Error('reserve failed')
      await appendEvents(tx, ctx, r.events)
    })
    const task = (await openTaskOf(invoiceId))!
    await stepUpForTask(task.id, task.assigneeMemberId)
    const r = await decideTask(ap.org.ctxOf(codeOf(task.assigneeMemberId), AP_NOW), { taskId: task.id, decision: 'APPROVE' }, key())
    expect(r).toMatchObject({ ok: false, error: { code: 'BUDGET_INSUFFICIENT', details: { shortfall: '0.01' } } })
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('OPEN')
    expect(await statusOf(invoiceId)).toBe('PENDING_APPROVAL')
    void fund
  })

  it('[FR-AP-105/AC4] a rejection sends the invoice back to EXCEPTION with its price difference open again', async () => {
    const { invoiceId } = await priceOverInvoice()
    ok(await requestVarianceApproval(proc(), { invoiceId, version: await versionOf(invoiceId), reason: 'ขึ้นราคา' }, key()))
    const task = (await openTaskOf(invoiceId))!
    await stepUpForTask(task.id, task.assigneeMemberId)
    ok(await decideTask(ap.org.ctxOf(codeOf(task.assigneeMemberId), AP_NOW), { taskId: task.id, decision: 'REJECT', reason: 'ราคาไม่ตรงสัญญา' }, key()))
    expect(await statusOf(invoiceId)).toBe('EXCEPTION')
    expect(await prisma.matchException.count({ where: { invoiceId, type: 'PRICE_OVER', status: 'OPEN' } })).toBe(1)
    expect(await prisma.event.count({ where: { aggregateId: invoiceId, type: 'invoice.variance_rejected' } })).toBe(1)
  })

  it('[FR-AP-105/AC5] the recorder of the invoice or the asker cannot approve it (BR-AP-05): SOD_VIOLATION', async () => {
    const { invoiceId } = await priceOverInvoice()
    ok(await requestVarianceApproval(proc(), { invoiceId, version: await versionOf(invoiceId), reason: 'ขึ้นราคา' }, key()))
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectType: 'INVOICE', subjectId: invoiceId } })
    const task = (await openTaskOf(invoiceId))!
    // hand the task to the recorder as if the DOA named them: the decision is refused by SoD
    await prisma.approvalTask.update({ where: { id: task.id }, data: { assigneeMemberId: ap.org.member.fin_officer! } })
    await stepUpForTask(task.id, ap.org.member.fin_officer!)
    expect(await decideTask(fin(ap), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION' } })
    expect(route.id).toBeTruthy()
  })

  it('[FR-AP-103/AC2] a difference of another kind is VARIANCE_NOT_ACCEPTABLE; FINANCE may not ask', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '100.00' }])
    await receive(ap, po, { 0: '5' })
    const draft = await codedDraft(ap, po, { no: `Q-${randomUUID().slice(0, 6)}`, date: nextDate(), vat: '70.00', lines: [{ line: 0, quantity: '10', unitPrice: '100.00' }] })
    ok(await submit(ap, draft))
    expect(await requestVarianceApproval(proc(), { invoiceId: draft.invoiceId, version: await versionOf(draft.invoiceId), reason: 'x' }, key())).toMatchObject({ ok: false, error: { code: 'VARIANCE_NOT_ACCEPTABLE', details: { type: 'QTY_NOT_RECEIVED' } } })
    expect(await requestVarianceApproval(fin(ap), { invoiceId: draft.invoiceId, version: await versionOf(draft.invoiceId), reason: 'x' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('[FR-AP-105/AC6] [INV-AP-01] another invoice took the received quantity first: asking matches again and refuses VARIANCE_NOT_ACCEPTABLE', async () => {
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '1' })
    const a = await codedDraft(ap, po, { no: `A-${randomUUID().slice(0, 6)}`, date: nextDate(), vat: '77.00', lines: [{ line: 0, quantity: '1', unitPrice: '1100.00' }] })
    ok(await submit(ap, a))
    ok(await submit(ap, await codedDraft(ap, po, { no: `B-${randomUUID().slice(0, 6)}`, date: nextDate(), vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })))
    expect(await requestVarianceApproval(proc(), { invoiceId: a.invoiceId, version: await versionOf(a.invoiceId), reason: 'x' }, key())).toMatchObject({ ok: false, error: { code: 'VARIANCE_NOT_ACCEPTABLE', details: { type: 'QTY_NOT_RECEIVED' } } })
    expect(await prisma.approvalRoute.count({ where: { subjectType: 'INVOICE', subjectId: a.invoiceId } })).toBe(0)
  })
})

describe('[FR-AP-103/AC2] the other ways out of EXCEPTION', () => {
  it('[FR-AP-103/AC4] a goods receipt posted later matches the invoice again by SYSTEM (job invoice-auto-recheck)', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '100.00' }])
    await receive(ap, po, { 0: '6' })
    const draft = await codedDraft(ap, po, { no: `R-${randomUUID().slice(0, 6)}`, date: nextDate(), vat: '70.00', lines: [{ line: 0, quantity: '10', unitPrice: '100.00' }] })
    expect(ok(await submit(ap, draft)).status).toBe('EXCEPTION')
    const gr = await receive(ap, po, { 0: '4' })
    const [r] = await recheckPoInvoices(ap.org.organizationId, po.id, `gr:${gr.grId}`, AP_NOW)
    expect(r).toMatchObject({ ok: true, data: { status: 'READY_FOR_PAYMENT' } })
    // the same cause again is the same command: nothing runs twice
    await recheckPoInvoices(ap.org.organizationId, po.id, `gr:${gr.grId}`, AP_NOW)
    expect(await prisma.invoiceMatch.count({ where: { invoiceId: draft.invoiceId, triggeredBy: 'SYSTEM' } })).toBe(1)
    expect(await prisma.matchException.count({ where: { invoiceId: draft.invoiceId, status: 'RESOLVED' } })).toBe(1)
  })

  it('the receiver the difference is sent to may check again; PROCUREMENT may not for a quantity difference', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '100.00' }])
    await receive(ap, po, { 0: '6' })
    const draft = await codedDraft(ap, po, { no: `RR-${randomUUID().slice(0, 6)}`, date: nextDate(), vat: '70.00', lines: [{ line: 0, quantity: '10', unitPrice: '100.00' }] })
    ok(await submit(ap, draft))
    expect(await recheckInvoice(proc(), { invoiceId: draft.invoiceId, version: await versionOf(draft.invoiceId) }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(ok(await recheckInvoice(ap.org.ctxOf('receiver_con', AP_NOW), { invoiceId: draft.invoiceId, version: await versionOf(draft.invoiceId) }, key())).status).toBe('EXCEPTION')
  })

  it('reopened, the invoice is a draft again with its differences closed and its number kept', async () => {
    const { invoiceId } = await priceOverInvoice()
    const number = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).number
    ok(await reopenInvoice(fin(ap), { invoiceId, version: await versionOf(invoiceId) }, key()))
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({ status: 'DRAFT', number })
    expect(await prisma.matchException.count({ where: { invoiceId, status: 'CLOSED' } })).toBe(1)
  })

  it('[FR-AP-103/AC3] rejected with a reason: the supplier is e-mailed once, however often the command is sent', async () => {
    const address = `ap-${randomUUID()}@test.bcs.local`
    await prisma.supplier.update({ where: { id: ap.supplierId }, data: { email: address } })
    const { invoiceId } = await priceOverInvoice()
    const version = await versionOf(invoiceId)
    const sameKey = key()
    ok(await rejectInvoice(proc(), { invoiceId, version, reason: 'ราคาไม่ตรงใบสั่งซื้อ' }, sameKey))
    ok(await rejectInvoice(proc(), { invoiceId, version, reason: 'ราคาไม่ตรงใบสั่งซื้อ' }, sameKey))
    expect(await statusOf(invoiceId)).toBe('REJECTED')
    const notices = await prisma.supplierNotice.findMany({ where: { subjectId: invoiceId }, orderBy: { createdAt: 'asc' } })
    expect(notices.map((n) => n.templateKey).sort()).toEqual([SUPPLIER_TEMPLATES.invoiceReceived, SUPPLIER_TEMPLATES.invoiceRejected].sort())
    for (const n of notices) await sendSupplierNotice(ap.org.organizationId, n.id, AP_NOW)
    for (const n of notices) await sendSupplierNotice(ap.org.organizationId, n.id, AP_NOW)
    const mail = await messagesTo(address)
    expect(mail.filter((m) => m.Subject.includes('ไม่ได้รับการยอมรับ'))).toHaveLength(1)
    expect(mail.find((m) => m.Subject.includes('ไม่ได้รับการยอมรับ'))!.Text).toContain('ราคาไม่ตรงใบสั่งซื้อ')
    const sent = await prisma.event.findFirstOrThrow({ where: { type: 'supplier_notice.sent', data: { path: ['subjectId'], equals: invoiceId }, AND: { data: { path: ['templateKey'], equals: SUPPLIER_TEMPLATES.invoiceRejected } } } })
    expect(sent.data).toMatchObject({ templateKey: SUPPLIER_TEMPLATES.invoiceRejected, subjectType: 'Invoice', subjectId: invoiceId })
  })

  it('[FR-AP-103/AC3] enqueueSupplierNotice with a dedupeKey used before makes no second row; a supplier without e-mail is NO_EMAIL and FINANCE is told in the app', async () => {
    const ctx = systemCtx(ap.org.organizationId, AP_NOW, 'test')
    const subjectId = randomUUID()
    const input = { templateKey: SUPPLIER_TEMPLATES.invoiceReady, supplierId: ap.supplierId, subjectType: 'Invoice', subjectId, dedupeKey: `test:${subjectId}`, data: {} }
    await forTenant(ap.org.organizationId).$transaction((tx) => enqueueSupplierNotice(tx, ctx, input))
    const again = await forTenant(ap.org.organizationId).$transaction((tx) => enqueueSupplierNotice(tx, ctx, input))
    expect(again).toEqual({ outbox: [], events: [], notifications: [], noticeId: null })
    expect(await prisma.supplierNotice.count({ where: { subjectId } })).toBe(1)
    const silent = await prisma.supplier.create({ data: { organizationId: ap.org.organizationId, code: `NE-${randomUUID().slice(0, 6)}`, nameTh: 'ไม่มีอีเมล', isForeign: true } })
    const none = await forTenant(ap.org.organizationId).$transaction((tx) => enqueueSupplierNotice(tx, ctx, { ...input, supplierId: silent.id, dedupeKey: `test2:${subjectId}` }))
    expect(none.outbox).toEqual([])
    expect(none.events).toMatchObject([{ type: 'supplier_notice.failed', data: { templateKey: SUPPLIER_TEMPLATES.invoiceReady, subjectType: 'Invoice', subjectId, reason: 'NO_EMAIL' } }])
    expect(none.notifications.length).toBeGreaterThan(0)
    expect(none.notifications.every((n) => n.templateKey === 'supplier.no_email')).toBe(true)
    expect((await prisma.supplierNotice.findFirstOrThrow({ where: { dedupeKey: `test2:${subjectId}` } })).status).toBe('NO_EMAIL')
  })

  it('a possible duplicate dismissed with a reason is not raised again and the invoice becomes ready', async () => {
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '2' })
    const date = nextDate()
    ok(await submit(ap, await codedDraft(ap, po, { no: `D1-${randomUUID().slice(0, 6)}`, date, vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })))
    const second = await codedDraft(ap, po, { no: `D2-${randomUUID().slice(0, 6)}`, date, vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
    expect(ok(await submit(ap, second)).status).toBe('EXCEPTION')
    const ex = await prisma.matchException.findFirstOrThrow({ where: { invoiceId: second.invoiceId, type: 'POSSIBLE_DUPLICATE' } })
    expect(ok(await dismissMatchException(fin(ap), { exceptionId: ex.id, reason: 'คนละงวดของงานเดียวกัน' }, key())).status).toBe('READY_FOR_PAYMENT')
    expect(await prisma.event.count({ where: { aggregateId: second.invoiceId, type: 'match_exception.dismissed' } })).toBe(1)
  })
})

describe('[FR-AP-103/AC1] differences reach the role they are sent to, by LINE without lines or unit prices (BR-AP-09)', () => {
  it('a PRICE_OVER goes to PROCUREMENT; the text carries the numbers and the kind only', async () => {
    const { invoiceId } = await priceOverInvoice()
    const notices = await prisma.notification.findMany({ where: { templateKey: 'invoice.exception', subjectId: invoiceId } })
    expect(notices.map((n) => n.recipientMemberId)).toContain(ap.org.member.proc_officer)
    expect(notices.map((n) => n.recipientMemberId)).not.toContain(ap.org.member.receiver_con)
    const data = notices[0]!.data as Record<string, unknown>
    expect(Object.keys(data).sort()).toEqual(['invoiceId', 'number', 'poNumber', 'totalSatang', 'types'])
    const rendered = renderNotification({ templateKey: 'invoice.exception', data, subjectType: 'INVOICE', subjectId: invoiceId }, 'th')
    expect(`${rendered.title} ${rendered.body ?? ''}`).not.toMatch(/1,100\.00|1100/)
  })
})
