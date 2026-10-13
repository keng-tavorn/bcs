import { describe, expect, it } from 'vitest'
import { fieldConfidence, mapDeliveryNote, mapQuotation, verifyReading, type ReadingToCheck } from '@/core/ai-checks'
import { loadGolden } from './support'

// tests/golden/ai-verify.yaml ai-confidence.yaml ai-quotation-map.yaml ai-dn-map.yaml (spec §12.6, BR-AI-14 BR-AI-15
// BR-AI-16 BR-AI-25): GC-AI-22 to GC-AI-74. The runner applies `set` by path, builds the context and compares only the
// keys of expect, lists of codes and paths as sets.

type Obj = Record<string, unknown>

function applySet<T>(base: T, changes: Obj | undefined): T {
  const out = structuredClone(base) as Obj
  for (const [key, value] of Object.entries(changes ?? {})) {
    const parts = key.split('.')
    let o: Obj | unknown[] = out
    for (const p of parts.slice(0, -1)) o = (Array.isArray(o) ? o[Number(p)] : (o[p] ??= {})) as Obj | unknown[]
    const last = parts.at(-1)!
    if (Array.isArray(o)) o[Number(last)] = value
    else o[last] = value
  }
  return out as T
}

function expectSubset(got: Obj, expected: Obj, id: string) {
  for (const [k, v] of Object.entries(expected)) {
    if (['fail', 'warn', 'skip', 'flagged'].includes(k)) expect([...((got[k] as string[]) ?? [])].sort(), `${id} ${k}`).toEqual([...(v as string[])].sort())
    else if (v && typeof v === 'object' && !Array.isArray(v)) expect(got[k], `${id} ${k}`).toMatchObject(v as Obj)
    else expect(got[k], `${id} ${k}`).toEqual(v)
  }
}

interface Case {
  id: string
  title?: string
  input: Obj
  expect: Obj
}

describe('[BR-AI-14] [BR-AI-15] golden ai-verify.yaml', () => {
  const suite = loadGolden('ai-verify') as unknown as {
    fixture: { rates: Array<{ code: string; rateBp: number; effectiveFrom: string; effectiveTo: string }>; orgTaxId: string; now: string; suppliers: Record<string, { taxId: string; branch: string; vatRegistered: boolean }>; bases: Record<string, Obj> }
    cases: Case[]
  }
  const fx = suite.fixture
  const registry = Object.values(fx.suppliers)
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`, () => {
      const doc = applySet(fx.bases[c.input.base as string]!, c.input.set as Obj | undefined) as Obj & ReadingToCheck & { supplier?: string | null }
      const supplier = doc.supplier ? fx.suppliers[doc.supplier]! : null
      const got = verifyReading(doc, { rates: fx.rates, orgTaxId: fx.orgTaxId, now: new Date((c.input.now as string | undefined) ?? fx.now), supplier, registry })
      const result: Obj = { ...got, normalized: { lines: got.normalized.lines.length, discountTotal: got.normalized.discountTotal } }
      expectSubset(result, c.expect, c.id)
    })
  }
})

describe('[BR-AI-16] golden ai-confidence.yaml', () => {
  const suite = loadGolden('ai-confidence') as unknown as { fixture: { minConfidenceBp: number; critical: string[] }; cases: Case[] }
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`, () => {
      const i = c.input as { field: string; modelConfidence: number; check: 'PASS' | 'WARN' | 'FAIL' | null }
      expectSubset(fieldConfidence({ ...i, minConfidenceBp: suite.fixture.minConfidenceBp, critical: suite.fixture.critical }), c.expect, c.id)
    })
  }
})

describe('[BR-AI-25] golden ai-quotation-map.yaml', () => {
  const suite = loadGolden('ai-quotation-map') as unknown as {
    fixture: { vatRateBp: number; fileId: string; registry: Record<string, { taxId: string; branch: string; nameTh: string }>; readings: Record<string, Obj> }
    cases: Case[]
  }
  const fx = suite.fixture
  const registry = Object.entries(fx.registry).map(([id, s]) => ({ id, ...s }))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`, () => {
      const reading = applySet(fx.readings[c.input.reading as string]!, c.input.set as Obj | undefined) as Obj & ReadingToCheck
      const checks = (c.input.checks as { fail?: never[]; warn?: never[] } | undefined) ?? {}
      // The lines as the checks normalized them: a negative line is a discount (BR-AI-14)
      const negative = reading.lines.filter((l) => (l.amount ?? '').startsWith('-'))
      const normalized = { lines: reading.lines.filter((l) => !negative.includes(l)), discountTotal: reading.discountTotal ?? (negative.length ? 'NEGATIVE_LINE' : null) }
      const got = mapQuotation(reading, checks, { fileId: fx.fileId, vatRateBp: fx.vatRateBp, registry, normalized })
      expectSubset(got as unknown as Obj, c.expect, c.id)
    })
  }
})

describe('[BR-AI-25] golden ai-dn-map.yaml', () => {
  const suite = loadGolden('ai-dn-map') as unknown as { fixture: { poLines: Array<{ lineNo: number; uom: string; openQty: string }> }; cases: Case[] }
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`, () => {
      const got = mapDeliveryNote(c.input.dnLines as never, suite.fixture.poLines)
      expect(got).toEqual(c.expect)
    })
  }
})

describe('[BR-AI-14] the checks of a reading that the golden suites leave out', () => {
  const ctx = { rates: [{ code: 'VAT_STANDARD', rateBp: 700, effectiveFrom: '2026-10-01', effectiveTo: '2027-09-30' }], orgTaxId: '0999997000015', now: new Date('2026-10-11T03:00:00Z'), supplier: null, registry: [] }
  it('reads amounts with thousands separators, lines without a price, a quotation with VAT inside and no date', () => {
    const r = verifyReading(
      { docType: 'QUOTATION', docDate: '2026-10-10', priceIncludesVat: true, lines: [{ qty: '2', unitPrice: '1,070.00', amount: '2,140.00' }, { qty: null, unitPrice: null, amount: null }], net: '2000.00', vat: '140.00', gross: '2140.00' },
      ctx,
    )
    expect(r).toMatchObject({ status: 'PASS', computed: { gross: '2140.00', vat: '140.00', net: '2000.00' } })
    // Without a date there is no rate to apply: VAT is confirmed by the person
    const undated = verifyReading({ docType: 'QUOTATION', lines: [{ qty: '1', unitPrice: '100.00', amount: '100.00' }], net: '100.00', vat: '7.00', gross: '107.00' }, ctx)
    expect(undated).toMatchObject({ status: 'FAIL', fail: ['VAT_RATE_MISSING'], computed: { net: '100.00' } })
    // VAT not read: nothing to compare, the computed VAT is still shown
    const noVat = verifyReading({ docType: 'QUOTATION', docDate: '2026-10-10', lines: [{ qty: '1', unitPrice: '100.00', amount: '100.00' }], net: '100.00', vat: null, gross: null }, ctx)
    expect(noVat).toMatchObject({ status: 'PASS', computed: { net: '100.00', vat: '7.00', gross: '107.00' } })
    expect(noVat.vatDiff).toBeUndefined()
    const noRate = verifyReading({ docType: 'QUOTATION', priceIncludesVat: true, docDate: '2030-01-01', lines: [{ qty: '1', unitPrice: '107.00', amount: '107.00' }], net: '100.00', vat: '7.00', gross: '107.00' }, { ...ctx, now: new Date('2030-01-02T00:00:00Z') })
    expect(noRate.fail).toEqual(['VAT_RATE_MISSING'])
    expect(noRate.computed).toEqual({ gross: '107.00' })
    const noTotals = verifyReading({ docType: 'QUOTATION', lines: [{ qty: '1', unitPrice: 'abc', amount: '5.00' }], net: null, vat: null, gross: '5.00' }, ctx)
    expect(noTotals.fail).toContain('NET_TOTAL')
    const bad = verifyReading({ docType: 'QUOTATION', lines: [{ qty: '-1', unitPrice: '5.00', amount: '-5.00' }], net: '0.00', vat: '0.00', gross: '0.00', seller: { taxId: null } }, { ...ctx, supplier: { taxId: '0999998010561', branch: '00000', vatRegistered: true } })
    expect(bad.fail).toContain('SELLER_MATCH')
    // A seller read without a branch is the head office when the register is searched (no supplier of the context)
    const headOffice = verifyReading(
      { docType: 'QUOTATION', docDate: '2026-10-10', seller: { taxId: '3999998020014', branch: null }, lines: [{ qty: '1', unitPrice: '100.00', amount: '100.00' }], net: '100.00', vat: '7.00', gross: '107.00' },
      { ...ctx, registry: [{ taxId: '3999998020014', branch: '00000', vatRegistered: false }] },
    )
    expect(headOffice).toMatchObject({ fail: ['NON_VAT_SELLER'], computed: { net: '100.00', vat: '0.00', gross: '100.00' } })
  })
  it('maps nothing of another currency, and a quotation without a seller or a total', () => {
    expect(mapQuotation({ docType: 'QUOTATION', lines: [] }, { fail: ['CURRENCY'] }, { fileId: 'F', vatRateBp: 700, registry: [], normalized: { lines: [], discountTotal: null } })).toMatchObject({ quotation: null, lines: null })
    const blank = mapQuotation({ docType: 'QUOTATION', lines: [], net: null, seller: null }, {}, { fileId: 'F', vatRateBp: 700, registry: [], normalized: { lines: [{ qty: null, unit: null, unitPrice: null }], discountTotal: null } })
    expect(blank).toMatchObject({ quotation: { supplierId: null, supplierName: null, amount: null }, quoteNet: null, flags: ['SUPPLIER_NOT_REGISTERED'], lines: [{ qty: null, uom: null, unitPrice: null }] })
    const noBranch = mapQuotation({ docType: 'QUOTATION', lines: [], net: '100.00', seller: { taxId: '0999998010561', branch: null } }, {}, { fileId: 'F', vatRateBp: 700, registry: [{ id: 'S1', taxId: '0999998010561', branch: '00000', nameTh: 'ร้านหนึ่ง' }], normalized: { lines: [], discountTotal: null } })
    expect(noBranch).toMatchObject({ quotation: { supplierId: 'S1', amount: '100.00' }, flags: [] })
  })
})
