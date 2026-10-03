import { formatSatang } from '@/core/money/format'

// An amount band as words (BR-DOA-02: lower bound exclusive with gt or inclusive with gte, upper bound inclusive with
// lte, in satang text). Returns the message key under adminDoa.band and its values; amounts get thousands separators
// and two decimals (§9.9 rule 6). A lower bound of zero is left out: purchase amounts are always above zero.

export type BandKey = 'range' | 'upTo' | 'above' | 'from' | 'fromTo' | 'any'

export interface BandText {
  readonly key: BandKey
  readonly values: { readonly from: string; readonly to: string }
}

const money = (satang: string) => formatSatang(BigInt(satang))

export function bandText(band: { readonly gt?: string | null; readonly gte?: string | null; readonly lte?: string | null } | null): BandText {
  const to = band?.lte ? money(band.lte) : ''
  if (!band) return { key: 'any', values: { from: '', to } }
  if (band.gte !== undefined && band.gte !== null) {
    return { key: band.lte ? 'fromTo' : 'from', values: { from: money(band.gte), to } }
  }
  const lower = band.gt !== undefined && band.gt !== null && BigInt(band.gt) > 0n ? money(band.gt) : null
  if (lower && band.lte) return { key: 'range', values: { from: lower, to } }
  if (lower) return { key: 'above', values: { from: lower, to } }
  return band.lte ? { key: 'upTo', values: { from: '', to } } : { key: 'any', values: { from: '', to } }
}
