import { describe, expect, it } from 'vitest'
import { buildNeutralFile, maskAccount, normalizeAccount, precheckRun, readNeutralFile, type NeutralItem, type PrecheckItem } from '@/core/bankfile'

// src/core/bankfile beyond the golden cases of bank-account.yaml, bank-precheck.yaml and bankfile-neutral.yaml (S9-03):
// the separators and the order of the account checks, the items the pre-check may meet, and the file read back.

describe('[FR-PAY-102/AC8] an account number as BR-SUP-07 keeps it', () => {
  it('takes the passbook dashes and spaces, but no other separator', () => {
    expect(normalizeAccount({ bankCode: '004', accountNo: '999 1-00 001-6' })).toEqual({ ok: true, accountNo: '9991000016', masked: '••••••0016' })
    expect(normalizeAccount({ bankCode: '004', accountNo: '999\t1000016' })).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: 'ACCOUNT_NO_FORMAT' })
    // dashes and spaces only are a number of no digits: its length is wrong, not what it is made of
    expect(normalizeAccount({ bankCode: '004', accountNo: '' })).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: 'ACCOUNT_NO_LENGTH' })
    expect(normalizeAccount({ bankCode: '004', accountNo: '- -' })).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: 'ACCOUNT_NO_LENGTH' })
  })

  it('says what the number is made of before its length, then the bank, then the name', () => {
    expect(normalizeAccount({ bankCode: '999', accountNo: 'A1', accountName: 'ก\n' })).toMatchObject({ reason: 'ACCOUNT_NO_FORMAT' })
    expect(normalizeAccount({ bankCode: '999', accountNo: '1', accountName: 'ก\n' })).toMatchObject({ reason: 'ACCOUNT_NO_LENGTH' })
    expect(normalizeAccount({ bankCode: '999', accountNo: '9991000016', accountName: 'ก\n' })).toMatchObject({ reason: 'BANK_CODE_UNKNOWN' })
    expect(normalizeAccount({ bankCode: '004', accountNo: '9991000016', accountName: 'บริษัท ก จำกัด\u0085' })).toMatchObject({ reason: 'ACCOUNT_NAME_FORMAT' })
    expect(normalizeAccount({ bankCode: '004', accountNo: '9991000016', accountName: 'บริษัท ก, "จำกัด"' })).toMatchObject({ ok: true })
  })

  it('masks every digit but the last four, and a short number not at all', () => {
    expect(maskAccount('920123456789')).toBe('••••••••6789')
    expect(maskAccount('123')).toBe('123')
  })
})

const account = { bankCode: '006', accountNo: '9123456780', accountName: 'บริษัท ก จำกัด' }
const item = (seq: number, over: Partial<PrecheckItem> = {}): PrecheckItem => ({ seq, supplierCode: `SP000${seq}`, transferSatang: 100n, snapshot: account, register: { ...account, status: 'ACTIVE' }, documents: [{ id: `INV-${seq}`, heldByThisRun: true }], ...over })
const run = (over = {}) => ({ totalTransferSatang: 200n, itemCount: 2, payerStatus: 'ACTIVE', payerTemplateCode: 'BCS-NEUTRAL-1', runTemplateCode: 'BCS-NEUTRAL-1', ...over })

describe('[FR-PAY-102/AC2] the pre-check lists every failure in the order of BR-BANK-06', () => {
  it('refuses a payer whose template is no longer the one the run took', () => {
    expect(precheckRun(run({ payerTemplateCode: 'KBANK-X' }), [item(1), item(2)]).failures).toEqual([{ check: 'PAYER_ACCOUNT_INVALID' }])
  })

  it('reads the items in seq order whatever order they come in, and an account gone from the register as not ACTIVE', () => {
    const r = precheckRun(run(), [item(2, { register: null }), item(1, { snapshot: { ...account, bankCode: '014', accountName: 'อื่น' } })])
    expect(r.failures).toEqual([
      { seq: 1, check: 'ACCOUNT_MISMATCH', field: 'bankCode' },
      { seq: 1, check: 'ACCOUNT_MISMATCH', field: 'accountName' },
      { seq: 2, check: 'ACCOUNT_NOT_ACTIVE' },
    ])
  })

  it('names a document twice in one item, and every document not held by this run, each failure once', () => {
    const r = precheckRun(run({ itemCount: 1, totalTransferSatang: 100n }), [item(1, { documents: [{ id: 'INV-1', heldByThisRun: true }, { id: 'INV-1', heldByThisRun: false }, { id: 'INV-1', heldByThisRun: false }] })])
    expect(r).toEqual({ ok: false, failures: [{ seq: 1, check: 'DUPLICATE_DOCUMENT_IN_RUN', document: 'INV-1' }, { seq: 1, check: 'DOCUMENT_NOT_HELD', document: 'INV-1' }] })
  })
})

const neutralRun = { number: 'PAY-2569-00009', fileVersion: 1, valueDate: '2026-10-16', payer: { bankCode: '004', accountNo: '9991000016' } }
const line = (seq: number, amountSatang: bigint, accountName = 'บริษัท ก จำกัด'): NeutralItem => ({ seq, bankCode: '006', accountNo: '9123456780', accountName, amountSatang, supplierCode: `SP${seq}` })

describe('[FR-PAY-102/AC1] [FR-PAY-102/AC3] the neutral file', () => {
  it('writes its rows in seq order, a reference of four digits past seq 999, and reads them back', () => {
    const { text } = buildNeutralFile({ run: neutralRun, items: [line(1000, 250n), line(2, 1n)] })
    expect(text.split('\r\n')[1]).toBe('D,2,006,9123456780,บริษัท ก จำกัด,0.01,SP2,PAY-2569-00009-002')
    expect(text.split('\r\n')[2]).toBe('D,1000,006,9123456780,บริษัท ก จำกัด,2.50,SP1000,PAY-2569-00009-1000')
    expect(readNeutralFile(text)).toEqual({ header: { count: 2, totalSatang: 251n }, details: { count: 2, totalSatang: 251n }, trailer: { count: 2, totalSatang: 251n } })
  })

  it('writes a run without items as its H and T rows only', () => {
    const { text } = buildNeutralFile({ run: neutralRun, items: [] })
    expect(text).toBe('H,BCS-NEUTRAL-1,NOT-A-BANK-FORMAT,PAY-2569-00009,1,2026-10-16,004,9991000016,0,0.00\r\nT,0,0.00\r\n')
  })

  it('refuses a row that transfers nothing', () => {
    expect(() => buildNeutralFile({ run: neutralRun, items: [line(1, 0n)] })).toThrow(RangeError)
  })

  it('reads a quoted name with commas and doubled quotes as one field', () => {
    const { text } = buildNeutralFile({ run: neutralRun, items: [line(1, 100n, 'หจก. ช่าง "เอ", สาขา 2'), line(2, 5n, ',"')] })
    expect(readNeutralFile(text).details).toEqual({ count: 2, totalSatang: 105n })
  })

  it.each([
    ['without its last line ending', 'H,BCS-NEUTRAL-1,NOT-A-BANK-FORMAT,P,1,2026-10-16,004,1,0,0.00\r\nT,0,0.00'],
    ['with a quoted field left open', 'H,BCS-NEUTRAL-1,NOT-A-BANK-FORMAT,P,1,2026-10-16,004,1,0,0.00\r\nD,1,006,1,"ก,0.01,S,P-001\r\nT,1,0.01\r\n'],
    ['with text after a closing quote', 'H,BCS-NEUTRAL-1,NOT-A-BANK-FORMAT,P,1,2026-10-16,004,1,0,0.00\r\nD,1,006,1,"ก"x,0.01,S,P-001\r\nT,1,0.01\r\n'],
    ['without its H row', 'D,1,006,1,ก,0.01,S,P-001\r\nT,1,0.01\r\n'],
    ['with an H row of other fields', 'H,BCS-NEUTRAL-1\r\nT,0,0.00\r\n'],
    ['without its T row', 'H,BCS-NEUTRAL-1,NOT-A-BANK-FORMAT,P,1,2026-10-16,004,1,0,0.00\r\n'],
    ['with a T row of other fields', 'H,BCS-NEUTRAL-1,NOT-A-BANK-FORMAT,P,1,2026-10-16,004,1,0,0.00\r\nT,0\r\n'],
    ['with a row between that is not a D row', 'H,BCS-NEUTRAL-1,NOT-A-BANK-FORMAT,P,1,2026-10-16,004,1,0,0.00\r\nX,1,006,1,ก,0.01,S,P-001\r\nT,1,0.01\r\n'],
    ['with a D row of other fields', 'H,BCS-NEUTRAL-1,NOT-A-BANK-FORMAT,P,1,2026-10-16,004,1,0,0.00\r\nD,1,0.01\r\nT,1,0.01\r\n'],
  ])('refuses to read a file %s', (_label, text) => {
    expect(() => readNeutralFile(text)).toThrow(RangeError)
  })
})
