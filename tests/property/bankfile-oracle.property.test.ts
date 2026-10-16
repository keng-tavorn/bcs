import { createHash } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BANKS, buildNeutralFile, maskAccount, normalizeAccount, precheckRun, readNeutralFile, type PrecheckFailure } from '@/core/bankfile'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { utf8WithBom } from '@/lib/encoding'
import { loadYaml } from '../golden/doa-fixtures'
import {
  oracleMaskAccount,
  oracleNeutralFile,
  oracleNormalizeAccount,
  oraclePrecheck,
  type OracleNeutralInput,
  type OraclePrecheckFailure,
  type OraclePrecheckItem,
  type OraclePrecheckRun,
} from '../support/oracles/bankfile'

// S9-03 (ADR-072): src/core/bankfile and a second implementation written from the spec by another agent that never saw
// the first (tests/support/oracles/bankfile.ts, which imports nothing of src) both pass every golden case of
// bank-account.yaml, bank-precheck.yaml and bankfile-neutral.yaml, and give the same result, field by field and byte by
// byte, on at least 1,000 random inputs per function. The inputs stay inside what the services give the engine;
// docs/reports/p1-review-S9.md lists where the two differ outside it and why: a stored account number has 10 to 12
// digits, an item's seq is unique and positive, a transfer is more than nothing, a file version is a positive whole
// number and a pay date a real day.

const RUNS = { numRuns: 1_000 }
const BANK_CODES = BANKS.map((b) => b.code)
const HELD = 'HELD_BY_THIS_RUN'

// ---------- the first implementation in the shape of the second ----------

const precheckOf = (run: OraclePrecheckRun, items: readonly OraclePrecheckItem[]) =>
  precheckRun(
    { totalTransferSatang: run.totalTransfer, itemCount: run.itemCount, payerStatus: run.payerStatus, payerTemplateCode: run.payerTemplate, runTemplateCode: run.runTemplate },
    items.map((i) => ({ seq: i.seq, supplierCode: i.supplier, transferSatang: i.transfer, snapshot: i.snapshot, register: i.register, documents: i.documents.map((d) => ({ id: d.id, heldByThisRun: d.link === HELD })) })),
  )
const failureOf = (f: PrecheckFailure): OraclePrecheckFailure => (f.check === 'TOTAL_MISMATCH' ? { check: f.check, expected: f.expectedSatang, actual: f.actualSatang } : f)

function neutralOf(input: OracleNeutralInput) {
  const file = buildNeutralFile({ run: input.run, items: input.items.map(({ amount, ...i }) => ({ ...i, amountSatang: amount })) })
  const bytes = utf8WithBom(file.text)
  const read = readNeutralFile(file.text)
  return { fileName: file.fileName, lines: file.text.split('\r\n').slice(0, -1), itemCount: read.trailer.count, total: read.trailer.totalSatang, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

// ---------- the golden cases through the second implementation ----------

type Raw = Record<string, unknown>
const accountSuite = loadYaml<{ banks: string[]; cases: Array<{ id: string; title: string; input: { bankCode: string; accountNo: string; accountName?: string }; expect: unknown }> }>('bank-account.yaml')
const precheckSuite = loadYaml<{ base: { run: Raw; items: Raw[] }; cases: Array<{ id: string; title: string; change: Raw; expect: unknown }> }>('bank-precheck.yaml')
const neutralSuite = loadYaml<{ cases: Array<{ id: string; title: string; input: Raw; expect: unknown }> }>('bankfile-neutral.yaml')

function applyChange<T>(base: T, change: Raw): T {
  const copy = structuredClone(base) as Raw
  for (const [path, value] of Object.entries(change)) {
    const keys = path.split('.')
    let node = copy
    for (const k of keys.slice(0, -1)) node = node[k] as Raw
    node[keys.at(-1)!] = value
  }
  return copy as T
}

describe('[ADR-072] the golden cases of S9-03 through the second implementation', () => {
  for (const c of accountSuite.cases) {
    it(`[${c.id}] ${c.title}`, () => {
      const r = oracleNormalizeAccount(c.input, accountSuite.banks)
      expect(r.ok ? { accountNo: r.accountNo, masked: r.masked } : { error: r.code, reason: r.reason }).toEqual(c.expect)
    })
  }
  for (const c of precheckSuite.cases) {
    it(`[${c.id}] ${c.title}`, () => {
      const x = applyChange(precheckSuite.base, c.change) as { run: { totalTransfer: string } & Omit<OraclePrecheckRun, 'totalTransfer'>; items: Array<Omit<OraclePrecheckItem, 'transfer'> & { transfer: string }> }
      const r = oraclePrecheck({ run: { ...x.run, totalTransfer: amountToSatang(x.run.totalTransfer) }, items: x.items.map((i) => ({ ...i, transfer: amountToSatang(i.transfer) })) })
      const failures = r.failures.map((f) => (f.check === 'TOTAL_MISMATCH' ? { ...f, expected: satangToAmount(f.expected), actual: satangToAmount(f.actual) } : f))
      expect({ ok: r.ok, failures }).toEqual(c.expect)
    })
  }
  const neutralInput = (input: Raw): OracleNeutralInput => {
    if ('sameAs' in input) {
      const base = neutralInput(neutralSuite.cases.find((x) => x.id === input.sameAs)!.input)
      return { run: { ...base.run, ...(input.run as object) }, items: base.items }
    }
    const i = input as { run: OracleNeutralInput['run']; items: Array<Omit<OracleNeutralInput['items'][number], 'amount'> & { amount: string }> }
    return { run: i.run, items: i.items.map((x) => ({ ...x, amount: amountToSatang(x.amount) })) }
  }
  for (const c of neutralSuite.cases) {
    it(`[${c.id}] ${c.title}`, () => {
      const r = oracleNeutralFile(neutralInput(c.input))
      expect({ fileName: r.fileName, lines: r.lines, itemCount: r.itemCount, total: satangToAmount(r.total), bytes: r.bytes.length, sha256: r.sha256 }).toEqual(c.expect)
    })
  }
})

// ---------- random inputs inside the domain ----------

const digit = fc.constantFrom(...'0123456789'.split(''))
const digits = (min: number, max: number) => fc.array(digit, { minLength: min, maxLength: max }).map((d) => d.join(''))
/** What a person types for an account number: digits with passbook separators, and now and then a wrong character */
const typedNumber = fc
  .array(fc.oneof({ weight: 12, arbitrary: digit }, { weight: 2, arbitrary: fc.constantFrom('-', ' ') }, { weight: 1, arbitrary: fc.constantFrom('A', '\t', '.', '๑', ' ', '–') }), { maxLength: 16 })
  .map((c) => c.join(''))
const bankCode = fc.oneof({ weight: 5, arbitrary: fc.constantFrom(...BANK_CODES) }, { weight: 1, arbitrary: fc.constantFrom('999', '04', '0040', ' 004', '') })
/** Thai and English names with the characters CSV quotes, and now and then a control character */
const name = fc
  .array(fc.oneof({ weight: 10, arbitrary: fc.constantFrom(...'บริษัท ก ข จำกัด หจก. Co., Ltd "เอ" , สาขา 2'.split('')) }, { weight: 1, arbitrary: fc.constantFrom('\n', '\r', '\u0007', '\u0085', '​', ' ') }), { minLength: 1, maxLength: 40 })
  .map((c) => c.join(''))
const satang = fc.oneof(fc.bigInt({ min: 1n, max: 2_000n }), fc.bigInt({ min: 1n, max: 99_999_999_999n }))

const account = fc.record({ bankCode: fc.constantFrom('004', '006', '014'), accountNo: digits(10, 12), accountName: fc.constantFrom('บริษัท ก จำกัด', 'บริษัท ข จำกัด', 'หจก. ค, สาขา 2') })
/** Items with unique seq numbers given in any order, whose fields often agree with the register and often do not */
const items = fc
  .uniqueArray(fc.integer({ min: 1, max: 40 }), { maxLength: 6 })
  .chain((seqs) =>
    fc.tuple(
      ...seqs.map((seq) =>
        fc.record({
          seq: fc.constant(seq),
          supplier: fc.constantFrom('SP0001', 'SP0002', 'SP0003', 'SP0004', 'SP0005', 'SP0006'),
          transfer: satang,
          snapshot: account,
          sameAsRegister: fc.boolean(),
          register: fc.option(fc.record({ status: fc.constantFrom('ACTIVE', 'ACTIVE', 'SUPERSEDED', 'CLOSED') }).chain((r) => account.map((a) => ({ ...a, ...r }))), { nil: null, freq: 6 }),
          documents: fc.array(fc.record({ id: fc.constantFrom('INV-A', 'INV-B', 'INV-C', 'INV-D', 'RET-A'), link: fc.constantFrom(HELD, HELD, HELD, 'PAID', 'RELEASED', 'HELD_BY_OTHER_RUN') }), { maxLength: 3 }),
        }),
      ),
    ),
  )
  .map((list) => list.map(({ sameAsRegister, ...i }): OraclePrecheckItem => (sameAsRegister && i.register ? { ...i, snapshot: { bankCode: i.register.bankCode, accountNo: i.register.accountNo, accountName: i.register.accountName } } : i)))

describe('[ADR-072] [FR-PAY-102/AC1] [FR-PAY-102/AC2] [FR-PAY-102/AC3] [FR-PAY-102/AC8] src/core/bankfile and the second implementation agree', () => {
  it('normalizeAccount: the digits kept and their mask, or the first reason of BR-SUP-07', () => {
    fc.assert(
      fc.property(bankCode, typedNumber, fc.option(name, { nil: undefined }), (code, accountNo, accountName) => {
        const input = accountName === undefined ? { bankCode: code, accountNo } : { bankCode: code, accountNo, accountName }
        expect(normalizeAccount(input)).toEqual(oracleNormalizeAccount(input, BANK_CODES))
      }),
      RUNS,
    )
  })

  it('maskAccount: every digit of a stored number but the last four', () => {
    fc.assert(
      fc.property(digits(10, 12), (n) => {
        expect(maskAccount(n)).toBe(oracleMaskAccount(n))
      }),
      RUNS,
    )
  })

  it('precheckRun: every failure, the run first, then each item in seq order', () => {
    const run = (list: OraclePrecheckItem[]) =>
      fc.record({
        totalTransfer: fc.oneof(fc.constant(list.reduce((a, i) => a + i.transfer, 0n)), satang),
        itemCount: fc.oneof(fc.constant(list.length), fc.integer({ min: 0, max: 8 })),
        payerStatus: fc.constantFrom('ACTIVE', 'ACTIVE', 'SUPERSEDED', 'CLOSED'),
        payerTemplate: fc.constantFrom('BCS-NEUTRAL-1', 'BCS-NEUTRAL-1', 'KBANK-X'),
        runTemplate: fc.constant('BCS-NEUTRAL-1'),
      })
    fc.assert(
      fc.property(
        items.chain((list) => fc.tuple(run(list), fc.constant(list))),
        ([r, list]) => {
          const ours = precheckOf(r, list)
          expect({ ok: ours.ok, failures: ours.failures.map(failureOf) }).toEqual(oraclePrecheck({ run: r, items: list }))
        },
      ),
      RUNS,
    )
  })

  it('buildNeutralFile and readNeutralFile: the same name, lines, bytes and sha256, and the totals read back', () => {
    const input: fc.Arbitrary<OracleNeutralInput> = fc.record({
      run: fc.record({
        number: fc.integer({ min: 1, max: 99_999 }).map((n) => `PAY-2569-${String(n).padStart(5, '0')}`),
        fileVersion: fc.integer({ min: 1, max: 20 }),
        valueDate: fc.integer({ min: 0, max: 1_000 }).map((n) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10)),
        payer: fc.record({ bankCode: fc.constantFrom('004', '014'), accountNo: digits(10, 12) }),
      }),
      items: fc
        .uniqueArray(fc.integer({ min: 1, max: 1_200 }), { maxLength: 8 })
        .chain((seqs) => fc.tuple(...seqs.map((seq) => fc.record({ seq: fc.constant(seq), bankCode: fc.constantFrom(...BANK_CODES), accountNo: digits(10, 12), accountName: name.filter((n) => !/\p{Cc}/u.test(n)), amount: satang, supplierCode: fc.constantFrom('SP0001', 'SP0076', 'SP0135') })))),
    })
    fc.assert(
      fc.property(input, (i) => {
        const ours = neutralOf(i)
        const theirs = oracleNeutralFile(i)
        expect({ ...ours, bytes: [...ours.bytes] }).toEqual({ ...theirs, bytes: [...theirs.bytes] })
      }),
      RUNS,
    )
  })
})
