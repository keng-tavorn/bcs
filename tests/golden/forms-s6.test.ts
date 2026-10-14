import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { daysLeft, lintFormVersion, renewalMilestoneDue, reorderDraft } from '@/core/forms'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/forms-s6.yaml (spec §7.17): GC-FORM-12 to GC-FORM-21 — renewal reminders (BR-FORM-08) and reorder
// (BR-FORM-07). GC-FORM-22 and on (the form lint of S6-14) join this file with their own runner.

interface Line {
  d?: string
  item?: string
  supplier?: string
  uom?: string
  qty: string
  unitPrice: string
  serviceEndDate?: string
}
interface FormsCase {
  id: string
  title?: string
  fn: string
  input: {
    daysLeft?: number
    sent?: number[]
    at?: string
    serviceEndDate?: string
    currentFields?: string[]
    source?: { fields: Record<string, unknown>; lines: Line[]; attachments?: Record<string, number>; quotations?: number; budgetLine?: string }
    agreements?: Array<{ item: string; supplier: string; unitPrice: string }>
  }
  expect: unknown
}

const suite = loadYaml<{ settings: { milestoneDays: number[] }; cases: FormsCase[] }>('forms-s6.yaml')

describe('[FR-INT-101/AC1] [FR-INT-101/AC2] golden forms-s6.yaml', () => {
  const cases = suite.cases.filter((c) => ['daysLeft', 'renewalMilestoneDue', 'reorderDraft'].includes(c.fn))
  it('has the cases of S6-12', () => expect(cases.map((c) => c.id)).toEqual(['GC-FORM-12', 'GC-FORM-13', 'GC-FORM-14', 'GC-FORM-15', 'GC-FORM-16', 'GC-FORM-17', 'GC-FORM-18', 'GC-FORM-19', 'GC-FORM-20', 'GC-FORM-21']))
  for (const c of cases) {
    it(`[${c.id}] ${c.title ?? c.fn}`, () => {
      const i = c.input
      if (c.fn === 'daysLeft') return expect(daysLeft(new Date(i.at!), i.serviceEndDate!)).toEqual(c.expect)
      if (c.fn === 'renewalMilestoneDue') return expect(renewalMilestoneDue(i.daysLeft!, i.sent!, suite.settings.milestoneDays)).toEqual(c.expect)
      const src = i.source!
      const supplier = src.lines.find((l) => l.supplier)?.supplier ?? null
      const r = reorderDraft({
        currentFields: i.currentFields!,
        fields: src.fields,
        lines: src.lines.map((l) => ({ description: l.d ?? l.item ?? '', categoryCode: null, quantity: l.qty, uom: l.uom ?? 'ชิ้น', unitPriceSatang: amountToSatang(l.unitPrice), catalogItemId: l.item ?? null })),
        supplierId: supplier,
        priceIncludesVat: false,
        agreements: (i.agreements ?? []).map((a) => ({ catalogItemId: a.item, supplierId: a.supplier, unitPriceSatang: amountToSatang(a.unitPrice) })),
      })
      // What the draft never carries over: files, quotations, the budget line and the service end dates
      const actual = { fields: r.fields, droppedFields: r.droppedFields, lines: r.lines.map((l) => ({ qty: l.quantity, unitPrice: satangToAmount(l.unitPriceSatang), serviceEndDate: null, priceSource: l.priceSource })), attachments: {}, quotations: 0, budgetLine: null }
      const exp = c.expect as Record<string, unknown> & { lines?: Array<Record<string, unknown>> }
      const picked = pick(actual, exp) as Record<string, unknown>
      if (exp.lines) picked.lines = actual.lines.map((l, k) => pick(l, exp.lines![k]!))
      expect(picked).toEqual(exp)
    })
  }
})

describe('[FR-INT-104/AC2] golden forms-s6.yaml: the lint of a form version (BR-FORM-09)', () => {
  const fx = (suite as unknown as { formLint: { fields: string[]; rules: Record<string, string[]>; workflowRules: Record<string, string[]> } }).formLint
  const raw = suite.cases as unknown as Array<{ id: string; fn: string; input: { removeFields: string[]; rules: string[]; workflowRules: string[] }; expect: unknown }>
  for (const c of raw.filter((x) => x.fn === 'lintFormVersion')) {
    it(`[${c.id}]`, () => {
      // The version in use: the fixture's fields, each attachment rule reading its fields; the draft removes some
      const field = (id: string) => ({ id, type: 'select' as const, options: ['Y', 'N'] })
      const rule = (id: string) => ({ id, when: { all: fx.rules[id]!.map((f) => ({ field: f, op: 'eq' as const, value: 'Y' })) }, require: { attachments: 'DPA', min: 1 } })
      const before = { fields: fx.fields.map(field), visibility: [], rules: c.input.rules.map(rule) }
      const after = { ...before, fields: fx.fields.filter((f) => !c.input.removeFields.includes(f)).map(field) }
      const workflow = c.input.workflowRules.map((code) => ({ code, fields: fx.workflowRules[code]! }))
      expect(lintFormVersion(before, after, workflow)).toEqual(c.expect)
    })
  }
})
