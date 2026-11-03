import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { findSavings, type OpenLine, type Opportunity, type Purchase, type SavingsAgreement } from '@/core/savings'
import { loadYaml } from './doa-fixtures'

// tests/golden/savings.yaml (spec §7.21 · NEW-123): GC-SAV-01 to GC-SAV-18, the savings the assistant finds (BR-SAV-01
// to BR-SAV-06). A line or purchase of `item` is a catalogue item keyed item:<item> (BR-DUP-01); one of `d` is keyed d.

interface Defaults {
  at: string
  today: string
  approvedAt: string
  stage: OpenLine['stage']
  dept: string
  site: string | null
  kind: OpenLine['kind']
  supplier: string | null
  qty: string
  includesVat: boolean
}
interface LineIn {
  ref: string
  item?: string
  d?: string
  stage?: OpenLine['stage']
  dept?: string
  site?: string | null
  kind?: OpenLine['kind']
  supplier?: string | null
  qty?: string
  unitPrice: string
  includesVat?: boolean
}
interface PurchaseIn {
  ref: string
  item?: string
  d?: string
  unitPrice: string
  qty?: string
  approvedAt?: string
  includesVat?: boolean
  agreement?: string
  /** What the line bought at the agreed price (default: qty) */
  agreementQty?: string
}
interface AgreementIn {
  id: string
  item: string
  supplier: string
  unitPrice: string
  validFrom: string
  validTo: string
  ended?: boolean
}
interface SavingsSuite {
  settings: { windowDays: number; minSamples: number; alertBp: number; agreementDays: number }
  defaults: Defaults
  cases: Array<{ id: string; title?: string; input: { lines?: LineIn[]; purchases?: PurchaseIn[]; agreements?: AgreementIn[] }; expect: { total: string; opportunities: Array<Record<string, unknown>> } }>
}

const suite = loadYaml<SavingsSuite>('savings.yaml')
const df = suite.defaults
const keyOf = (x: { item?: string; d?: string }) => (x.item ? `item:${x.item}` : x.d!)
const money = (s: bigint) => satangToAmount(s)

const lineOf = (l: LineIn): OpenLine => ({
  ref: l.ref,
  stage: l.stage ?? df.stage,
  key: keyOf(l),
  kind: l.kind ?? df.kind,
  departmentId: l.dept ?? df.dept,
  siteId: l.site === undefined ? df.site : l.site,
  catalogItemId: l.item ?? null,
  supplierId: l.supplier === undefined ? df.supplier : l.supplier,
  quantity: l.qty ?? df.qty,
  unitPriceSatang: amountToSatang(l.unitPrice),
  priceIncludesVat: l.includesVat ?? df.includesVat,
})

const purchaseOf = (p: PurchaseIn): Purchase => {
  const unit = amountToSatang(p.unitPrice)
  return {
    ref: p.ref,
    key: keyOf(p),
    approvedAt: new Date(p.approvedAt ?? df.approvedAt),
    unitPriceSatang: unit,
    priceIncludesVat: p.includesVat ?? false,
    agreements: p.agreement ? [{ id: p.agreement, quantity: p.agreementQty ?? p.qty ?? df.qty }] : [],
  }
}

const agreementOf = (a: AgreementIn): SavingsAgreement => ({
  id: a.id,
  catalogItemId: a.item,
  supplierId: a.supplier,
  unitPriceSatang: amountToSatang(a.unitPrice),
  validFrom: a.validFrom,
  validTo: a.validTo,
  ended: a.ended ?? false,
})

/** The opportunity as the golden file writes it */
function shown(o: Opportunity): Record<string, unknown> {
  switch (o.kind) {
    case 'PRICE_ABOVE_HISTORY':
      return { kind: o.kind, line: o.line, saving: money(o.savingSatang), reference: money(o.referenceSatang), count: o.count, purchases: o.purchases }
    case 'OFF_AGREEMENT':
      return { kind: o.kind, line: o.line, saving: money(o.savingSatang), agreement: o.agreementId, agreed: money(o.agreedSatang) }
    case 'SAME_ITEM_DEPARTMENTS':
      return { kind: o.kind, lines: o.lines.map((l) => l.ref), saving: money(o.savingSatang), lowest: money(o.lowestSatang) }
    case 'AGREEMENT_EXPIRING':
      return { kind: o.kind, agreement: o.agreementId, daysLeft: o.daysLeft, spent: money(o.spentSatang), purchases: o.purchases }
  }
}

describe('[FR-VIS-008/AC1] golden savings.yaml', () => {
  it('has the cases of NEW-123', () => expect(suite.cases.map((c) => c.id)).toEqual(Array.from({ length: 18 }, (_, i) => `GC-SAV-${String(i + 1).padStart(2, '0')}`)))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const result = findSavings(
        { lines: (c.input.lines ?? []).map(lineOf), purchases: (c.input.purchases ?? []).map(purchaseOf), agreements: (c.input.agreements ?? []).map(agreementOf) },
        { ...suite.settings, at: new Date(df.at), today: df.today },
      )
      expect({ total: money(result.totalSatang), opportunities: result.opportunities.map(shown) }).toEqual(c.expect)
    })
  }
})
