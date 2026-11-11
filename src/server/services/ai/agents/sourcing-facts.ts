import { createHash } from 'node:crypto'
import { renderValue, type TextValue } from '@/core/ai-checks'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { sourcingFactsInputText } from '@/lib/ai-schemas/agents'
import type { RfxBidFacts } from '../../sourcing'
import { asDataValues } from '../data'

// The facts of an RFx's bids the Sourcing Agent writes about (S10-16 · BR-AI-32 · GC-AI-96), by code and without the
// database, so the agent, the job and the evaluation set (S10-19) give Claude the same text for the same bids. Numbers
// and codes only, and the supplier's name as comparisonFacts gives it (an individual as "ผู้ขายบุคคลธรรมดา <code>"); bp
// are kind integer (BR-AI-32: "151", never "1.51%"). No line description, brand, note, question or contact.

export type SourcingFacts = Readonly<Record<string, TextValue>>

/** The flags a summary lists at most (the table on the page shows all of them) */
const MAX_FLAGS = 10

const money = (amount: string): TextValue => ({ kind: 'money', value: amount })
const integer = (value: number): TextValue => ({ kind: 'integer', value })
const text = (value: string): TextValue => ({ kind: 'text', value })
const ref = (value: string): TextValue => ({ kind: 'ref', value })
const enumOf = (value: string): TextValue => ({ kind: 'enum', value })

export function sourcingFacts(f: RfxBidFacts): SourcingFacts {
  const bids = f.table.bids
  const complete = bids.filter((b) => !b.partial)
  const byNet = [...complete].sort((a, b) => (amountToSatang(a.net) < amountToSatang(b.net) ? -1 : amountToSatang(a.net) > amountToSatang(b.net) ? 1 : 0))
  const lowest = byNet[0]
  const highest = byNet[byNet.length - 1]
  const nameOf = new Map(bids.map((b) => [b.supplierCode, b.supplier]))
  const out: Record<string, TextValue> = {
    ...(f.number ? { 'rfx.number': ref(f.number) } : {}),
    bidCount: integer(bids.length),
    partialCount: integer(bids.length - complete.length),
    vatInclusiveCount: integer(bids.filter((b) => b.tags.includes('VAT_INCLUDED')).length),
    notVatRegisteredCount: integer(bids.filter((b) => b.tags.includes('NOT_VAT_REGISTERED')).length),
    foreignCount: integer(bids.filter((b) => b.tags.includes('FOREIGN')).length),
  }
  if (lowest && highest) {
    Object.assign(out, {
      'lowest.supplierName': text(lowest.supplier),
      'lowest.supplierCode': ref(lowest.supplierCode),
      'lowest.net': money(lowest.net),
      'highest.supplierName': text(highest.supplier),
      'highest.supplierCode': ref(highest.supplierCode),
      'highest.net': money(highest.net),
    })
  }
  if (f.spreadBp !== null) out.spreadBp = integer(f.spreadBp)
  if (f.incumbent && lowest) {
    const inc = bids.find((b) => b.supplierCode === f.incumbent!.supplierCode)!
    Object.assign(out, {
      'incumbent.supplierName': text(inc.supplier),
      'incumbent.supplierCode': ref(inc.supplierCode),
      'incumbent.net': money(inc.net),
      'incumbent.gap': money(satangToAmount(amountToSatang(inc.net) - amountToSatang(lowest.net))),
      gapBp: integer(f.incumbent.gapBp),
    })
  }
  const flags = bids.flatMap((b) => b.lines.filter((l) => l.flag !== null).map((l) => ({ b, l })))
  out.flagCount = integer(flags.length)
  flags.slice(0, MAX_FLAGS).forEach(({ b, l }, i) => {
    const key = `flags.${i + 1}`
    out[`${key}.supplierName`] = text(b.supplier)
    out[`${key}.lineNo`] = integer(l.lineNo)
    out[`${key}.flag`] = enumOf(l.flag!)
    if (l.deviationBp !== null) out[`${key}.deviationBp`] = integer(l.deviationBp)
    if (l.referenceSource) out[`${key}.referenceSource`] = enumOf(l.referenceSource)
    if (l.referenceUnitPrice) out[`${key}.reference`] = money(l.referenceUnitPrice)
  })
  for (const s of f.scores) {
    const key = `score.${s.rank}`
    out[`${key}.supplierName`] = text(nameOf.get(s.supplierCode) ?? s.supplierCode)
    out[`${key}.total`] = text(s.total)
    for (const [code, value] of Object.entries(s.criteria)) out[`${key}.${code}`] = text(value)
  }
  return out
}

/** The text the AI reads: each key with its value as the page shows it, fenced as data (BR-AI-18) */
export const sourcingFactsText = (facts: SourcingFacts): string => sourcingFactsInputText(asDataValues(Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, renderValue(v)]))))

/** Which facts a text was written with: a summary written ahead is used again only while the facts are the same */
export const sourcingFactsDigest = (facts: SourcingFacts): string => createHash('sha256').update(sourcingFactsText(facts)).digest('hex')
