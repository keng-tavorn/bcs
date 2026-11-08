import { describe, expect, it } from 'vitest'
import { headerOf } from '@/app/portal/[org]/api/invoices/form'

// S7-12 (BR-SUP ข้อ 15): what the portal's invoice forms send — the header as typed (commas out), and on the invoice's page
// the lines by PO line (a line without a quantity is not on the invoice); invoice.update checks the words again.

const form = (entries: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}
const A = '0195f3a0-1111-7aaa-8bbb-000000000001'
const B = '0195f3a0-1111-7aaa-8bbb-000000000002'

describe('[FR-AP-101/AC7] the portal invoice form', () => {
  it('reads the header with thousands commas and the VAT flag', () => {
    expect(headerOf(form({ supplierInvoiceNo: ' S00277/A ', invoiceDate: '2026-11-02', statedVat: '7,000.00', priceIncludesVat: 'on' }))).toEqual({
      ok: true,
      data: { supplierInvoiceNo: 'S00277/A', invoiceDate: '2026-11-02', statedVat: '7000.00', priceIncludesVat: true },
    })
  })

  it('refuses a missing number, a bad date or an amount with three decimals', () => {
    expect(headerOf(form({ supplierInvoiceNo: '', invoiceDate: '2026-11-02', statedVat: '0' }))).toEqual({ ok: false, reason: 'INVOICE_NO' })
    expect(headerOf(form({ supplierInvoiceNo: 'X', invoiceDate: '02/11/2026', statedVat: '0' }))).toEqual({ ok: false, reason: 'INVOICE_DATE' })
    expect(headerOf(form({ supplierInvoiceNo: 'X', invoiceDate: '2026-11-02', statedVat: '1.234' }))).toEqual({ ok: false, reason: 'AMOUNT' })
  })

  it('the lines: a quantity of zero or none leaves the line out; no line at all is refused; text in a price is refused', () => {
    const base = { supplierInvoiceNo: 'X', invoiceDate: '2026-11-02', statedVat: '70.00' }
    expect(headerOf(form({ ...base, [`line.${A}.qty`]: '4', [`line.${A}.price`]: '25,000.00', [`line.${B}.qty`]: '0', [`line.${B}.price`]: '10.00' }), true)).toEqual({
      ok: true,
      data: { ...base, priceIncludesVat: false, lines: [{ poLineId: A, quantity: '4', unitPrice: '25000.00' }] },
    })
    expect(headerOf(form({ ...base, [`line.${A}.qty`]: '0.000' }), true)).toEqual({ ok: false, reason: 'NO_LINES' })
    expect(headerOf(form({ ...base, [`line.${A}.qty`]: '1', [`line.${A}.price`]: 'abc' }), true)).toEqual({ ok: false, reason: 'LINE' })
    expect(headerOf(form({ ...base, 'line.not-a-uuid.qty': '1', [`line.${A}.qty`]: '2', [`line.${A}.price`]: '1.00' }), true)).toMatchObject({ ok: true, data: { lines: [{ poLineId: A }] } })
  })
})
