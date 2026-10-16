import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { buildItem, buildRun, checkPaidOn, checkPayDate, flagsKey, itemFlags, nextRunDate, proposeDocuments, type ItemDocument, type PayCalendar, type PaymentFlag, type PaymentPolicy } from '@/core/payment'
import { loadYaml } from './doa-fixtures'

// tests/golden/payment-run.yaml (spec §7.19, BR-PAY-02 to BR-PAY-07 and BR-PAY-12): each case read into
// src/core/payment with the calendar and policy of the suite; money as baht strings, rates in basis points.

type Raw = Record<string, unknown>
interface RawDoc { kind: 'INVOICE' | 'RETENTION'; payable: string; whtLines?: Array<{ incomeType: string; rateBp: number; base: string }> }
interface PayCase { id: string; title: string; fn: string; input: Raw; expect: unknown }

const suite = loadYaml<{ calendar: PayCalendar; policy: PaymentPolicy; cases: PayCase[] }>('payment-run.yaml')

const docsOf = (docs: RawDoc[]): ItemDocument[] =>
  docs.map((d, i) => ({ kind: d.kind, doc: `D${i + 1}`, payableSatang: amountToSatang(d.payable), whtLines: (d.whtLines ?? []).map((l) => ({ incomeType: l.incomeType, rateBp: l.rateBp, baseSatang: amountToSatang(l.base) })) }))

function run(c: PayCase): unknown {
  const i = c.input as Raw
  switch (c.fn) {
    case 'buildItem': {
      const r = buildItem(docsOf(i.docs as RawDoc[]))
      if (!r.ok) return r.code === 'PAYMENT_ITEM_NOT_POSITIVE' ? { error: r.code, transfer: satangToAmount(r.transferSatang) } : { error: r.code, reason: r.reason }
      return {
        payable: satangToAmount(r.payableSatang),
        whtLines: r.whtLines.map((l) => ({ incomeType: l.incomeType, rateBp: l.rateBp, base: satangToAmount(l.baseSatang), wht: satangToAmount(l.whtSatang) })),
        wht: satangToAmount(r.whtSatang),
        transfer: satangToAmount(r.transferSatang),
      }
    }
    case 'buildRun': {
      const r = buildRun((i.suppliers as Array<{ code: string; docs: RawDoc[] }>).map((s) => ({ code: s.code, docs: docsOf(s.docs) })))
      if (!r.ok) return { error: r.code, supplier: r.supplierCode }
      return {
        items: r.items.map((x) => ({ seq: x.seq, code: x.code, payable: satangToAmount(x.payableSatang), wht: satangToAmount(x.whtSatang), transfer: satangToAmount(x.transferSatang) })),
        totals: { payable: satangToAmount(r.totals.payableSatang), wht: satangToAmount(r.totals.whtSatang), transfer: satangToAmount(r.totals.transferSatang), itemCount: r.totals.itemCount, documentCount: r.totals.documentCount },
      }
    }
    case 'nextRunDate':
      return nextRunDate(i.today as string, suite.policy, suite.calendar)
    case 'checkPayDate': {
      const r = checkPayDate(i.payDate as string, new Date(i.at as string), suite.calendar)
      return r.ok ? { ok: true } : { error: r.code, reason: r.reason }
    }
    case 'proposeDocuments':
      return { proposed: proposeDocuments(i.payDate as string, i.docs as Array<{ id: string; kind: 'INVOICE' | 'RETENTION'; dueDate?: string }>).map((d) => d.id) }
    case 'checkPaidOn': {
      const r = checkPaidOn(i.payDate as string, i.paidOn as string, new Date(i.at as string))
      return r.ok ? { ok: true } : { error: r.code, reason: r.reason }
    }
    case 'itemFlags': {
      const r = itemFlags(i as never, suite.policy)
      return { flags: [...r.flags], requiresReason: r.requiresReason }
    }
    case 'flagsKey':
      return flagsKey(i.items as Array<{ code: string; flags: PaymentFlag[] }>)
    default:
      throw new Error(`unknown fn ${c.fn}`)
  }
}

describe('golden payment-run.yaml', () => {
  it('has the cases of the suite', () => expect(suite.cases.length).toBe(35))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, () => {
      expect(run(c)).toEqual(c.expect)
    })
  }
})
