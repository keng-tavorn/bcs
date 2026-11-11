import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { checkAiText, type TextValue } from '../src/core/ai-checks'
import { amountToSatang, satangToAmount } from '../src/core/money/dto'
import { compareBids, formatScore, priceAnomaly, rfxDraftFromLines, type BidPrice, type PriceFlag, type PriceRefSource } from '../src/core/sourcing'
import { DECISION_ADVICE_WORDS, EVAL_THRESHOLDS_BP, SOURCING_PROFILE } from '../src/lib/ai-config'
import { rfxDraftInputText, type RfxDraftText } from '../src/lib/ai-schemas/agents'
import { RFX_LONG_TEXT_MAX, SOURCING_MIN_INVITES_THRESHOLD_GROSS, SOURCING_PRICE_ANOMALY_BP } from '../src/lib/constants'
import { sourcingFacts, sourcingFactsText, type SourcingFacts } from '../src/server/services/ai/agents/sourcing-facts'
import { bidSpread, type RfxBidFacts } from '../src/server/services/sourcing/bid-spread'
import type { ComparisonFacts, ComparisonTag } from '../src/server/services/sourcing/comparison'
import { ROOT } from './lib/ai-eval-cases'

// The evaluation set of the Sourcing Agent, demo tier (S10-19 · FR-AI-305 AC5 · OQ-209): the 10 synthetic RFx of
// tests/fixtures/ai-rfx/cases.yaml, one shape for the evaluation (pnpm ai:eval --agent sourcing) and the tests. Each case
// becomes the two texts the agent sends Claude through the app's own code — rfxDraftInputText for RFX_DRAFT, and for
// BID_SUMMARY and NEGOTIATION_POINTS the comparison table as comparison.ts works it (compareBids, priceAnomaly with the
// reference comparison.ts would pick), bidSpread and sourcingFacts — so a recorded answer is the one the app's call gets.
// OQ-209's floors: the kind right ≥ 90 % (decided by code: rfxDraftFromLines), each line's English right ≥ 90 %, the
// texts pass ai-text (BR-AI-27 profile SOURCING) 100 %, the summary points out every price flag ≥ 95 %, no advice to
// decide 100 %.

export const SOURCING_CASES_FILE = path.join(ROOT, 'tests', 'fixtures', 'ai-rfx', 'cases.yaml')

/** VAT of the evaluation's day (BR-VAT-01: 7 %) */
const VAT_RATE_BP = 700
const MIN_INVITES_ABOVE_THRESHOLD = 3

const amount = z.string().regex(/^\d+\.\d{2}$/)
const words = z.array(z.string().min(1)).min(1)
const Line = z.strictObject({
  lineNo: z.number().int().positive(),
  description: z.string().min(1),
  uom: z.string().min(1),
  quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
  isService: z.boolean(),
  /** The reference price the RFx line carries (rfxDraftFromLines decides the kind with it); null when nobody priced it */
  refUnitPrice: amount.nullable(),
  /** The reference of the comparison when no agreed price applies (comparison.ts: catalogue, history, typed) */
  reference: z.strictObject({ source: z.enum(['CATALOG', 'HISTORY', 'MANUAL']), unitPrice: amount }).optional(),
  /** Agreed prices in effect for the line's item, by supplier */
  agreements: z.array(z.strictObject({ supplierCode: z.string(), unitPrice: amount })).optional(),
  /** Groups of words the English description must hold, any word of each group (a person's answer) */
  en: z.array(words).min(1),
  /** The English units a buyer accepts */
  uomEn: words,
})
const Bid = z.strictObject({
  supplierCode: z.string().regex(/^SP\d{4}$/),
  supplier: z.string().min(1),
  individual: z.boolean().optional(),
  foreign: z.boolean().optional(),
  vatRegistered: z.boolean().optional(),
  incumbent: z.boolean().optional(),
  priceIncludesVat: z.boolean().optional(),
  /** Unit price as quoted per lineNo; null = the line is not offered */
  prices: z.record(z.string(), amount.nullable()),
})
const Flag = z.strictObject({ supplierCode: z.string(), lineNo: z.number().int(), flag: z.enum(['ABOVE_AGREEMENT', 'HIGH', 'LOW']) })
const Case = z.strictObject({
  id: z.string().regex(/^RFX-\d{2}$/),
  number: z.string().regex(/^RFX-\d{4}-\d{5}$/),
  createdAs: z.enum(['RFQ', 'RFP']),
  category: z.string().min(1),
  expect: z.strictObject({ kind: z.enum(['RFQ', 'RFP']) }),
  lines: z.array(Line).min(1),
  bids: z.array(Bid).min(2),
  scores: z.array(z.strictObject({ supplierCode: z.string(), rank: z.number().int().positive(), totalBp: z.number().int().nonnegative(), criteria: z.record(z.string(), z.number().int().nonnegative()) })).optional(),
  expectFlags: z.array(Flag),
})
export type SourcingCaseInput = z.infer<typeof Case>

export interface SourcingCase extends SourcingCaseInput {
  /** What RFX_DRAFT sends (rfxDraftInputText of the draft as procurement created it) */
  readonly draftText: string
  /** The kind code proposes (rfxDraftFromLines) */
  readonly plannedKind: 'RFQ' | 'RFP'
  /** The facts of the closed RFx's bids and the text BID_SUMMARY and NEGOTIATION_POINTS send */
  readonly facts: SourcingFacts
  readonly factsText: string
  /** The index of each expected flag in the facts (flags.<n>.*), in the order sourcingFacts lists them */
  readonly flagKeys: readonly string[]
}

const satang = (a: string) => amountToSatang(a)

/** The reference comparison.ts picks for a bidder on a line: its own agreed price, another's, else the line's */
function referenceOf(line: SourcingCaseInput['lines'][number], supplierCode: string): { unitPriceSatang: bigint; source: PriceRefSource } | null {
  const agreements = [...(line.agreements ?? [])].sort((a, b) => (satang(a.unitPrice) < satang(b.unitPrice) ? -1 : 1))
  const own = agreements.find((a) => a.supplierCode === supplierCode)
  if (own) return { unitPriceSatang: satang(own.unitPrice), source: 'AGREEMENT' }
  const other = agreements.find((a) => a.supplierCode !== supplierCode)
  if (other) return { unitPriceSatang: satang(other.unitPrice), source: 'AGREEMENT_OTHER' }
  return line.reference ? { unitPriceSatang: satang(line.reference.unitPrice), source: line.reference.source } : null
}

/** The comparison table's facts as comparisonOf + comparisonFacts give them, without the database */
export function comparisonOfCase(c: SourcingCaseInput): ComparisonFacts {
  const ref = (n: number) => `L${n}`
  const vatRateOf = (b: SourcingCaseInput['bids'][number]) => ((b.vatRegistered ?? !b.foreign) && !b.foreign ? VAT_RATE_BP : 0)
  const priceOf = (b: SourcingCaseInput['bids'][number], lineNo: number) => b.prices[String(lineNo)] ?? null
  const comparison = compareBids(
    c.lines.map((l) => ({ ref: ref(l.lineNo), quantity: l.quantity })),
    c.bids.map((b) => ({
      ref: b.supplierCode,
      priceIncludesVat: Boolean(b.priceIncludesVat),
      vatRateBp: vatRateOf(b),
      unitPrices: Object.fromEntries(c.lines.filter((l) => priceOf(b, l.lineNo) !== null).map((l) => [ref(l.lineNo), satang(priceOf(b, l.lineNo)!)])),
    })),
  )
  const lowest = new Set(comparison.lowest)
  return {
    sealed: false,
    priceAnomalyBp: SOURCING_PRICE_ANOMALY_BP,
    lines: c.lines.map((l) => ({ lineNo: l.lineNo, quantity: l.quantity, uom: l.uom })),
    bids: c.bids.map((b) => {
      const row = comparison.bids.find((x) => x.ref === b.supplierCode)!
      const lineNet = new Map(row.lineNet)
      const tags: ComparisonTag[] = []
      if (b.priceIncludesVat) tags.push('VAT_INCLUDED')
      if (!(b.vatRegistered ?? !b.foreign)) tags.push('NOT_VAT_REGISTERED')
      if (b.foreign) tags.push('FOREIGN')
      if (b.incumbent) tags.push('INCUMBENT')
      return {
        supplierCode: b.supplierCode,
        supplier: b.individual ? `ผู้ขายบุคคลธรรมดา ${b.supplierCode}` : b.supplier,
        net: satangToAmount(row.net),
        vat: satangToAmount(row.vat),
        gross: satangToAmount(row.gross),
        partial: row.partial,
        lowest: lowest.has(b.supplierCode),
        tags,
        risk: null,
        lines: c.lines.map((l) => {
          const quoted = priceOf(b, l.lineNo)
          const net = lineNet.get(ref(l.lineNo))
          const reference = referenceOf(l, b.supplierCode)
          const price: BidPrice | null = quoted === null ? null : b.priceIncludesVat ? { lineNetSatang: net!, quantity: l.quantity } : { unitPriceSatang: satang(quoted) }
          const check = price ? priceAnomaly(price, reference, SOURCING_PRICE_ANOMALY_BP) : { deviationBp: null, flag: null }
          return {
            lineNo: l.lineNo,
            quotedUnitPrice: quoted,
            lineNet: net === undefined ? null : satangToAmount(net),
            referenceSource: reference?.source ?? null,
            referenceUnitPrice: reference ? satangToAmount(reference.unitPriceSatang) : null,
            deviationBp: check.deviationBp,
            flag: check.flag,
          }
        }),
      }
    }),
  }
}

/** The facts the agent writes about, as rfxBidFacts gives them after the close (scores once revealed) */
export function bidFactsOfCase(c: SourcingCaseInput): RfxBidFacts {
  const table = comparisonOfCase(c)
  return {
    rfxEventId: c.id,
    number: c.number,
    status: c.scores ? 'EVALUATING' : 'CLOSED',
    table,
    ...bidSpread(table),
    scores: (c.scores ?? []).map((s) => ({ supplierCode: s.supplierCode, rank: s.rank, total: formatScore(s.totalBp), criteria: Object.fromEntries(Object.entries(s.criteria).map(([k, v]) => [k, formatScore(v)])) })),
  }
}

export function loadSourcingCases(file = SOURCING_CASES_FILE): SourcingCase[] {
  const raw = parse(readFileSync(file, 'utf8')) as { cases: unknown[] }
  return raw.cases.map((x) => {
    const c = Case.parse(x)
    for (const l of c.lines) {
      // a typed reference is the line's own reference price (rfx line refSource MANUAL)
      if (l.reference?.source === 'MANUAL' && l.refUnitPrice !== l.reference.unitPrice) throw new Error(`${c.id} line ${l.lineNo}: a MANUAL reference is the line's refUnitPrice`)
    }
    const plan = rfxDraftFromLines(
      c.lines.map((l) => ({ ref: String(l.lineNo), category: c.category, isService: l.isService, quantity: l.quantity, refUnitPriceSatang: l.refUnitPrice === null ? null : satang(l.refUnitPrice) })),
      VAT_RATE_BP,
      { thresholdGrossSatang: satang(SOURCING_MIN_INVITES_THRESHOLD_GROSS), minInvitesAboveThreshold: MIN_INVITES_ABOVE_THRESHOLD },
    )[0]!
    const bidFacts = bidFactsOfCase(c)
    // the flags of code against the answer a person worked out: a case that disagrees is a wrong case, not a score
    const flags = bidFacts.table.bids.flatMap((b) => b.lines.filter((l) => l.flag !== null).map((l) => `${b.supplierCode}:${l.lineNo}:${l.flag}`))
    const expected = c.expectFlags.map((f) => `${f.supplierCode}:${f.lineNo}:${f.flag}`)
    if (flags.join(',') !== expected.join(',')) throw new Error(`${c.id}: code flags ${flags.join(',') || 'none'}, the answer says ${expected.join(',') || 'none'}`)
    const facts = sourcingFacts(bidFacts)
    return {
      ...c,
      draftText: rfxDraftInputText({ kind: c.createdAs, categoryCode: c.category, lines: c.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, uom: l.uom })) }),
      plannedKind: plan.kind,
      facts,
      factsText: sourcingFactsText(facts),
      flagKeys: expected.map((_, i) => `flags.${i + 1}`),
    }
  })
}

// ---------- scoring ----------

/** Lower case, hyphens slashes and dots between words as spaces, one space */
const plain = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[-_/,()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** A line's English description holds a word of every group of the answer (codes like DB16 also as "db 16") */
export function englishDescriptionCorrect(line: SourcingCaseInput['lines'][number], descriptionEn: string | null | undefined): boolean {
  if (!descriptionEn || descriptionEn.trim() === '') return false
  const text = plain(descriptionEn)
  return line.en.every((group) => group.some((w) => text.includes(plain(w))))
}

/** A unit as a buyer reads it: letters and digits only, singular ("Pieces" "pcs." "cu.m" → piece pc cum) */
const unitKey = (s: string) => {
  const k = plain(s).replace(/[^a-z0-9³]/g, '')
  return k.length > 2 && k.endsWith('s') && !k.endsWith('ss') ? k.slice(0, -1) : k
}

export function englishUnitCorrect(line: SourcingCaseInput['lines'][number], uomEn: string | null | undefined): boolean {
  if (!uomEn || uomEn.trim() === '') return false
  const got = unitKey(uomEn)
  return line.uomEn.some((u) => unitKey(u) === got)
}

/** The four words of the draft's head are there and fit their fields (draftRfx keeps only these) */
export function draftHeadFilled(o: Pick<RfxDraftText, 'title' | 'titleEn' | 'description' | 'descriptionEn'>): boolean {
  const fits = (v: string | null, max: number) => v !== null && v.trim() !== '' && [...v.trim()].length <= max
  return fits(o.title, 200) && fits(o.titleEn, 200) && fits(o.description, RFX_LONG_TEXT_MAX) && fits(o.descriptionEn, RFX_LONG_TEXT_MAX)
}

/** Number words a draft may use to state a count (a person reads "หนึ่งเครื่อง" or "one monitor" as a quantity) */
const COUNT_WORDS = ['one', 'two', 'three', 'four', 'five', 'ten', 'single', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'สิบ'] as const
const numbersOf = (s: string) => new Set([...s.normalize('NFKC').replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50)).matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]))

/**
 * The numbers and count words of a draft that the requester's lines do not hold (BR-AI-31: the AI never states a
 * quantity, a price or a date; it does not see them, so any such number is made up). A code like DB16 or 1x4 is the
 * line's own.
 */
export function inventedNumbers(c: SourcingCaseInput, o: RfxDraftText): string[] {
  const source = c.lines.map((l) => `${l.description} ${l.uom}`).join(' ')
  // the lines' own numbers, and their line numbers ("รายการที่ 2" names a line, not a count)
  const allowed = new Set([...numbersOf(source), ...c.lines.map((l) => String(l.lineNo))])
  const written = [o.title, o.titleEn, o.description, o.descriptionEn, ...o.lines.map((l) => l.descriptionEn)].filter((x): x is string => x !== null).join(' ')
  const words = written.toLowerCase()
  return [
    // "จำนวน 1 รายการ": a count stated in words, whatever its number
    ...[...written.matchAll(/จำนวน\s*(?:\d|หนึ่ง|สอง|สาม|สี่|ห้า|สิบ)\S*/g)].map((m) => m[0]),
    ...[...numbersOf(written)].filter((n) => !allowed.has(n)),
    ...COUNT_WORDS.filter((w) => (/^[a-z]+$/.test(w) ? new RegExp(`\\b${w}\\b`).test(words) : words.includes(w)) && !source.toLowerCase().includes(w)),
  ]
}

export interface SummaryScore {
  /** Passes BR-AI-27 with profile SOURCING, as writeSummary checks it */
  readonly text: boolean
  readonly reason: string | null
  /** No word of DECISION_ADVICE_WORDS */
  readonly noAdvice: boolean
  /** Each expected flag: whether a sentence names it through one of its placeholders (flags.<n>.*) */
  readonly flags: readonly boolean[]
}

export function scoreSummary(c: SourcingCase, sentences: readonly string[]): SummaryScore {
  const checked = checkAiText(sentences, c.facts, SOURCING_PROFILE, DECISION_ADVICE_WORDS)
  const all = sentences.join(' ')
  const lower = all.toLowerCase()
  return {
    text: checked.ok,
    reason: checked.ok ? null : checked.reason,
    noAdvice: !DECISION_ADVICE_WORDS.some((w) => lower.includes(w.toLowerCase())),
    flags: c.flagKeys.map((k) => all.includes(`{{v:${k}.`)),
  }
}

/** The floors of OQ-209, per metric of the report */
export const SOURCING_FLOORS = {
  kind: EVAL_THRESHOLDS_BP.sourcingKind,
  descriptionEn: EVAL_THRESHOLDS_BP.sourcingEnglish,
  uomEn: EVAL_THRESHOLDS_BP.sourcingEnglish,
  head: EVAL_THRESHOLDS_BP.other,
  noInventedNumber: 10_000,
  text: 10_000,
  noDecisionAdvice: 10_000,
  flags: EVAL_THRESHOLDS_BP.sourcingFlags,
} as const

// ---------- the truth as an answer (fixture mode without a live run) ----------

/** What a perfect draft gives: the first word of each group, the first accepted unit */
export function truthDraft(c: SourcingCaseInput): RfxDraftText {
  return {
    title: `จัดหา ${c.lines[0]!.description}`,
    titleEn: `Supply of ${c.lines[0]!.en.map((g) => g[0]).join(' ')}`,
    description: 'ขอใบเสนอราคาต่อบรรทัดเป็นเงินบาท',
    descriptionEn: 'Please quote per line in Thai baht.',
    lines: c.lines.map((l) => ({ lineNo: l.lineNo, descriptionEn: l.en.map((g) => g[0]).join(' '), uomEn: l.uomEn[0]! })),
  }
}

/** What a perfect summary gives: the count, the lowest, and each flag by its placeholders */
export function truthSummary(c: SourcingCase): string[] {
  const has = (k: string) => Object.hasOwn(c.facts, k)
  return [
    'ได้รับข้อเสนอ {{v:bidCount}} ใบ',
    ...(has('lowest.net') ? ['ยอดก่อน VAT ต่ำสุดคือ {{v:lowest.supplierName}} ที่ {{v:lowest.net}} บาท'] : []),
    ...c.flagKeys.map((k) => `ธงราคา {{v:${k}.flag}} ที่บรรทัด {{v:${k}.lineNo}} ของ {{v:${k}.supplierName}}`),
  ].slice(0, SOURCING_PROFILE.maxSentences)
}

export type { PriceFlag, TextValue }
