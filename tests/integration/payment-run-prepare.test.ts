import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { confirmIncomeType, updateIncomeType, updateSupplierTaxProfile } from '@/server/services/ap/wht'
import { setModule } from '@/server/services/modules'
import {
  addPaymentDocuments,
  cancelPaymentRun,
  createPaymentRun,
  proposePaymentRun,
  removePaymentDocuments,
  setPaymentFlagReason,
  submitPaymentRun,
  updatePaymentRun,
} from '@/server/services/payments/runs'
import { AP_NOW, apOrg, codedDraft, fin, key, ok, receive, submit, type ApOrg } from '../support/ap'

// S9-05 (FR-PAY-101 AC1 to AC4, AC6, AC7, AC8 at preparing, AC10, BR-PAY-01 to BR-PAY-09, BR-SOD-10, INV-PAY-01): FINANCE
// drafts a run on a proposed working Friday from the organization's account, adds invoices ready for payment and
// released retentions — held by S8 in the same transaction, one live run per document even when two runs ask at once —
// one item per supplier with the tax withheld at payment, flags that need the preparer's reason, and sends it: a
// number, items numbered by supplier code with the payee's account as the register has it, DOA PAYMENT_RUN with what is
// transferred. Whoever changed an account the run pays into lately may not prepare it. AP_NOW is Monday 12 Oct 2026;
// the fixture's holidays are 13 and 23 Oct; the run weekday is Friday (OQ-130).

let ap: ApOrg
let payerId: string
const PAY_DATE = '2026-10-16'
const finance = () => fin(ap)
const ctxOf = (code: string) => ap.org.ctxOf(code, AP_NOW)
const versionOf = async (id: string) => (await prisma.paymentRun.findUniqueOrThrow({ where: { id } })).version
const statusOf = async (invoiceId: string) => (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('')

beforeAll(async () => {
  ap = await apOrg()
  ok(await updateIncomeType(fin(ap), { code: 'SERVICE', nameTh: 'ค่าบริการ', rateBp: 300, form: 'PND3_53', active: true }, key()))
  ok(await confirmIncomeType(fin(ap, 'dm_fin'), { code: 'SERVICE' }, key()))
  payerId = (
    await prisma.bankAccount.create({
      data: { organizationId: ap.org.organizationId, ownerKind: 'ORGANIZATION', code: 'CB-01', bankCode: '004', accountNo: '1000000016', accountName: 'องค์กรทดสอบ DOA', accountType: 'CURRENT', fileTemplateCode: 'BCS-NEUTRAL-1', activatedAt: AP_NOW },
    })
  ).id
})

/** A supplier of the test with an ACTIVE account from the seed (or none), withholding SERVICE on service POs */
async function supplier(options: { account?: boolean } = {}) {
  const n = randomUUID().slice(0, 6)
  const s = await prisma.supplier.create({
    data: { organizationId: ap.org.organizationId, code: `SP-${n}`, nameTh: `ผู้ขาย ${n}`, taxId: `01${digits(11)}`, email: `pay-${n}@supplier.test.bcs.local` },
  })
  ok(await updateSupplierTaxProfile(fin(ap), { supplierId: s.id, payeeType: 'JURISTIC', defaultWhtIncomeTypeCode: 'SERVICE' }, key()))
  if (options.account !== false) {
    await prisma.bankAccount.create({ data: { organizationId: ap.org.organizationId, ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '014', accountNo: `2${digits(9)}`, accountName: `ผู้ขาย ${n}`, activatedAt: new Date('2026-01-01T00:00:00Z') } })
  }
  return { id: s.id, code: s.code }
}

let dates = 0
/** An invoice of the supplier ready for payment, due on `due`: a PO sent and received, the invoice matched (S8) */
async function readyInvoice(supplierId: string, unitPrice: string, vat: string, due: string, service = false) {
  const budgetLineId = await ap.flow.fundedLine(10_000_000n)
  await prisma.budgetLine.update({ where: { id: budgetLineId }, data: { accountCode: '510101' } })
  const pr = await ap.flow.approvedRequest(budgetLineId, [{ quantity: '1', unitPrice }])
  const po = await ap.flow.approvedPo(
    pr.lines.map((l) => l.id),
    supplierId,
  )
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: AP_NOW, ...(service ? { kind: 'SERVICE' } : {}) } })
  const sentPo = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  await receive(ap, sentPo, { 0: '1' })
  const date = new Date(Date.UTC(2026, 8, 30 - (++dates % 28))).toISOString().slice(0, 10)
  const draft = await codedDraft(ap, sentPo, { no: `P-${randomUUID().slice(0, 8)}`, date, vat, lines: [{ line: 0, quantity: '1', unitPrice }] })
  expect(ok(await submit(ap, draft)).status).toBe('READY_FOR_PAYMENT')
  await prisma.invoice.update({ where: { id: draft.invoiceId }, data: { dueDate: new Date(`${due}T00:00:00Z`) } })
  return draft.invoiceId
}

/** A released retention of the supplier (as S8-09 leaves one), on an invoice of its own */
async function releasableRetention(supplierId: string, amount: bigint) {
  const invoiceId = await readyInvoice(supplierId, '100.00', '7.00', '2026-12-31', true)
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
  // its invoice was paid before; the retention held back on it is released now
  await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'PAID' } })
  return (await prisma.retention.create({ data: { organizationId: ap.org.organizationId, invoiceId, poId: invoice.poId, supplierId, amountSatang: amount, status: 'RELEASABLE', releaseDueOn: new Date('2026-10-01T00:00:00Z') } })).id
}

async function draftRun(by = 'fin_officer', payDate = PAY_DATE) {
  return ok(await createPaymentRun(fin(ap, by), { payerBankAccountId: payerId, payDate }, key())).paymentRunId
}
async function add(runId: string, docs: { invoiceIds?: string[]; retentionIds?: string[] }, by = 'fin_officer') {
  return addPaymentDocuments(fin(ap, by), { paymentRunId: runId, version: await versionOf(runId), ...docs }, key())
}

describe('[FR-PAY-101/AC1] a run on the proposed working Friday, with what is due by then', () => {
  it('proposes Friday 16 Oct and the ready invoices due by then with the released retentions; a weekend, a holiday or a past day is PAYMENT_DATE_INVALID', async () => {
    const s = await supplier()
    const due = await readyInvoice(s.id, '1000.00', '70.00', '2026-10-15')
    const later = await readyInvoice(s.id, '2000.00', '140.00', '2026-11-30')
    const retention = await releasableRetention(s.id, 5_000n)
    const proposal = ok(await proposePaymentRun(finance()))
    expect(proposal.payDate).toBe(PAY_DATE)
    expect(proposal.payers.map((p) => p.id)).toContain(payerId)
    const ids = proposal.documents.map((d) => d.id)
    expect(ids).toEqual(expect.arrayContaining([due, retention]))
    expect(ids).not.toContain(later)
    // a pay date chosen later proposes what is due by then
    expect(ok(await proposePaymentRun(finance(), { payDate: '2026-12-04' })).documents.map((d) => d.id)).toContain(later)
    for (const [payDate, reason] of [
      ['2026-10-17', 'NOT_BUSINESS_DAY'],
      ['2026-10-23', 'NOT_BUSINESS_DAY'],
      ['2026-10-09', 'PAST'],
    ] as const) {
      expect(await createPaymentRun(finance(), { payerBankAccountId: payerId, payDate }, key())).toMatchObject({ ok: false, error: { code: 'PAYMENT_DATE_INVALID', details: { reason } } })
    }
    expect(ok(await createPaymentRun(finance(), { payerBankAccountId: payerId }, key()))).toMatchObject({ payDate: PAY_DATE })
    // a supplier's account is no payer
    const supplierAccount = await prisma.bankAccount.findFirstOrThrow({ where: { supplierId: s.id } })
    expect(await createPaymentRun(finance(), { payerBankAccountId: supplierAccount.id, payDate: PAY_DATE }, key())).toMatchObject({ ok: false, error: { details: { reason: 'PAYER_NOT_ACTIVE' } } })
  })
})

describe('[FR-PAY-101/AC2] one item per supplier: what it pays, the tax withheld at payment, what is transferred', () => {
  it('two service invoices and a retention of one supplier are one item; the tax is rounded once per group; another supplier is a second item', async () => {
    const a = await supplier()
    const b = await supplier()
    const i1 = await readyInvoice(a.id, '1000.00', '70.00', '2026-10-15', true)
    const i2 = await readyInvoice(a.id, '333.33', '23.33', '2026-10-15', true)
    const r1 = await releasableRetention(a.id, 10_000n)
    const i3 = await readyInvoice(b.id, '500.00', '35.00', '2026-10-15')
    const run = await draftRun()
    ok(await add(run, { invoiceIds: [i1, i2, i3], retentionIds: [r1] }))
    expect(await statusOf(i1)).toBe('IN_PAYMENT_RUN')
    expect((await prisma.retention.findUniqueOrThrow({ where: { id: r1 } })).status).toBe('IN_PAYMENT_RUN')
    const items = await prisma.paymentRunItem.findMany({ where: { paymentRunId: run }, include: { supplier: true }, orderBy: { supplier: { code: 'asc' } } })
    expect(items).toHaveLength(2)
    const itemA = items.find((i) => i.supplierId === a.id)!
    const payable = (await prisma.invoice.findMany({ where: { id: { in: [i1, i2] } } })).reduce((s, i) => s + i.payableSatang, 0n) + 10_000n
    const whtRows = await prisma.paymentRunItemWht.findMany({ where: { paymentRunItemId: itemA.id } })
    expect(itemA).toMatchObject({ payableSatang: payable, whtSatang: whtRows.reduce((s, w) => s + w.whtSatang, 0n) })
    expect(itemA.transferSatang).toBe(itemA.payableSatang - itemA.whtSatang)
    // one group of SERVICE at 3%: the bases of the item added first, then rounded half-up once (BR-WHT-10)
    expect(whtRows).toEqual([expect.objectContaining({ incomeType: 'SERVICE', rateBp: 300 })])
    expect(whtRows[0]!.whtSatang).toBe((whtRows[0]!.baseSatang * 300n + 5_000n) / 10_000n)
    const itemB = items.find((i) => i.supplierId === b.id)!
    expect(itemB.whtSatang).toBe(0n)
    const totals = await prisma.paymentRun.findUniqueOrThrow({ where: { id: run } })
    expect(totals).toMatchObject({ itemCount: 2, documentCount: 4, totalPayableSatang: itemA.payableSatang + itemB.payableSatang, totalTransferSatang: itemA.transferSatang + itemB.transferSatang })
    // taken out of the draft: ready for payment again, and an item left empty leaves the run
    ok(await removePaymentDocuments(finance(), { paymentRunId: run, version: await versionOf(run), invoiceIds: [i3] }, key()))
    expect(await statusOf(i3)).toBe('READY_FOR_PAYMENT')
    expect(await prisma.paymentRunItem.count({ where: { paymentRunId: run } })).toBe(1)
    expect(await prisma.paymentRun.findUniqueOrThrow({ where: { id: run } })).toMatchObject({ itemCount: 1, documentCount: 3 })
  })
})

describe('[FR-PAY-101/AC3] a document is in one live run and paid once (INV-PAY-01)', () => {
  it('a document not ready, or held by another run, is DOCUMENT_NOT_PAYABLE and nothing is added', async () => {
    const s = await supplier()
    const inv = await readyInvoice(s.id, '1200.00', '84.00', '2026-10-15')
    const first = await draftRun()
    ok(await add(first, { invoiceIds: [inv] }))
    const second = await draftRun()
    expect(await add(second, { invoiceIds: [inv] })).toMatchObject({ ok: false, error: { code: 'DOCUMENT_NOT_PAYABLE', details: { kind: 'INVOICE' } } })
    expect(await prisma.paymentRunDocument.count({ where: { paymentRunId: second } })).toBe(0)
    const draftOnly = await readyInvoice(s.id, '50.00', '3.50', '2026-10-15')
    await prisma.invoice.update({ where: { id: draftOnly }, data: { status: 'EXCEPTION' } })
    expect(await add(second, { invoiceIds: [draftOnly] })).toMatchObject({ ok: false, error: { code: 'DOCUMENT_NOT_PAYABLE' } })
  })

  it('the same invoice added to two runs at the same moment: one run takes it, the other is refused', async () => {
    const s = await supplier()
    const inv = await readyInvoice(s.id, '1300.00', '91.00', '2026-10-15')
    const [a, b] = [await draftRun(), await draftRun()]
    const [va, vb] = [await versionOf(a), await versionOf(b)]
    const results = await Promise.all([
      addPaymentDocuments(finance(), { paymentRunId: a, version: va, invoiceIds: [inv] }, key()),
      addPaymentDocuments(finance(), { paymentRunId: b, version: vb, invoiceIds: [inv] }, key()),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ error: { code: 'DOCUMENT_NOT_PAYABLE' } })
    expect(await prisma.paymentRunDocument.count({ where: { invoiceId: inv, status: { in: ['HELD', 'PAID'] } } })).toBe(1)
  })
})

describe('[FR-PAY-101/AC4] [FR-PAY-101/AC6] flags of an item and the reason they need', () => {
  it('a supplier whose registry changed or who is inactive is flagged; sending without the reason is PAYMENT_FLAG_REASON_REQUIRED; no override of S11 ever expires in phase 1', async () => {
    const ceased = await supplier()
    const inactive = await supplier()
    const invoices = [await readyInvoice(ceased.id, '700.00', '49.00', '2026-10-15'), await readyInvoice(inactive.id, '800.00', '56.00', '2026-10-15')]
    // the registry reports the first ceased after its invoice was ready; the second is no longer used
    await prisma.supplier.update({ where: { id: ceased.id }, data: { registryFlag: 'CEASED' } })
    await prisma.supplier.update({ where: { id: inactive.id }, data: { status: 'INACTIVE' } })
    const run = await draftRun()
    ok(await add(run, { invoiceIds: invoices }))
    const flags = Object.fromEntries((await prisma.paymentRunItem.findMany({ where: { paymentRunId: run } })).map((i) => [i.supplierId, i.flags]))
    expect(flags[ceased.id]).toEqual(['REGISTRY_CHANGED'])
    expect(flags[inactive.id]).toEqual(['SUPPLIER_INACTIVE'])
    expect(Object.values(flags).flat()).not.toContain('RISK_OVERRIDE_EXPIRED')
    expect(await submitPaymentRun(finance(), { paymentRunId: run, version: await versionOf(run) }, key())).toMatchObject({ ok: false, error: { code: 'PAYMENT_FLAG_REASON_REQUIRED', details: { flag: expect.any(String) } } })
    for (const s of [ceased, inactive]) ok(await setPaymentFlagReason(finance(), { paymentRunId: run, version: await versionOf(run), supplierId: s.id, reason: 'ตรวจกับฝ่ายจัดซื้อแล้ว งานส่งมอบครบก่อนเลิกกิจการ' }, key()))
    const sent = ok(await submitPaymentRun(finance(), { paymentRunId: run, version: await versionOf(run) }, key()))
    expect(sent.flagsKey).toBe([`${ceased.code}:REGISTRY_CHANGED`, `${inactive.code}:SUPPLIER_INACTIVE`].sort().join(';'))
  })
})

describe('[FR-PAY-101/AC7] sending: a number, the items numbered with their payee, DOA PAYMENT_RUN with what is transferred', () => {
  it('PAY-01 sends it to the CFO with the total transferred; each item has its seq by supplier code and the account as the register has it', async () => {
    const a = await supplier()
    const b = await supplier()
    const run = await draftRun()
    ok(await add(run, { invoiceIds: [await readyInvoice(b.id, '900.00', '63.00', '2026-10-15'), await readyInvoice(a.id, '400.00', '28.00', '2026-10-15')] }))
    const sent = ok(await submitPaymentRun(finance(), { paymentRunId: run, version: await versionOf(run) }, key()))
    expect(sent.number).toMatch(/^PAY-\d{4}-\d{5}$/)
    expect(sent.flagsKey).toBe('')
    const row = await prisma.paymentRun.findUniqueOrThrow({ where: { id: run } })
    expect(row).toMatchObject({ status: 'PENDING_APPROVAL', number: sent.number, flagsKey: '' })
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectType: 'PAYMENT_RUN', subjectId: run } })
    expect(route).toMatchObject({ ruleCode: 'PAY-01', amountSatang: row.totalTransferSatang })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { step: { routeId: route.id } } })
    expect(task.assigneeMemberId).toBe(ap.org.member.cfo)
    const items = await prisma.paymentRunItem.findMany({ where: { paymentRunId: run }, include: { supplier: true }, orderBy: { seq: 'asc' } })
    expect(items.map((i) => i.supplier.code)).toEqual([a.code, b.code].sort())
    for (const item of items) {
      const account = await prisma.bankAccount.findFirstOrThrow({ where: { supplierId: item.supplierId, status: 'ACTIVE' } })
      expect(item).toMatchObject({ bankAccountId: account.id, payeeBankCode: account.bankCode, payeeAccountNo: account.accountNo, payeeAccountName: account.accountName })
    }
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: run, type: 'payment_run.submitted' } })).toMatchObject({ data: { number: sent.number, itemCount: 2 } })
    // sent, the run is no draft any more
    expect(await add(run, { invoiceIds: [await readyInvoice(a.id, '10.00', '0.70', '2026-10-15')] })).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })

  it('a supplier without an approved account in force is BANK_ACCOUNT_NOT_APPROVED', async () => {
    const s = await supplier({ account: false })
    const run = await draftRun()
    ok(await add(run, { invoiceIds: [await readyInvoice(s.id, '600.00', '42.00', '2026-10-15')] }))
    expect(await submitPaymentRun(finance(), { paymentRunId: run, version: await versionOf(run) }, key())).toMatchObject({ ok: false, error: { code: 'BANK_ACCOUNT_NOT_APPROVED', details: { supplier: s.code } } })
  })

  it('the CFO preparing the run is kept off its route: the next band (PAY-02, the CEO) approves it (BR-DOA-06)', async () => {
    await prisma.roleAssignment.create({ data: { organizationId: ap.org.organizationId, memberId: ap.org.member.cfo!, role: 'FINANCE', grantedAt: AP_NOW } })
    const s = await supplier()
    const run = await draftRun('cfo')
    ok(await add(run, { invoiceIds: [await readyInvoice(s.id, '1500.00', '105.00', '2026-10-15')] }, 'cfo'))
    ok(await submitPaymentRun(fin(ap, 'cfo'), { paymentRunId: run, version: await versionOf(run) }, key()))
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { step: { route: { subjectType: 'PAYMENT_RUN', subjectId: run } } } })
    expect(task.assigneeMemberId).not.toBe(ap.org.member.cfo)
    expect(task.assigneeMemberId).toBe(ap.org.member.ceo)
  })
})

describe('[FR-PAY-101/AC8] [BR-SOD-10] whoever changed an account the run pays into lately may not prepare it', () => {
  it('adding or sending a run that pays into an account fin_officer changed within 30 days of the pay date is SOD_VIOLATION', async () => {
    const s = await supplier({ account: false })
    const inv = await readyInvoice(s.id, '2500.00', '175.00', '2026-10-15')
    const change = await prisma.bankAccountChange.create({
      data: { organizationId: ap.org.organizationId, number: `BAC-T-${randomUUID().slice(0, 6)}`, kind: 'ADD', ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '006', accountNo: `3${digits(9)}`, accountName: 'บัญชีใหม่', reason: 'ผู้ขายแจ้ง', status: 'APPROVED', submittedById: ap.org.member.fin_officer!, submittedAt: AP_NOW, decidedAt: AP_NOW },
    })
    await prisma.bankAccount.create({ data: { organizationId: ap.org.organizationId, ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '006', accountNo: change.accountNo!, accountName: 'บัญชีใหม่', sourceChangeId: change.id, activatedAt: AP_NOW } })
    const run = await draftRun()
    expect(await add(run, { invoiceIds: [inv] })).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-10' } } })
    expect(await prisma.event.findFirst({ where: { type: 'security.sod_blocked', aggregateId: run } })).toMatchObject({ data: { rule: 'BR-SOD-10', subjectType: 'PAYMENT_RUN' } })
    expect(await statusOf(inv)).toBe('READY_FOR_PAYMENT')
    // another FINANCE member prepares it; the item is flagged BANK_ACCOUNT_RECENTLY_CHANGED
    const other = await draftRun('dm_fin')
    ok(await add(other, { invoiceIds: [inv] }, 'dm_fin'))
    expect((await prisma.paymentRunItem.findFirstOrThrow({ where: { paymentRunId: other } })).flags).toEqual(['BANK_ACCOUNT_RECENTLY_CHANGED'])
  })
})

describe('[FR-PAY-101/AC10] who may prepare, and module PAY', () => {
  it('without paymentRun.prepare FORBIDDEN; another FINANCE member may not edit the draft; PAY off MODULE_DISABLED; PAY stays on while a run is open', async () => {
    for (const code of ['proc_officer', 'auditor']) {
      expect(await createPaymentRun(ctxOf(code), { payerBankAccountId: payerId, payDate: PAY_DATE }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    const s = await supplier()
    const run = await draftRun()
    const inv = await readyInvoice(s.id, '450.00', '31.50', '2026-10-15')
    expect(await add(run, { invoiceIds: [inv] }, 'dm_fin')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { capability: 'paymentRun.prepare' } } })
    expect(await updatePaymentRun(fin(ap, 'dm_fin'), { paymentRunId: run, version: await versionOf(run), payDate: '2026-10-30' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await cancelPaymentRun(fin(ap, 'dm_fin'), { paymentRunId: run, version: await versionOf(run), reason: 'ไม่ใช่ของฉัน' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // the preparer moves the pay date; the run stays a draft
    ok(await updatePaymentRun(finance(), { paymentRunId: run, version: await versionOf(run), payDate: '2026-10-30' }, key()))
    expect((await prisma.paymentRun.findUniqueOrThrow({ where: { id: run } })).payDate.toISOString().slice(0, 10)).toBe('2026-10-30')

    const platformAdmin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
    const platform = makeCtx({ organizationId: ap.org.organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: platformAdmin.id }, channel: 'WEB', now: AP_NOW })
    const refused = await setModule(platform, { module: 'PAY', enabled: false, contractRef: 'CT-1', reason: 'ทดสอบปิดโมดูล' }, key())
    expect(refused).toMatchObject({ ok: false, error: { code: 'MODULE_IN_USE', details: { reason: 'OPEN_DOCUMENTS', documents: expect.arrayContaining([run]) } } })

    await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'PAY' }, data: { enabled: false } })
    try {
      expect(await createPaymentRun(finance(), { payerBankAccountId: payerId, payDate: PAY_DATE }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
      expect(await proposePaymentRun(finance())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    } finally {
      await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'PAY' }, data: { enabled: true } })
    }
  })
})

describe('[S9-05] [BR-PAY-10] cancelled before approval: every document is ready for payment again', () => {
  it('a run waiting for approval cancelled by its preparer closes its route and lets its invoices and retentions go', async () => {
    const s = await supplier()
    const inv = await readyInvoice(s.id, '3100.00', '217.00', '2026-10-15')
    const ret = await releasableRetention(s.id, 20_000n)
    const run = await draftRun()
    ok(await add(run, { invoiceIds: [inv], retentionIds: [ret] }))
    ok(await submitPaymentRun(finance(), { paymentRunId: run, version: await versionOf(run) }, key()))
    ok(await cancelPaymentRun(finance(), { paymentRunId: run, version: await versionOf(run), reason: 'ผู้ขายขอเลื่อนรับเงิน' }, key()))
    expect(await prisma.paymentRun.findUniqueOrThrow({ where: { id: run } })).toMatchObject({ status: 'CANCELLED', cancelReason: 'ผู้ขายขอเลื่อนรับเงิน' })
    expect(await statusOf(inv)).toBe('READY_FOR_PAYMENT')
    expect((await prisma.retention.findUniqueOrThrow({ where: { id: ret } })).status).toBe('RELEASABLE')
    expect(await prisma.paymentRunDocument.findMany({ where: { paymentRunId: run } })).toEqual([expect.objectContaining({ status: 'RELEASED', releasedAfterExport: false }), expect.objectContaining({ status: 'RELEASED' })])
    expect(await prisma.approvalTask.count({ where: { status: 'OPEN', step: { route: { subjectType: 'PAYMENT_RUN', subjectId: run } } } })).toBe(0)
    const events = await prisma.event.findMany({ where: { aggregateId: run }, orderBy: { seq: 'asc' }, select: { type: true } })
    expect(events.map((e) => e.type)).toEqual(['payment_run.drafted', 'payment_run.documents_added', 'payment_run.submitted', 'payment_run.cancelled'])
    // the documents go into another run
    const next = await draftRun()
    ok(await add(next, { invoiceIds: [inv], retentionIds: [ret] }))
  })
})
