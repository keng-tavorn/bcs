import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { buildRun, type ItemDocument } from '@/core/payment'
import { PAYMENT_RUN_DOCUMENT_MACHINE, transition, type PaymentRunDocumentState } from '@/core/state-machines'

// S9-02 (spec §7.19 INV-PAY-01 INV-PAY-02, BR-PAY-03 to BR-PAY-05, BR-PAY-10 BR-PAY-12):
// - the totals of any run are the sums of its items, and every item transfers what it pays less its tax;
// - over random sequences of what happens to runs (documents added and removed, the run cancelled, returned, rejected,
//   an item failed or the run paid), a document is HELD or PAID by one link at most, and its S8 state follows its
//   link: HELD ↔ IN_PAYMENT_RUN, PAID ↔ PAID, otherwise ready to pay — so nothing is ever paid twice.

const satang = fc.bigInt({ min: 0n, max: 50_000_000n })
const whtLine = fc.record({ incomeType: fc.constantFrom('SERVICE', 'RENT', 'TRANSPORT', 'CONTRACT'), rateBp: fc.constantFrom(100, 200, 300, 500), base: satang })
const document = fc.record({ kind: fc.constantFrom<'INVOICE' | 'RETENTION'>('INVOICE', 'RETENTION'), payable: satang, lines: fc.array(whtLine, { maxLength: 3 }) })
const supplier = fc.record({ code: fc.stringMatching(/^SP\d{4}$/), docs: fc.array(document, { minLength: 1, maxLength: 4 }) })

describe('[INV-PAY-02] the totals of a run', () => {
  it('are the sums of its items, and each item transfers its payable less its tax, more than nothing', () => {
    fc.assert(
      fc.property(fc.uniqueArray(supplier, { selector: (s) => s.code, minLength: 1, maxLength: 6 }), (suppliers) => {
        const run = buildRun(suppliers.map((s) => ({ code: s.code, docs: s.docs.map((d, i): ItemDocument => ({ kind: d.kind, doc: `${s.code}-${i}`, payableSatang: d.payable, whtLines: d.lines.map((l) => ({ incomeType: l.incomeType, rateBp: l.rateBp, baseSatang: l.base })) })) })))
        if (!run.ok) {
          expect(run.code).toBe('PAYMENT_ITEM_NOT_POSITIVE')
          return
        }
        for (const item of run.items) {
          expect(item.transferSatang).toBe(item.payableSatang - item.whtSatang)
          expect(item.transferSatang > 0n).toBe(true)
          expect(item.whtSatang >= 0n).toBe(true)
        }
        const items = run.items
        const sum = (f: (i: (typeof items)[number]) => bigint) => items.reduce((a, i) => a + f(i), 0n)
        expect(run.totals).toEqual({ payableSatang: sum((i) => i.payableSatang), whtSatang: sum((i) => i.whtSatang), transferSatang: sum((i) => i.transferSatang), itemCount: suppliers.length, documentCount: suppliers.reduce((a, s) => a + s.docs.length, 0) })
        expect(run.items.map((i) => i.seq)).toEqual(run.items.map((_, i) => i + 1))
        expect(run.items.map((i) => i.code)).toEqual([...run.items.map((i) => i.code)].sort())
      }),
      { numRuns: 1_000 },
    )
  })
})

// A model of the links of S9 and the documents of S8 they hold: the machines decide every move
type DocState = 'READY' | 'IN_PAYMENT_RUN' | 'PAID'
interface Link { doc: number; run: number; state: PaymentRunDocumentState }
type Op = { kind: 'add'; doc: number; run: number } | { kind: 'remove' | 'fail'; doc: number; run: number } | { kind: 'cancel' | 'reject' | 'return' | 'pay'; run: number }

const DOCS = 6
const RUNS = 3
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('add' as const), doc: fc.nat({ max: DOCS - 1 }), run: fc.nat({ max: RUNS - 1 }) }),
  fc.record({ kind: fc.constantFrom('remove' as const, 'fail' as const), doc: fc.nat({ max: DOCS - 1 }), run: fc.nat({ max: RUNS - 1 }) }),
  fc.record({ kind: fc.constantFrom('cancel' as const, 'reject' as const, 'return' as const, 'pay' as const), run: fc.nat({ max: RUNS - 1 }) }),
)

describe('[INV-PAY-01] a document is held or paid by one run at most', () => {
  it('holds over any sequence of adding, removing, cancelling, returning, rejecting, failing and paying', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        const docs: DocState[] = Array.from({ length: DOCS }, () => 'READY')
        const links: Link[] = []
        const live = (doc: number) => links.find((l) => l.doc === doc && l.state !== 'RELEASED')
        const move = (l: Link, command: 'paymentRunDocument.pay' | 'paymentRunDocument.release') => {
          const moved = transition(PAYMENT_RUN_DOCUMENT_MACHINE, l.state, command)
          if (!moved.ok) return false
          l.state = moved.to
          docs[l.doc] = moved.to === 'PAID' ? 'PAID' : 'READY'
          return true
        }
        for (const o of ops) {
          if (o.kind === 'add') {
            // BR-PAY-03: only a document ready to pay is added (DOCUMENT_NOT_PAYABLE otherwise)
            if (docs[o.doc] !== 'READY') continue
            links.push({ doc: o.doc, run: o.run, state: 'HELD' })
            docs[o.doc] = 'IN_PAYMENT_RUN'
          } else if (o.kind === 'remove' || o.kind === 'fail') {
            const l = links.find((x) => x.doc === o.doc && x.run === o.run && x.state === 'HELD')
            if (l) move(l, 'paymentRunDocument.release')
          } else if (o.kind === 'cancel' || o.kind === 'reject') {
            for (const l of links.filter((x) => x.run === o.run && x.state === 'HELD')) move(l, 'paymentRunDocument.release')
          } else if (o.kind === 'pay') {
            for (const l of links.filter((x) => x.run === o.run && x.state === 'HELD')) move(l, 'paymentRunDocument.pay')
          }
          // 'return' keeps every document held (BR-PAY-09)
          for (let d = 0; d < DOCS; d++) {
            const held = links.filter((l) => l.doc === d && l.state !== 'RELEASED')
            expect(held.length <= 1).toBe(true)
            const state = live(d)?.state
            expect(docs[d]).toBe(state === 'HELD' ? 'IN_PAYMENT_RUN' : state === 'PAID' ? 'PAID' : 'READY')
          }
          // a paid link never moves again
          for (const l of links.filter((x) => x.state === 'PAID')) expect(transition(PAYMENT_RUN_DOCUMENT_MACHINE, l.state, 'paymentRunDocument.release').ok).toBe(false)
        }
      }),
      { numRuns: 2_000 },
    )
  })
})
