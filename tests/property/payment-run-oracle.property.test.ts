import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { buildItem, buildRun, checkPaidOn, checkPayDate, flagsKey, itemFlags, nextRunDate, proposeDocuments, type BuiltItem, type ItemDocument, type PayCalendar, type PaymentFlag, type PaymentPolicy, type Weekday } from '@/core/payment'
import { loadYaml } from '../golden/doa-fixtures'
import {
  oracleBuildItem,
  oracleBuildRun,
  oracleCheckPaidOn,
  oracleCheckPayDate,
  oracleFlagsKey,
  oracleItemFlags,
  oracleNextRunDate,
  oracleProposeDocuments,
  type OracleDoc,
  type OracleItem,
} from '../support/oracles/payment-run'

// S9-02 (ADR-072): src/core/payment and a second implementation written from the spec by another agent that never saw
// the first (tests/support/oracles/payment-run.ts, which imports nothing of src) both pass every golden case of
// payment-run.yaml and give the same result, field by field, on at least 1,000 random inputs per function. The inputs
// stay inside what the services give the engine; docs/reports/p1-review-S9.md lists where the two differ outside it and
// why: payables and tax bases of S8 are never negative in phase 1 (credit notes are S9-17), a run has one item per
// supplier (BR-PAY-05), days are real calendar days, a tax id is 13 digits or none, the settings allow 0–365 days, and
// the flags are those of BR-PAY-06.

const RUNS = { numRuns: 1_000 }
const WEEKDAYS: Weekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const FLAGS: PaymentFlag[] = ['REGISTRY_CHANGED', 'SUPPLIER_INACTIVE', 'RISK_OVERRIDE_EXPIRED', 'PREVIOUSLY_EXPORTED', 'BANK_ACCOUNT_RECENTLY_CHANGED', 'BANK_CHANGE_PENDING', 'SHARED_BANK_ACCOUNT']
const DAY_MS = 86_400_000
const THAI_MS = 7 * 3_600_000
const START = Date.UTC(2025, 0, 1)

// ---------- the first implementation in the shape of the second ----------

const toItemDocs = (docs: readonly OracleDoc[]): ItemDocument[] =>
  docs.map((d, i) => ({ kind: d.kind, doc: `D${i + 1}`, payableSatang: d.payable, whtLines: d.whtLines.map((l) => ({ incomeType: l.incomeType, rateBp: l.rateBp, baseSatang: l.base })) }))

function itemOf(r: BuiltItem): OracleItem {
  if (r.ok) return { ok: true, payable: r.payableSatang, whtLines: r.whtLines.map((l) => ({ incomeType: l.incomeType, rateBp: l.rateBp, base: l.baseSatang, wht: l.whtSatang })), wht: r.whtSatang, transfer: r.transferSatang }
  return r.code === 'PAYMENT_ITEM_NOT_POSITIVE' ? { ok: false, code: r.code, transfer: r.transferSatang } : { ok: false, code: r.code, reason: r.reason }
}

function runOf(suppliers: ReadonlyArray<{ code: string; docs: readonly OracleDoc[] }>) {
  const r = buildRun(suppliers.map((s) => ({ code: s.code, docs: toItemDocs(s.docs) })))
  if (!r.ok) {
    const { supplierCode, ...failed } = r
    return { ...itemOf(failed), supplierCode }
  }
  return {
    ok: true,
    items: r.items.map((i) => ({ seq: i.seq, code: i.code, payable: i.payableSatang, wht: i.whtSatang, transfer: i.transferSatang })),
    totals: { payable: r.totals.payableSatang, wht: r.totals.whtSatang, transfer: r.totals.transferSatang, itemCount: r.totals.itemCount, documentCount: r.totals.documentCount },
  }
}

// ---------- the golden cases through the second implementation (the same reading as payment-run.test.ts) ----------

interface RawDoc { kind: 'INVOICE' | 'RETENTION'; payable: string; whtLines?: Array<{ incomeType: string; rateBp: number; base: string }> }
interface PayCase { id: string; title: string; fn: string; input: Record<string, unknown>; expect: unknown }
const suite = loadYaml<{ calendar: PayCalendar; policy: PaymentPolicy; cases: PayCase[] }>('payment-run.yaml')

const docsOf = (docs: RawDoc[]): OracleDoc[] =>
  docs.map((d) => ({ kind: d.kind, payable: amountToSatang(d.payable), whtLines: (d.whtLines ?? []).map((l) => ({ incomeType: l.incomeType, rateBp: l.rateBp, base: amountToSatang(l.base) })) }))

function oracleCase(c: PayCase): unknown {
  const i = c.input
  switch (c.fn) {
    case 'buildItem': {
      const r = oracleBuildItem(docsOf(i.docs as RawDoc[]))
      if (!r.ok) return r.code === 'PAYMENT_ITEM_NOT_POSITIVE' ? { error: r.code, transfer: satangToAmount(r.transfer) } : { error: r.code, reason: r.reason }
      return { payable: satangToAmount(r.payable), whtLines: r.whtLines.map((l) => ({ incomeType: l.incomeType, rateBp: l.rateBp, base: satangToAmount(l.base), wht: satangToAmount(l.wht) })), wht: satangToAmount(r.wht), transfer: satangToAmount(r.transfer) }
    }
    case 'buildRun': {
      const r = oracleBuildRun((i.suppliers as Array<{ code: string; docs: RawDoc[] }>).map((s) => ({ code: s.code, docs: docsOf(s.docs) })))
      if (!r.ok) return { error: r.code, supplier: r.supplierCode }
      return {
        items: r.items.map((x) => ({ seq: x.seq, code: x.code, payable: satangToAmount(x.payable), wht: satangToAmount(x.wht), transfer: satangToAmount(x.transfer) })),
        totals: { payable: satangToAmount(r.totals.payable), wht: satangToAmount(r.totals.wht), transfer: satangToAmount(r.totals.transfer), itemCount: r.totals.itemCount, documentCount: r.totals.documentCount },
      }
    }
    case 'nextRunDate':
      return oracleNextRunDate(i.today as string, suite.policy, suite.calendar)
    case 'checkPayDate': {
      const r = oracleCheckPayDate(i.payDate as string, new Date(i.at as string), suite.calendar)
      return r.ok ? { ok: true } : { error: r.code, reason: r.reason }
    }
    case 'proposeDocuments':
      return { proposed: oracleProposeDocuments(i.payDate as string, i.docs as Array<{ id: string; kind: 'INVOICE' | 'RETENTION'; dueDate?: string }>) }
    case 'checkPaidOn': {
      const r = oracleCheckPaidOn(i.payDate as string, i.paidOn as string, new Date(i.at as string))
      return r.ok ? { ok: true } : { error: r.code, reason: r.reason }
    }
    case 'itemFlags':
      return oracleItemFlags(i as never, suite.policy)
    case 'flagsKey':
      return oracleFlagsKey(i.items as Array<{ code: string; flags: string[] }>)
    default:
      throw new Error(`unknown fn ${c.fn}`)
  }
}

describe('[ADR-072] golden payment-run.yaml through the second implementation', () => {
  it('has the cases of the suite', () => expect(suite.cases.length).toBe(35))
  for (const c of suite.cases) it(`[${c.id}] ${c.title}`, () => expect(oracleCase(c)).toEqual(c.expect))
})

// ---------- random inputs inside the domain ----------

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const shift = (day: string, n: number) => dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
const day = fc.integer({ min: 0, max: 3 * 366 }).map((n) => dayOf(START + n * DAY_MS))
const near = (base: string, spread: number) => fc.integer({ min: -spread, max: spread }).map((n) => shift(base, n))
/** A calendar whose holidays fall around the day the test looks at */
const calendarNear = (base: string): fc.Arbitrary<PayCalendar> => fc.record({ workdays: fc.subarray(WEEKDAYS, { minLength: 1 }), holidays: fc.uniqueArray(near(base, 21), { maxLength: 15 }) })

// money: amounts of every size, with many small ones so tax rounds at half a satang and transfers land on zero
const satang = fc.oneof(fc.bigInt({ min: 0n, max: 2_000n }), fc.bigInt({ min: 0n, max: 99_999_999_999n }))
const doc: fc.Arbitrary<OracleDoc> = fc.record({
  kind: fc.constantFrom<OracleDoc['kind']>('INVOICE', 'RETENTION'),
  payable: satang,
  whtLines: fc.array(fc.record({ incomeType: fc.constantFrom('SERVICE', 'RENT', 'TRANSPORT', 'ADVERTISING'), rateBp: fc.constantFrom(0, 50, 100, 150, 200, 300, 500, 1_000, 1_500), base: satang }), { maxLength: 3 }),
})
const code = fc.integer({ min: 1, max: 60 }).map((n) => `SP${String(n).padStart(4, '0')}`)
// a few tax ids so suppliers share one often enough
const taxId = fc.option(fc.constantFrom('0105556000011', '0105556000029', '0994000123456'), { nil: null })

describe('[ADR-072] [FR-PAY-101/AC2] [FR-PAY-101/AC3] [FR-PAY-101/AC4] src/core/payment and the second implementation agree', () => {
  it('buildItem: the payable, the tax per (income type, rate) rounded once, the transfer, and each refusal', () => {
    fc.assert(
      fc.property(fc.array(doc, { maxLength: 6 }), (docs) => {
        expect(itemOf(buildItem(toItemDocs(docs)))).toEqual(oracleBuildItem(docs))
      }),
      RUNS,
    )
  })

  it('buildRun: one item per supplier numbered by code, the totals, and the supplier that fails', () => {
    const suppliers = fc.uniqueArray(fc.record({ code, docs: fc.array(doc, { minLength: 1, maxLength: 4 }) }), { selector: (s) => s.code, maxLength: 6 })
    fc.assert(
      fc.property(suppliers, (s) => {
        expect(runOf(s)).toEqual(oracleBuildRun(s))
      }),
      RUNS,
    )
  })

  it('nextRunDate: the first run weekday from today, moved off a non-working day, never before today', () => {
    const input = day.chain((today) => fc.tuple(fc.constant(today), fc.record({ runWeekdays: fc.subarray(WEEKDAYS, { minLength: 1 }), holidayShift: fc.constantFrom<PaymentPolicy['holidayShift']>('PREVIOUS', 'NEXT') }), calendarNear(today)))
    fc.assert(
      fc.property(input, ([today, policy, calendar]) => {
        expect(nextRunDate(today, policy, calendar)).toBe(oracleNextRunDate(today, policy, calendar))
      }),
      RUNS,
    )
  })

  it('checkPayDate: today or later in Thai time, and a working day', () => {
    const input = fc.integer({ min: 0, max: 3 * 366 * 24 * 60 }).chain((minute) => {
      const at = new Date(START + minute * 60_000)
      const today = dayOf(at.getTime() + THAI_MS)
      return fc.tuple(fc.constant(at), near(today, 10), calendarNear(today))
    })
    fc.assert(
      fc.property(input, ([at, payDate, calendar]) => {
        expect(checkPayDate(payDate, at, calendar)).toEqual(oracleCheckPayDate(payDate, at, calendar))
      }),
      RUNS,
    )
  })

  it('proposeDocuments: invoices due by the pay date and every released retention, in the order given', () => {
    const input = day.chain((payDate) =>
      fc.tuple(fc.constant(payDate), fc.array(fc.record({ id: fc.uuid(), kind: fc.constantFrom<'INVOICE' | 'RETENTION'>('INVOICE', 'RETENTION'), dueDate: fc.option(near(payDate, 5), { nil: null }) }), { maxLength: 10 })),
    )
    fc.assert(
      fc.property(input, ([payDate, docs]) => {
        expect(proposeDocuments(payDate, docs).map((d) => d.id)).toEqual(oracleProposeDocuments(payDate, docs))
      }),
      RUNS,
    )
  })

  it('checkPaidOn: from the pay date up to today in Thai time', () => {
    const input = fc.tuple(fc.integer({ min: 0, max: 3 * 366 * 24 * 60 }), fc.integer({ min: -10, max: 10 }), fc.integer({ min: -10, max: 10 }))
    fc.assert(
      fc.property(input, ([minute, a, b]) => {
        const at = new Date(START + minute * 60_000)
        const today = dayOf(at.getTime() + THAI_MS)
        expect(checkPaidOn(shift(today, a), shift(today, b), at)).toEqual(oracleCheckPaidOn(shift(today, a), shift(today, b), at))
      }),
      RUNS,
    )
  })

  it('itemFlags: every flag of BR-PAY-06 in its order, and whether the preparer must give a reason', () => {
    const input = day.chain((payDate) =>
      fc.record({
        payDate: fc.constant(payDate),
        supplier: fc.record({ registryFlag: fc.constantFrom('NONE', 'CEASED', 'VAT_CANCELLED', 'NOT_FOUND'), status: fc.constantFrom('ACTIVE', 'INACTIVE'), taxId }),
        account: fc.record({ activatedOn: near(payDate, 60), fromSeed: fc.boolean() }),
        riskOverrides: fc.option(fc.array(fc.record({ expiresOn: near(payDate, 5) }), { maxLength: 3 }), { nil: undefined }),
        previouslyExported: fc.option(fc.boolean(), { nil: undefined }),
        pendingChange: fc.option(fc.boolean(), { nil: undefined }),
        sameAccountTaxIds: fc.option(fc.array(taxId, { maxLength: 3 }), { nil: undefined }),
      }),
    )
    fc.assert(
      fc.property(input, fc.integer({ min: 0, max: 365 }), (i, days) => {
        const r = itemFlags(i, { recentBankChangeDays: days })
        expect({ flags: [...r.flags], requiresReason: r.requiresReason }).toEqual(oracleItemFlags(i, { recentBankChangeDays: days }))
      }),
      RUNS,
    )
  })

  it('flagsKey: the items with flags by supplier code, each with its flags in the order of BR-PAY-06', () => {
    const items = fc.uniqueArray(fc.record({ code, flags: fc.shuffledSubarray(FLAGS) }), { selector: (i) => i.code, maxLength: 8 })
    fc.assert(
      fc.property(items, (i) => {
        expect(flagsKey(i)).toBe(oracleFlagsKey(i))
      }),
      RUNS,
    )
  })
})
