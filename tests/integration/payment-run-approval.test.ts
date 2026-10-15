import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { jsonByteLength, LINE_FLEX_BUBBLE_MAX_BYTES, lineMessageProblems } from '@/integrations/line/limits'
import type { Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { approvalCardMessage } from '@/server/line/postback-cards'
import { getPaymentRunTaskView } from '@/server/queries/payment-runs'
import { renderNotification } from '@/server/notifications/templates'
import { decideTask } from '@/server/services/approvals/decide'
import { outsideChannels } from '@/server/services/approvals/subjects'
import { addPaymentDocuments, createPaymentRun, setPaymentFlagReason, submitPaymentRun } from '@/server/services/payments/runs'
import { AP_NOW, fin, key, ok } from '../support/ap'
import { paySupplier, payOrg, readyInvoice, runVersion, sentRun, type PayOrg } from '../support/pay'
import { stepUpForTask } from '../support/pin'

// S9-06 (FR-PAY-101 AC5 AC8 AC9, BR-PAY-07, BR-SOD-04 BR-SOD-09 BR-SOD-10, BR-TOK-05, BR-NOTI-01): a payment run is
// decided through the shared approvals by DOA PAYMENT_RUN (PAY-01 → the CFO up to 5,000,000.00; stepUpThreshold
// 100,000.00 in the phase-1 fixtures). The approver approves the flags the page showed: a key that is no longer the
// flags now is PAYMENT_FLAGS_CHANGED and the task stays open; a flag needing the preparer's reason that arose after
// sending is the preparer's to explain (returned). Rejected, the documents are ready for payment again; returned, they
// stay held. The preparer, the recorders of its invoices and a recent proposer of its accounts may not approve it. The
// LINE card names the run's number and the total only; a run with flags has no button in the chat.

let ap: PayOrg
const DUE = '2026-10-15'
const ctxOf = (code: string, channel: Ctx['channel'] = 'WEB') => ap.org.ctxOf(code, AP_NOW, channel)
const codeOf = (memberId: string) => Object.entries(ap.org.member).find(([, id]) => id === memberId)![0]
const openTaskOf = (runId: string) => prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectType: 'PAYMENT_RUN', subjectId: runId } } } })
const runOf = (runId: string) => prisma.paymentRun.findUniqueOrThrow({ where: { id: runId } })

async function decide(runId: string, decision: 'APPROVE' | 'RETURN' | 'REJECT', options: { flagsKey?: string; reason?: string; channel?: Ctx['channel'] } = {}) {
  const task = (await openTaskOf(runId))!
  await stepUpForTask(task.id, task.assigneeMemberId, options.channel === 'LIFF' ? 'LIFF' : undefined)
  return decideTask(
    ctxOf(codeOf(task.assigneeMemberId), options.channel),
    { taskId: task.id, decision, ...(options.reason ? { reason: options.reason } : {}), ...(options.flagsKey !== undefined ? { subjectInput: { flagsKey: options.flagsKey } } : {}) },
    key(),
  )
}

beforeAll(async () => {
  ap = await payOrg()
})

describe('[FR-PAY-101/AC5] the approver approves the flags they were shown (BR-PAY-07)', () => {
  it('the page lists the flagged items first; a key that is not the flags now is PAYMENT_FLAGS_CHANGED and the task stays open; the right key approves', async () => {
    const flagged = await paySupplier(ap)
    const clean = await paySupplier(ap)
    const invoices = [await readyInvoice(ap, clean.id, '700.00', '49.00', DUE), await readyInvoice(ap, flagged.id, '900.00', '63.00', DUE)]
    await prisma.supplier.update({ where: { id: flagged.id }, data: { registryFlag: 'CEASED' } })
    const sent = await sentRun(ap, invoices, { [flagged.id]: 'งานส่งมอบครบก่อนเลิกกิจการ ตรวจกับจัดซื้อแล้ว' })
    expect(sent.flagsKey).toBe(`${flagged.code}:REGISTRY_CHANGED`)

    const view = (await getPaymentRunTaskView(ctxOf('cfo'), sent.runId))!
    expect(view.flagsKey).toBe(sent.flagsKey)
    expect(view.items[0]).toMatchObject({ supplierCode: flagged.code, flags: ['REGISTRY_CHANGED'], flagReason: 'งานส่งมอบครบก่อนเลิกกิจการ ตรวจกับจัดซื้อแล้ว' })
    expect(view.items[1]).toMatchObject({ supplierCode: clean.code, flags: [] })

    // a run with flags: no button in the chat, no LINE token; the chat is refused
    const task = (await openTaskOf(sent.runId))!
    expect(task.assigneeMemberId).toBe(ap.org.member.cfo)
    expect(await prisma.actionToken.count({ where: { taskId: task.id } })).toBe(0)
    expect(await forTenant(ap.org.organizationId).$transaction((tx) => outsideChannels(tx, 'PAYMENT_RUN', sent.runId))).toEqual({ chatButton: false, emailLink: false })
    expect(await decideTask(ctxOf('cfo', 'LINE_CHAT'), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'CHANNEL' } } })
    // no key, or the key of before: refused, and the task waits
    expect(await decide(sent.runId, 'APPROVE')).toMatchObject({ ok: false, error: { code: 'PAYMENT_FLAGS_CHANGED' } })
    // a change of the clean supplier's account is proposed meanwhile: a flag arises (one that needs no reason)
    await prisma.bankAccountChange.create({
      data: { organizationId: ap.org.organizationId, kind: 'CLOSE', ownerKind: 'SUPPLIER', supplierId: clean.id, targetBankAccountId: (await prisma.bankAccount.findFirstOrThrow({ where: { supplierId: clean.id } })).id, reason: 'ผู้ขายแจ้งปิด', submittedById: ap.org.member.fin_officer! },
    })
    expect(await decide(sent.runId, 'APPROVE', { flagsKey: sent.flagsKey })).toMatchObject({ ok: false, error: { code: 'PAYMENT_FLAGS_CHANGED' } })
    expect((await openTaskOf(sent.runId))?.id).toBe(task.id)
    const now = (await getPaymentRunTaskView(ctxOf('cfo'), sent.runId))!
    expect(now.flagsKey).toBe([`${clean.code}:BANK_CHANGE_PENDING`, `${flagged.code}:REGISTRY_CHANGED`].sort().join(';'))
    // in LIFF, with the key the page shows now
    expect(ok(await decide(sent.runId, 'APPROVE', { flagsKey: now.flagsKey, channel: 'LIFF' }))).toMatchObject({ documentStatus: 'APPROVED' })
    expect(await runOf(sent.runId)).toMatchObject({ status: 'APPROVED', approvedAt: expect.any(Date) })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: sent.runId, type: 'payment_run.approved' } })).toMatchObject({ data: { flagsKey: now.flagsKey } })
    const told = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'payment_run.decided', subjectId: sent.runId } })
    expect(told).toMatchObject({ recipientMemberId: ap.org.member.fin_officer, data: { outcome: 'APPROVED' } })
    expect(renderNotification(told, 'th').title).toContain('อนุมัติแล้ว')
  })

  it('a flag that needs the preparer’s reason and arose after sending refuses the approval; returned, the preparer explains it and sends again', async () => {
    const s = await paySupplier(ap)
    const sent = await sentRun(ap, [await readyInvoice(ap, s.id, '650.00', '45.50', DUE)])
    expect(sent.flagsKey).toBe('')
    await prisma.supplier.update({ where: { id: s.id }, data: { status: 'INACTIVE' } })
    const key2 = (await getPaymentRunTaskView(ctxOf('cfo'), sent.runId))!.flagsKey
    expect(key2).toBe(`${s.code}:SUPPLIER_INACTIVE`)
    expect(await decide(sent.runId, 'APPROVE', { flagsKey: key2 })).toMatchObject({ ok: false, error: { code: 'PAYMENT_FLAG_REASON_REQUIRED', details: { flag: 'SUPPLIER_INACTIVE' } } })
    ok(await decide(sent.runId, 'RETURN', { reason: 'ผู้ขายไม่ใช้งานแล้ว กรุณาอธิบาย' }))
    expect(await runOf(sent.runId)).toMatchObject({ status: 'DRAFT', currentRouteId: null })
    // returned: the documents are still held by the run
    expect((await prisma.paymentRunDocument.findFirstOrThrow({ where: { paymentRunId: sent.runId } })).status).toBe('HELD')
    expect(await prisma.notification.findFirstOrThrow({ where: { templateKey: 'payment_run.decided', subjectId: sent.runId } })).toMatchObject({ data: { outcome: 'RETURNED' } })
    ok(await setPaymentFlagReason(fin(ap), { paymentRunId: sent.runId, version: await runVersion(sent.runId), supplierId: s.id, reason: 'ผู้ขายปิดทะเบียนในระบบเรา แต่ยังต้องจ่ายงานที่ส่งมอบแล้ว' }, key()))
    const again = ok(await submitPaymentRun(fin(ap), { paymentRunId: sent.runId, version: await runVersion(sent.runId) }, key()))
    expect(again.number).toBe(sent.number)
    expect(await prisma.event.count({ where: { aggregateId: sent.runId, type: 'payment_run.resubmitted' } })).toBe(1)
    ok(await decide(sent.runId, 'APPROVE', { flagsKey: again.flagsKey }))
    expect((await runOf(sent.runId)).status).toBe('APPROVED')
  })
})

describe('[FR-PAY-101/AC8] who may not approve the run, refused at deciding with security.sod_blocked', () => {
  it('its preparer (BR-SOD-09), a recorder of its invoices (BR-SOD-04), the proposer of a recent change of its account (BR-SOD-10)', async () => {
    const s = await paySupplier(ap, { account: false })
    // the account in force came from a change admin2 proposed today
    const change = await prisma.bankAccountChange.create({
      data: { organizationId: ap.org.organizationId, number: `BAC-T-${randomUUID().slice(0, 6)}`, kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '006', accountNo: '3111222333', accountName: 'บัญชีใหม่', reason: 'ผู้ขายแจ้ง', status: 'APPROVED', submittedById: ap.org.member.admin2!, submittedAt: AP_NOW, decidedAt: AP_NOW },
    })
    await prisma.bankAccount.create({ data: { organizationId: ap.org.organizationId, ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '006', accountNo: '3111222333', accountName: 'บัญชีใหม่', sourceChangeId: change.id, activatedAt: AP_NOW } })
    // recorded by fin_officer, prepared by dm_fin
    const invoice = await readyInvoice(ap, s.id, '820.00', '57.40', DUE)
    const run = ok(await createPaymentRun(fin(ap, 'dm_fin'), { payerBankAccountId: ap.payerId, payDate: '2026-10-16' }, key())).paymentRunId
    ok(await addPaymentDocuments(fin(ap, 'dm_fin'), { paymentRunId: run, version: await runVersion(run), invoiceIds: [invoice] }, key()))
    const sent = ok(await submitPaymentRun(fin(ap, 'dm_fin'), { paymentRunId: run, version: await runVersion(run) }, key()))
    const task = (await openTaskOf(run))!
    // the route keeps them all off: the CFO approves
    expect(task.assigneeMemberId).toBe(ap.org.member.cfo)
    for (const [code, rule] of [
      ['dm_fin', 'BR-SOD-09'],
      ['fin_officer', 'BR-SOD-04'],
      ['admin2', 'BR-SOD-10'],
    ] as const) {
      await prisma.approvalTask.update({ where: { id: task.id }, data: { assigneeMemberId: ap.org.member[code]! } })
      await stepUpForTask(task.id, ap.org.member[code]!)
      expect(await decideTask(ctxOf(code), { taskId: task.id, decision: 'APPROVE', subjectInput: { flagsKey: sent.flagsKey } }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule } } })
      expect(await prisma.event.findFirst({ where: { type: 'security.sod_blocked', aggregateId: run, data: { path: ['rule'], equals: rule } } })).not.toBeNull()
    }
    expect((await runOf(run)).status).toBe('PENDING_APPROVAL')
  })
})

describe('[FR-PAY-101/AC9] the PIN from stepUpThreshold, rejection and the chat button of a small run without flags', () => {
  it('a run of 100,000.00 or more needs the PIN; rejected, its invoices are ready for payment again and the preparer hears it', async () => {
    const s = await paySupplier(ap)
    const invoices = [await readyInvoice(ap, s.id, '60000.00', '4200.00', DUE), await readyInvoice(ap, s.id, '50000.00', '3500.00', DUE)]
    const sent = await sentRun(ap, invoices)
    expect((await runOf(sent.runId)).totalTransferSatang).toBeGreaterThanOrEqual(10_000_000n)
    const task = (await openTaskOf(sent.runId))!
    expect(await decideTask(ctxOf('cfo'), { taskId: task.id, decision: 'REJECT', reason: 'ยอดสูงผิดปกติ', subjectInput: { flagsKey: '' } }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
    ok(await decide(sent.runId, 'REJECT', { reason: 'ยอดสูงผิดปกติ ขอตรวจใหม่' }))
    expect(await runOf(sent.runId)).toMatchObject({ status: 'REJECTED' })
    for (const id of invoices) expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe('READY_FOR_PAYMENT')
    expect((await prisma.paymentRunDocument.findMany({ where: { paymentRunId: sent.runId } })).map((d) => d.status)).toEqual(['RELEASED', 'RELEASED'])
    expect(await prisma.notification.findFirstOrThrow({ where: { templateKey: 'payment_run.decided', subjectId: sent.runId } })).toMatchObject({ data: { outcome: 'REJECTED' } })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: sent.runId, type: 'payment_run.rejected' } })).toMatchObject({ data: { documentCount: 2 } })
  })

  it('a small run sent without flags has its LINE button; the card names its number and the total, never a supplier or an account', async () => {
    const s = await paySupplier(ap)
    const sent = await sentRun(ap, [await readyInvoice(ap, s.id, '480.00', '33.60', DUE)])
    const task = (await openTaskOf(sent.runId))!
    // the subject lets the chat decide it (a linked approver gets the button, src/server/tokens/action-tokens.ts)
    expect(await forTenant(ap.org.organizationId).$transaction((tx) => outsideChannels(tx, 'PAYMENT_RUN', sent.runId))).toEqual({ chatButton: true, emailLink: false })
    const assigned = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.assigned', subjectId: sent.runId } })
    const message = (await approvalCardMessage(ap.org.organizationId, { taskId: task.id, memberId: task.assigneeMemberId, fallbackLabel: (assigned.data as { label: string }).label }, AP_NOW, { locale: 'th', liffId: null, appUrl: 'http://localhost' }))!
    // within what LINE accepts (src/integrations/line/limits.ts)
    expect(lineMessageProblems([message])).toEqual([])
    expect(jsonByteLength(message.contents)).toBeLessThanOrEqual(LINE_FLEX_BUBBLE_MAX_BYTES)
    const card = JSON.stringify(message)
    expect(card).toContain(sent.number)
    expect(card).toContain('รอบจ่ายเงิน')
    expect(card).not.toContain(s.code)
    expect(card).not.toContain(s.accountNo!)
    expect(card).not.toContain('ผู้ขาย')
    // approved in the chat: no subjectInput, the flags still none
    ok(await decideTask(ctxOf('cfo', 'LINE_CHAT'), { taskId: task.id, decision: 'APPROVE' }, key()))
    expect((await runOf(sent.runId)).status).toBe('APPROVED')
  })
})
