import { describe, expect, it } from 'vitest'
import { approveVariance, checkInvoiceVat, findDuplicates, invoiceLineNets, matchInvoice, type MatchPoLine } from '@/core/matching'

// core/matching beyond the golden cases (spec §7.0 item 4: every branch has a test)

const policy = { priceTolBp: 100, priceTolSatang: 100_000n, qtyTolBp: 0, vatRateBp: 700 }
const po = (line: number, over: Partial<MatchPoLine> = {}): MatchPoLine => ({ line, ordered: '10', unitPriceSatang: 10_000n, accepted: '10', invoiced: '0', heldSatang: 100_000n, budgetLine: 'BL-A', ...over })

describe('matchInvoice', () => {
  it('refuses an invoice line on a PO line that is not on the PO, and a PO line twice', () => {
    expect(() => matchInvoice({ kind: 'GOODS', poLines: [po(1)], available: {}, invoice: { lines: [{ poLine: 2, qty: '1', unitPriceSatang: 1n }] } }, policy)).toThrow(RangeError)
    expect(() =>
      matchInvoice({ kind: 'GOODS', poLines: [po(1)], available: {}, invoice: { lines: [{ poLine: 1, qty: '1', unitPriceSatang: 1n }, { poLine: 1, qty: '1', unitPriceSatang: 1n }] } }, policy),
    ).toThrow(RangeError)
  })

  it('refuses a discount below zero or above the invoice amount', () => {
    const lines = [{ poLine: 1, qty: '1', unitPriceSatang: 100n }]
    expect(() => invoiceLineNets({ lines, discountSatang: -1n }, 700)).toThrow(RangeError)
    expect(() => invoiceLineNets({ lines, discountSatang: 101n }, 700)).toThrow(RangeError)
  })

  it('takes the VAT out of an invoice priced with VAT before it compares (BR-MATCH-06)', () => {
    const r = matchInvoice({ kind: 'GOODS', poLines: [po(1)], available: { 'BL-A': 0n }, invoice: { priceIncludesVat: true, lines: [{ poLine: 1, qty: '10', unitPriceSatang: 10_700n }] } }, policy)
    expect(r).toMatchObject({ result: 'MATCHED', netSatang: 100_000n })
  })

  it('applies the quantity tolerance to goods (qtyTolBp)', () => {
    const input = { kind: 'GOODS' as const, poLines: [po(1, { accepted: '100', ordered: '100', heldSatang: 1_020_000n })], available: { 'BL-A': 0n }, invoice: { lines: [{ poLine: 1, qty: '102', unitPriceSatang: 10_000n }] } }
    expect(matchInvoice(input, policy).result).toBe('EXCEPTION')
    expect(matchInvoice(input, { ...policy, qtyTolBp: 200 }).result).toBe('MATCHED')
  })

  it('the last invoice of a closed PO gives back what every line still holds, invoiced or not (BR-MATCH-11)', () => {
    const r = matchInvoice(
      { kind: 'GOODS', poClosed: true, poLines: [po(1), po(2, { budgetLine: 'BL-B' })], available: {}, invoice: { isFinal: true, lines: [{ poLine: 1, qty: '10', unitPriceSatang: 10_000n }] } },
      policy,
    )
    expect(r.budget).toEqual([
      { budgetLine: 'BL-A', holdMoreSatang: 0n, actualSatang: 100_000n, releaseSatang: 0n },
      { budgetLine: 'BL-B', holdMoreSatang: 0n, actualSatang: 0n, releaseSatang: 100_000n },
    ])
    // a last invoice on a PO still open gives back nothing (the PO's closing does)
    const open = matchInvoice({ kind: 'GOODS', poLines: [po(1)], available: {}, invoice: { isFinal: true, lines: [{ poLine: 1, qty: '5', unitPriceSatang: 10_000n }] } }, policy)
    expect(open.budget[0]!.releaseSatang).toBe(0n)
  })

  it('names the line with the largest variance for the DOA department, the lower line on a tie (BR-AP-06)', () => {
    const lines = [po(1), po(2, { budgetLine: 'BL-B' }), po(3, { budgetLine: 'BL-C' })]
    const over = (price: bigint) => price
    const r = matchInvoice(
      { kind: 'GOODS', poLines: lines, available: {}, invoice: { lines: [{ poLine: 1, qty: '10', unitPriceSatang: over(11_000n) }, { poLine: 2, qty: '10', unitPriceSatang: over(12_000n) }, { poLine: 3, qty: '10', unitPriceSatang: over(12_000n) }] } },
      policy,
    )
    expect(r.doaAmount).toEqual({ netSatang: 50_000n, vatSatang: 3_500n, line: 2 })
  })

  it('has no DOA amount when another type is open next to a price variance', () => {
    const r = matchInvoice({ kind: 'GOODS', poLines: [po(1, { accepted: '5' })], available: {}, invoice: { lines: [{ poLine: 1, qty: '10', unitPriceSatang: 12_000n }] } }, policy)
    expect(r.exceptions.map((e) => e.type)).toEqual(['PRICE_OVER', 'QTY_NOT_RECEIVED'])
    expect(r.doaAmount).toBeNull()
  })

  it('a service invoiced in part against confirmed work matches', () => {
    const r = matchInvoice({ kind: 'SERVICE', poLines: [po(1, { accepted: '4' })], available: {}, invoice: { lines: [{ poLine: 1, qty: '4', unitPriceSatang: 10_000n }] } }, policy)
    expect(r.result).toBe('MATCHED')
  })

  it('reports quantities with their decimals', () => {
    const r = matchInvoice({ kind: 'GOODS', poLines: [po(1, { accepted: '1.5' })], available: {}, invoice: { lines: [{ poLine: 1, qty: '2.25', unitPriceSatang: 10_000n }] } }, policy)
    expect(r.exceptions[0]).toMatchObject({ type: 'QTY_NOT_RECEIVED', quantity: '0.75', amountSatang: 7_500n })
  })
})

describe('approveVariance', () => {
  it('refuses a line on a PO line that is not on the PO, and holds nothing on an exact invoice', () => {
    expect(() => approveVariance({ poLines: [{ line: 1, heldSatang: 1n, budgetLine: 'A' }], available: {}, invoice: { lines: [{ poLine: 9, qty: '1', unitPriceSatang: 1n }] } })).toThrow(RangeError)
    expect(approveVariance({ poLines: [{ line: 1, heldSatang: 100n, budgetLine: 'A' }], available: {}, invoice: { lines: [{ poLine: 1, qty: '1', unitPriceSatang: 100n }] } })).toEqual({
      ok: true,
      budget: [{ budgetLine: 'A', holdMoreSatang: 0n, actualSatang: 100n, releaseSatang: 0n }],
      poLineMoves: [{ poLine: 1, budgetLine: 'A', holdMoreSatang: 0n, actualSatang: 100n, releaseSatang: 0n }],
    })
  })
})

describe('findDuplicates', () => {
  const doc = { supplier: 'S', taxId: '0105555000011', invoiceNo: 'A1', invoiceDate: '2026-10-05', grossSatang: 100n }
  it('ignores drafts, and a supplier without a tax id has no possible duplicates', () => {
    expect(findDuplicates(doc, [{ ...doc, table: 'INVOICE', status: 'DRAFT' }])).toEqual({ hard: null, soft: [] })
    expect(findDuplicates({ ...doc, taxId: null, invoiceNo: 'A2' }, [{ ...doc, taxId: null, table: 'INVOICE', status: 'PAID' }])).toEqual({ hard: null, soft: [] })
  })
  it('counts days either way and refuses a malformed date', () => {
    expect(findDuplicates({ ...doc, invoiceNo: 'A2', invoiceDate: '2026-10-02' }, [{ ...doc, table: 'INVOICE', status: 'PAID' }]).soft).toEqual([{ invoiceNo: 'A1', days: 3 }])
    expect(() => findDuplicates({ ...doc, invoiceNo: 'A2', invoiceDate: '5/10/2026' }, [{ ...doc, table: 'INVOICE', status: 'PAID' }])).toThrow(RangeError)
  })
})

describe('checkInvoiceVat', () => {
  const base = { rateBp: 700, lines: [{ qty: '1', unitPriceSatang: 100_000n }], statedVatSatang: 7_000n, vatTolSatang: 100n }
  it('a ceased supplier keeps the rate but may not charge VAT (BR-VAT-06)', () => {
    expect(checkInvoiceVat({ ...base, supplierVat: 'REGISTRY_CEASED' })).toMatchObject({ rateBp: 700, computedVatSatang: 7_000n, status: 'VAT_SUPPLIER_NOT_REGISTERED' })
    expect(checkInvoiceVat({ ...base, supplierVat: 'REGISTRY_CEASED', statedVatSatang: 0n })).toMatchObject({ status: 'VAT_MISMATCH' })
  })
  it('refuses a discount outside zero to the invoice amount', () => {
    expect(() => checkInvoiceVat({ ...base, supplierVat: 'REGISTERED', discountSatang: -1n })).toThrow(RangeError)
    expect(() => checkInvoiceVat({ ...base, supplierVat: 'REGISTERED', discountSatang: 100_001n })).toThrow(RangeError)
  })
})
