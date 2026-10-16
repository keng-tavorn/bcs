import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { createMember, createOrg } from '../support/factory'

// S9-01 (docs/sub-specs/S9.md "Entity และ migration", spec §6.3): the database keeps one ACTIVE account per supplier
// (INV-PAY-04) and one open change per supplier and per target account, refuses an account number that is not 10 to 12
// digits (BR-SUP-07), money that is negative or a transfer that is not payable − tax (INV-PAY-02), a document held or paid
// by two rows (INV-PAY-01), and a bank file changed in any other way than becoming SUPERSEDED once and having its first
// download set once, or removed (INV-PAY-03). References into another organization are refused by the generated tenant
// test (tests/generated/tenant-isolation.test.ts), which reads the new tables from the DMMF.

let orgId: string
let memberId: string
let supplierId: string
let otherSupplierId: string
let payerId: string
let fileObjectId: string

beforeAll(async () => {
  const org = await createOrg()
  orgId = org.id
  memberId = (await createMember(orgId)).id
  const supplier = (code: string) => prisma.supplier.create({ data: { organizationId: orgId, code, nameTh: `ผู้ขาย ${code}`, isForeign: true } })
  supplierId = (await supplier(`S-${randomUUID().slice(0, 6)}`)).id
  otherSupplierId = (await supplier(`S-${randomUUID().slice(0, 6)}`)).id
  payerId = (await prisma.bankAccount.create({ data: { organizationId: orgId, ownerKind: 'ORGANIZATION', code: 'CB-01', bankCode: '004', accountNo: '9991000016', accountName: 'บริษัททดสอบ', accountType: 'CURRENT', fileTemplateCode: 'BCS-NEUTRAL-1' } })).id
  fileObjectId = (await prisma.fileObject.create({ data: { organizationId: orgId, storageKey: `test/${randomUUID()}.csv`, fileName: 'f.csv', mimeType: 'text/csv', sizeBytes: 1, status: 'AVAILABLE', uploadedById: memberId } })).id
})

const supplierAccount = (over: Record<string, unknown> = {}) => ({ organizationId: orgId, ownerKind: 'SUPPLIER' as const, supplierId, bankCode: '014', accountNo: '9123456789', accountName: 'ผู้ขายทดสอบ', ...over })

describe('[INV-PAY-04] [BR-SUP-07] bank accounts', () => {
  it('keeps one ACTIVE account per supplier; a superseded one may stay beside it', async () => {
    const first = await prisma.bankAccount.create({ data: supplierAccount() })
    await expect(prisma.bankAccount.create({ data: supplierAccount({ accountNo: '9123456780' }) })).rejects.toThrow()
    await prisma.bankAccount.update({ where: { id: first.id }, data: { status: 'SUPERSEDED' } })
    await expect(prisma.bankAccount.create({ data: supplierAccount({ accountNo: '9123456780' }) })).resolves.toBeTruthy()
  })

  it('lets two suppliers share one account number (the SHARED_BANK_ACCOUNT flag, not a refusal)', async () => {
    await expect(prisma.bankAccount.create({ data: supplierAccount({ supplierId: otherSupplierId }) })).resolves.toBeTruthy()
  })

  it.each([
    ['nine digits', { accountNo: '912345678' }],
    ['thirteen digits', { accountNo: '9123456789012' }],
    ['dashes kept', { accountNo: '912-3-45678-9' }],
    ['a control character in the name', { accountName: 'ผู้ขาย\u0007' }],
    ['an empty name', { accountName: '' }],
    ['a supplier account without its supplier', { supplierId: null }],
    ['a supplier account with a file template', { fileTemplateCode: 'BCS-NEUTRAL-1' }],
  ])('refuses %s', async (_label, over) => {
    await expect(prisma.bankAccount.create({ data: supplierAccount({ supplierId: otherSupplierId, status: 'CLOSED', ...over }) })).rejects.toThrow()
  })

  it('refuses an account of the organization without its type, or naming a supplier; its code is optional', async () => {
    const own = { organizationId: orgId, ownerKind: 'ORGANIZATION' as const, bankCode: '004', accountNo: '9991000017', accountName: 'บริษัททดสอบ' }
    await expect(prisma.bankAccount.create({ data: { ...own, code: 'CB-09' } })).rejects.toThrow()
    await expect(prisma.bankAccount.create({ data: { ...own, code: 'CB-08', accountType: 'CURRENT', supplierId } })).rejects.toThrow()
    // the code (CB-01) is the organization's label, not required by the sub-spec: an approved change makes the account without it
    await expect(prisma.bankAccount.create({ data: { ...own, accountType: 'CURRENT', status: 'CLOSED' } })).resolves.toBeTruthy()
  })
})

describe('[BR-SUP-06] bank account changes', () => {
  const change = (over: Record<string, unknown> = {}) => ({ organizationId: orgId, kind: 'ADD' as const, ownerKind: 'SUPPLIER' as const, supplierId: otherSupplierId, bankCode: '002', accountNo: '9000000001', accountName: 'ผู้ขาย', reason: 'บัญชีใหม่', submittedById: memberId, ...over })

  it('keeps one open request per supplier and per target account', async () => {
    const open = await prisma.bankAccountChange.create({ data: change() })
    await expect(prisma.bankAccountChange.create({ data: change() })).rejects.toThrow()
    await prisma.bankAccountChange.update({ where: { id: open.id }, data: { status: 'CANCELLED' } })
    await expect(prisma.bankAccountChange.create({ data: change({ status: 'REJECTED' }) })).resolves.toBeTruthy()
    // the organization's account has no supplier: its open requests are kept apart by the target
    const own = { ownerKind: 'ORGANIZATION' as const, supplierId: null, kind: 'CLOSE' as const, targetBankAccountId: payerId, bankCode: null, accountNo: null, accountName: null }
    await prisma.bankAccountChange.create({ data: change(own) })
    await expect(prisma.bankAccountChange.create({ data: change(own) })).rejects.toThrow()
  })

  // the cases are built when the file loads, before beforeAll: an id they need is read when the case runs
  it.each<[string, () => Record<string, unknown>]>([
    ['REPLACE without the account it replaces', () => ({ kind: 'REPLACE' })],
    ['ADD naming a target', () => ({ targetBankAccountId: payerId })],
    ['ADD without the account number', () => ({ accountNo: null })],
    ['a number with letters', () => ({ accountNo: '90000000AB' })],
    ['an account of the organization added without its type', () => ({ ownerKind: 'ORGANIZATION', supplierId: null })],
    ['no reason', () => ({ reason: '' })],
  ])('refuses %s', async (_label, over) => {
    await expect(prisma.bankAccountChange.create({ data: change({ status: 'REJECTED', ...over() }) })).rejects.toThrow()
  })

  it('accepts an account of the organization added with its type and without a supplier', async () => {
    await expect(prisma.bankAccountChange.create({ data: change({ status: 'REJECTED', ownerKind: 'ORGANIZATION', supplierId: null, accountType: 'SAVINGS' }) })).resolves.toBeTruthy()
  })
})

describe('[INV-PAY-02] [INV-PAY-01] payment runs, items and documents', () => {
  let runId: string
  let itemId: string
  const run = (over: Record<string, unknown> = {}) => ({ organizationId: orgId, payDate: new Date('2026-10-16T00:00:00Z'), payerBankAccountId: payerId, fileTemplateCode: 'BCS-NEUTRAL-1', preparedById: memberId, ...over })

  beforeAll(async () => {
    runId = (await prisma.paymentRun.create({ data: run({ totalPayableSatang: 107_000n, totalWhtSatang: 3_000n, totalTransferSatang: 104_000n, itemCount: 1, documentCount: 1 }) })).id
    itemId = (await prisma.paymentRunItem.create({ data: { organizationId: orgId, paymentRunId: runId, supplierId, payableSatang: 107_000n, whtSatang: 3_000n, transferSatang: 104_000n, flags: ['SHARED_BANK_ACCOUNT'] } })).id
  })

  it.each([
    ['a currency other than THB', { currency: 'USD' }],
    ['a transfer that is not payable − tax', { totalPayableSatang: 100n, totalWhtSatang: 3n, totalTransferSatang: 98n }],
    ['negative tax', { totalPayableSatang: 100n, totalWhtSatang: -1n, totalTransferSatang: 101n }],
  ])('refuses a run with %s', async (_label, over) => {
    await expect(prisma.paymentRun.create({ data: run(over) })).rejects.toThrow()
  })

  it('refuses an item whose transfer is not payable − tax, a seq of zero, or a payee number that is not digits', async () => {
    const item = { organizationId: orgId, paymentRunId: runId, supplierId: otherSupplierId }
    await expect(prisma.paymentRunItem.create({ data: { ...item, payableSatang: 100n, whtSatang: 3n, transferSatang: 96n } })).rejects.toThrow()
    await expect(prisma.paymentRunItem.create({ data: { ...item, seq: 0 } })).rejects.toThrow()
    await expect(prisma.paymentRunItem.create({ data: { ...item, payeeAccountNo: '912-3456789' } })).rejects.toThrow()
    await expect(prisma.paymentRunItemWht.create({ data: { organizationId: orgId, paymentRunItemId: itemId, incomeType: 'SERVICE', rateBp: 10_001, baseSatang: 100n, whtSatang: 3n } })).rejects.toThrow()
  })

  it('holds a document in one run at most: a second HELD or PAID row is refused, a RELEASED one is not', async () => {
    const supplier = { organizationId: orgId, supplierId }
    const po = await prisma.purchaseOrder.create({ data: { ...supplier, status: 'SENT', number: `PO-${randomUUID().slice(0, 8)}` } })
    const invoice = await prisma.invoice.create({ data: { ...supplier, poId: po.id, channel: 'UPLOAD' } })
    const doc = (status: 'HELD' | 'PAID' | 'RELEASED') => ({ organizationId: orgId, paymentRunId: runId, paymentRunItemId: itemId, docKind: 'INVOICE' as const, invoiceId: invoice.id, payableSatang: 107_000n, status })
    await prisma.paymentRunDocument.create({ data: doc('RELEASED') })
    const held = await prisma.paymentRunDocument.create({ data: doc('HELD') })
    await expect(prisma.paymentRunDocument.create({ data: doc('HELD') })).rejects.toThrow()
    await expect(prisma.paymentRunDocument.create({ data: doc('PAID') })).rejects.toThrow()
    await prisma.paymentRunDocument.update({ where: { id: held.id }, data: { status: 'RELEASED' } })
    await expect(prisma.paymentRunDocument.create({ data: doc('PAID') })).resolves.toBeTruthy()
    // an invoice row names no retention, a retention row no invoice
    await expect(prisma.paymentRunDocument.create({ data: { ...doc('RELEASED'), docKind: 'RETENTION' } })).rejects.toThrow()
  })
})

describe('[INV-PAY-03] [BR-BANK-08] a bank file only becomes SUPERSEDED and gets its first download, once each', () => {
  it('lets the two changes through once and refuses every other change and removal', async () => {
    const runId = (await prisma.paymentRun.create({ data: { organizationId: orgId, payDate: new Date('2026-10-23T00:00:00Z'), payerBankAccountId: payerId, fileTemplateCode: 'BCS-NEUTRAL-1', preparedById: memberId } })).id
    const file = (version: number, over: Record<string, unknown> = {}) => ({ organizationId: orgId, paymentRunId: runId, version, templateCode: 'BCS-NEUTRAL-1', fileId: fileObjectId, fileName: `run_v${version}.csv`, sha256: 'a'.repeat(64), byteSize: 10, itemCount: 1, totalSatang: 104_000n, generatedById: memberId, generatedAt: new Date(), ...over })
    // version 2 needs its reason (BR-BANK-03); one CURRENT file per run
    await expect(prisma.paymentFile.create({ data: file(2) })).rejects.toThrow()
    const v1 = await prisma.paymentFile.create({ data: file(1) })
    await expect(prisma.paymentFile.create({ data: file(2, { reason: 'แก้บัญชี' }) })).rejects.toThrow()

    const at = new Date('2026-10-20T03:00:00Z')
    await prisma.paymentFile.update({ where: { id: v1.id }, data: { firstDownloadedAt: at } })
    await expect(prisma.paymentFile.update({ where: { id: v1.id }, data: { firstDownloadedAt: new Date() } })).rejects.toThrow()
    await expect(prisma.paymentFile.update({ where: { id: v1.id }, data: { totalSatang: 1n } })).rejects.toThrow()
    await expect(prisma.paymentFile.update({ where: { id: v1.id }, data: { sha256: 'b'.repeat(64) } })).rejects.toThrow()
    await prisma.paymentFile.update({ where: { id: v1.id }, data: { status: 'SUPERSEDED' } })
    await expect(prisma.paymentFile.update({ where: { id: v1.id }, data: { status: 'CURRENT' } })).rejects.toThrow()
    await expect(prisma.paymentFile.create({ data: file(2, { reason: 'แก้บัญชี' }) })).resolves.toBeTruthy()
    await expect(prisma.paymentFile.delete({ where: { id: v1.id } })).rejects.toThrow()
    expect(await prisma.paymentFile.findUniqueOrThrow({ where: { id: v1.id } })).toMatchObject({ status: 'SUPERSEDED', firstDownloadedAt: at, totalSatang: 104_000n })
  })
})

describe('[BR-WHT-07] one 50 ทวิ per payment item', () => {
  it('refuses a second certificate for the same item', async () => {
    const runId = (await prisma.paymentRun.create({ data: { organizationId: orgId, payDate: new Date('2026-10-30T00:00:00Z'), payerBankAccountId: payerId, fileTemplateCode: 'BCS-NEUTRAL-1', preparedById: memberId } })).id
    const itemId = (await prisma.paymentRunItem.create({ data: { organizationId: orgId, paymentRunId: runId, supplierId } })).id
    const cert = (number: string) => ({ organizationId: orgId, number, supplierId, form: 'PND53' as const, paidOn: new Date('2026-10-30T00:00:00Z'), totalBaseSatang: 100_000n, totalTaxSatang: 3_000n, payeeSnapshot: {}, payerSnapshot: {}, issuedAt: new Date(), paymentRunItemId: itemId })
    await prisma.whtCertificate.create({ data: cert(`C-${randomUUID().slice(0, 6)}`) })
    await expect(prisma.whtCertificate.create({ data: cert(`C-${randomUUID().slice(0, 6)}`) })).rejects.toThrow()
  })
})

describe('S9-01 review: guards of the payment tables', () => {
  it('[BR-PAY-01] pays a run only from an account of the organization', async () => {
    const supplierAcct = await prisma.bankAccount.create({ data: supplierAccount({ supplierId: otherSupplierId, status: 'SUPERSEDED', accountNo: '9111111111' }) })
    const run = { organizationId: orgId, payDate: new Date('2026-11-06T00:00:00Z'), fileTemplateCode: 'BCS-NEUTRAL-1', preparedById: memberId }
    await expect(prisma.paymentRun.create({ data: { ...run, payerBankAccountId: supplierAcct.id } })).rejects.toThrow()
    const ok = await prisma.paymentRun.create({ data: { ...run, payerBankAccountId: payerId } })
    await expect(prisma.paymentRun.update({ where: { id: ok.id }, data: { payerBankAccountId: supplierAcct.id } })).rejects.toThrow()
  })

  it('[INV-PAY-02] links a document to an item of its own run and supplier only', async () => {
    const run = (day: string) => prisma.paymentRun.create({ data: { organizationId: orgId, payDate: new Date(`${day}T00:00:00Z`), payerBankAccountId: payerId, fileTemplateCode: 'BCS-NEUTRAL-1', preparedById: memberId } })
    const [a, b] = [await run('2026-11-13'), await run('2026-11-20')]
    const itemB = await prisma.paymentRunItem.create({ data: { organizationId: orgId, paymentRunId: b.id, supplierId } })
    const itemOther = await prisma.paymentRunItem.create({ data: { organizationId: orgId, paymentRunId: a.id, supplierId: otherSupplierId } })
    const po = await prisma.purchaseOrder.create({ data: { organizationId: orgId, supplierId, status: 'SENT', number: `PO-${randomUUID().slice(0, 8)}` } })
    const invoice = await prisma.invoice.create({ data: { organizationId: orgId, poId: po.id, supplierId, channel: 'UPLOAD' } })
    const link = { organizationId: orgId, docKind: 'INVOICE' as const, invoiceId: invoice.id, payableSatang: 1n, status: 'RELEASED' as const }
    // run A, item of run B
    await expect(prisma.paymentRunDocument.create({ data: { ...link, paymentRunId: a.id, paymentRunItemId: itemB.id } })).rejects.toThrow()
    // an invoice of one supplier in another supplier's item
    await expect(prisma.paymentRunDocument.create({ data: { ...link, paymentRunId: a.id, paymentRunItemId: itemOther.id } })).rejects.toThrow()
    await expect(prisma.paymentRunDocument.create({ data: { ...link, paymentRunId: b.id, paymentRunItemId: itemB.id } })).resolves.toBeTruthy()
  })

  it('refuses a payee name with a control character in the snapshot', async () => {
    const runId = (await prisma.paymentRun.create({ data: { organizationId: orgId, payDate: new Date('2026-11-27T00:00:00Z'), payerBankAccountId: payerId, fileTemplateCode: 'BCS-NEUTRAL-1', preparedById: memberId } })).id
    await expect(prisma.paymentRunItem.create({ data: { organizationId: orgId, paymentRunId: runId, supplierId, payeeAccountName: 'บริษัท ก\r\nจำกัด' } })).rejects.toThrow()
  })

  it('[INV-PAY-03] the app role may neither delete nor truncate bank files', async () => {
    const rows = await prisma.$queryRaw<Array<{ privilege_type: string }>>`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'bcs_app' AND table_name = 'PaymentFile'`
    const privileges = rows.map((r) => r.privilege_type)
    expect(privileges).not.toContain('DELETE')
    expect(privileges).not.toContain('TRUNCATE')
    expect(privileges).toContain('UPDATE')
  })
})

describe('S9 review of the lane: the accounts a run pays from and into', () => {
  const run = (payerBankAccountId: string, day: string) => ({ organizationId: orgId, payDate: new Date(`${day}T00:00:00Z`), payerBankAccountId, fileTemplateCode: 'BCS-NEUTRAL-1', preparedById: memberId })

  it('[BR-PAY-01] pays a run only from an ACTIVE account of the organization', async () => {
    const closed = await prisma.bankAccount.create({ data: { organizationId: orgId, ownerKind: 'ORGANIZATION', code: 'CB-07', bankCode: '004', accountNo: '9991000018', accountName: 'บริษัททดสอบ', accountType: 'SAVINGS', status: 'CLOSED' } })
    await expect(prisma.paymentRun.create({ data: run(closed.id, '2026-12-04') })).rejects.toThrow()
    const ok = await prisma.paymentRun.create({ data: run(payerId, '2026-12-04') })
    await expect(prisma.paymentRun.update({ where: { id: ok.id }, data: { payerBankAccountId: closed.id } })).rejects.toThrow()
  })

  it('[BR-PAY-05] pays an item only into an account of its own supplier', async () => {
    const runId = (await prisma.paymentRun.create({ data: run(payerId, '2026-12-11') })).id
    const own = await prisma.bankAccount.create({ data: supplierAccount({ status: 'SUPERSEDED', accountNo: '9222222222' }) })
    const others = await prisma.bankAccount.create({ data: supplierAccount({ supplierId: otherSupplierId, status: 'SUPERSEDED', accountNo: '9333333333' }) })
    const item = { organizationId: orgId, paymentRunId: runId, supplierId }
    await expect(prisma.paymentRunItem.create({ data: { ...item, bankAccountId: others.id } })).rejects.toThrow()
    await expect(prisma.paymentRunItem.create({ data: { ...item, bankAccountId: payerId } })).rejects.toThrow()
    const ok = await prisma.paymentRunItem.create({ data: { ...item, bankAccountId: own.id } })
    await expect(prisma.paymentRunItem.update({ where: { id: ok.id }, data: { bankAccountId: others.id } })).rejects.toThrow()
  })
})
