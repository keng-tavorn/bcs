import { describe, expect, it } from 'vitest'
import { approveVariance, checkInvoiceVat, findDuplicates, matchInvoice, type MatchExceptionResult, type MatchPolicy, type SupplierVatStatus } from '@/core/matching'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/matching.yaml and tests/golden/invoice-vat.yaml (spec §7.14 BR-MATCH, §7.1 BR-VAT-05 to BR-VAT-07):
// every case, counted from the files. Money in the YAML is baht strings; the engine works in satang.

type Raw = Record<string, unknown>
interface PoLineRaw { line: number; ordered?: string; unitPrice?: string; accepted?: string; invoiced?: string; held: string; budgetLine: string }
interface InvoiceRaw { discount?: string; isFinal?: boolean; lines: Array<{ poLine: number; qty: string; unitPrice: string; vatable?: boolean }> }
interface MatchCase { id: string; title?: string; fn?: 'match' | 'duplicates' | 'approveVariance'; input: Raw; expect: Raw }

const matching = loadYaml<{ policy: { priceTolBp: number; priceTolAmount: string; qtyTolBp: number; vatRateBp: number }; cases: MatchCase[] }>('matching.yaml')
const vat = loadYaml<{ cases: Array<{ id: string; title?: string; input: Raw; expect: Raw }> }>('invoice-vat.yaml')

const baht = satangToAmount
const policyOf = (p: typeof matching.policy): MatchPolicy => ({ priceTolBp: p.priceTolBp, priceTolSatang: amountToSatang(p.priceTolAmount), qtyTolBp: p.qtyTolBp, vatRateBp: p.vatRateBp })
const invoiceOf = (i: InvoiceRaw) => ({
  ...(i.discount ? { discountSatang: amountToSatang(i.discount) } : {}),
  ...(i.isFinal ? { isFinal: true } : {}),
  lines: i.lines.map((l) => ({ poLine: l.poLine, qty: l.qty, unitPriceSatang: amountToSatang(l.unitPrice), ...(l.vatable === false ? { vatable: false } : {}) })),
})
const availableOf = (a: Record<string, string>) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, amountToSatang(v)]))
const budgetOut = (b: ReadonlyArray<{ budgetLine: string; holdMoreSatang: bigint; actualSatang: bigint; releaseSatang: bigint }>) =>
  b.map((m) => ({ budgetLine: m.budgetLine, holdMore: baht(m.holdMoreSatang), actual: baht(m.actualSatang), release: baht(m.releaseSatang) }))
const exceptionOut = (e: MatchExceptionResult) =>
  e.type === 'BUDGET_SHORT' ? { type: e.type, budgetLine: e.budgetLine, amount: baht(e.amountSatang) } : { type: e.type, line: e.line, ...(e.quantity !== null ? { qty: e.quantity } : {}), amount: baht(e.amountSatang) }

function runMatch(c: MatchCase): Raw {
  const input = c.input as { kind: 'GOODS' | 'SERVICE'; poClosed?: boolean; poLines: PoLineRaw[]; available: Record<string, string>; invoice: InvoiceRaw }
  const policy = policyOf({ ...matching.policy, ...((c.input.policy as object | undefined) ?? {}) })
  const r = matchInvoice(
    {
      kind: input.kind,
      ...(input.poClosed ? { poClosed: true } : {}),
      poLines: input.poLines.map((p) => ({ line: p.line, ordered: p.ordered!, unitPriceSatang: amountToSatang(p.unitPrice!), accepted: p.accepted!, invoiced: p.invoiced!, heldSatang: amountToSatang(p.held), budgetLine: p.budgetLine })),
      available: availableOf(input.available),
      invoice: invoiceOf(input.invoice),
    },
    policy,
  )
  const discounted = input.invoice.discount !== undefined
  return {
    result: r.result,
    lines: r.lines.map((l) => ({ line: l.line, ...(discounted ? { discount: baht(l.discountSatang) } : {}), net: baht(l.netSatang), expected: baht(l.expectedSatang), over: baht(l.overSatang), flags: [...l.flags] })),
    exceptions: r.exceptions.map(exceptionOut),
    budget: budgetOut(r.budget),
    doaAmount: r.doaAmount ? { net: baht(r.doaAmount.netSatang), vat: baht(r.doaAmount.vatSatang) } : undefined,
  }
}

function runDuplicates(c: MatchCase): Raw {
  type Doc = { supplier: string; taxId: string; invoiceNo: string; invoiceDate: string; gross: string; table?: 'INVOICE' | 'CONFIRMATION'; status?: string }
  const doc = (d: Doc) => ({ supplier: d.supplier, taxId: d.taxId, invoiceNo: d.invoiceNo, invoiceDate: d.invoiceDate, grossSatang: amountToSatang(d.gross) })
  const input = c.input as { candidate: Doc; existing: Doc[] }
  const r = findDuplicates(doc(input.candidate), input.existing.map((e) => ({ ...doc(e), table: e.table!, status: e.status! })))
  return { hard: r.hard, soft: r.soft.map((s) => ({ invoiceNo: s.invoiceNo, days: s.days })) }
}

function runApproveVariance(c: MatchCase): Raw {
  const input = c.input as { poLines: PoLineRaw[]; available: Record<string, string>; invoice: InvoiceRaw }
  const r = approveVariance({
    poLines: input.poLines.map((p) => ({ line: p.line, heldSatang: amountToSatang(p.held), budgetLine: p.budgetLine })),
    available: availableOf(input.available),
    invoice: invoiceOf(input.invoice),
    vatRateBp: matching.policy.vatRateBp,
  })
  return r.ok ? { budget: budgetOut(r.budget) } : { error: r.error, budgetLine: r.budgetLine, shortfall: baht(r.shortfallSatang) }
}

describe('[FR-AP-102/AC1] [FR-AP-105/AC1] golden matching.yaml', () => {
  it('has cases', () => expect(matching.cases.length).toBeGreaterThan(0))
  for (const c of matching.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const run = c.fn === 'duplicates' ? runDuplicates : c.fn === 'approveVariance' ? runApproveVariance : runMatch
      expect(pick(run(c), c.expect)).toEqual(c.expect)
    })
  }
})

describe('[FR-AP-104/AC1] golden invoice-vat.yaml', () => {
  it('has cases', () => expect(vat.cases.length).toBeGreaterThan(0))
  for (const c of vat.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const input = c.input as { rateBp: number; supplierVat: SupplierVatStatus; priceIncludesVat?: boolean; discount?: string; lines: Array<{ qty: string; unitPrice: string; vatable?: boolean }>; statedVat: string }
      const r = checkInvoiceVat({
        rateBp: input.rateBp,
        supplierVat: input.supplierVat,
        ...(input.priceIncludesVat ? { priceIncludesVat: true } : {}),
        ...(input.discount ? { discountSatang: amountToSatang(input.discount) } : {}),
        lines: input.lines.map((l) => ({ qty: l.qty, unitPriceSatang: amountToSatang(l.unitPrice), ...(l.vatable === false ? { vatable: false } : {}) })),
        statedVatSatang: amountToSatang(input.statedVat),
        vatTolSatang: amountToSatang('1.00'), // OQ-121 default, as the file's header says
      })
      const actual = { rateBp: r.rateBp, net: baht(r.netSatang), computedVat: baht(r.computedVatSatang), computedGross: baht(r.computedGrossSatang), invoiceGross: baht(r.invoiceGrossSatang), diff: baht(r.diffSatang), status: r.status }
      expect(pick(actual, c.expect)).toEqual(c.expect)
    })
  }
})
