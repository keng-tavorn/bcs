import { BP_PER_WHOLE, MS_PER_DAY } from '../money/constants'
import { vatFromGross, type Satang } from '../money/math'

// The price reference of an approval card (spec §7.17, BR-PRC-01 to BR-PRC-04 · ADR-108). Pure: the caller gives the
// lines of approved POs with the same line key (BR-DUP-01) and the settings; money in satang, never rounded here.

export interface PriceSample {
  readonly unitPriceSatang: Satang
  readonly approvedAt: Date
  /** The PO's prices include VAT: left out of the statistics and counted apart (BR-PRC-01) */
  readonly priceIncludesVat: boolean
}

export interface PriceRefSettings {
  readonly windowDays: number
  readonly minSamples: number
  /** HIGH or LOW when the price is further than this from the median, in basis points (BR-PRC-03) */
  readonly alertBp: number
}

export interface PriceStats {
  readonly count: number
  readonly excludedVatIncluded: number
  readonly min: Satang | null
  readonly median: Satang | null
  readonly max: Satang | null
  /** The price of the latest approvedAt */
  readonly last: Satang | null
  readonly status: 'OK' | 'FEW_SAMPLES'
}

export interface PriceReference extends PriceStats {
  /** (price − median) × 10000 ÷ median, truncated toward zero; null without a median or when the request includes VAT */
  readonly deviationBp: number | null
  readonly alert: 'HIGH' | 'LOW' | null
}




/** BR-PRC-01 and BR-PRC-02: the samples of [at − windowDays, at) priced before VAT, and their statistics */
export function priceStats(samples: readonly PriceSample[], at: Date, settings: PriceRefSettings): PriceStats {
  const from = at.getTime() - settings.windowDays * MS_PER_DAY
  const inWindow = samples.filter((s) => s.approvedAt.getTime() >= from && s.approvedAt.getTime() < at.getTime())
  const used = inWindow.filter((s) => !s.priceIncludesVat)
  const sorted = used.map((s) => s.unitPriceSatang).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  // On the same instant the later sample in the order given wins (the caller orders them by approval)
  const latest = used.reduce<PriceSample | null>((l, s) => (l === null || s.approvedAt.getTime() >= l.approvedAt.getTime() ? s : l), null)
  return {
    count: used.length,
    excludedVatIncluded: inWindow.length - used.length,
    min: sorted[0] ?? null,
    median: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : null,
    max: sorted.at(-1) ?? null,
    last: latest?.unitPriceSatang ?? null,
    status: used.length < settings.minSamples ? 'FEW_SAMPLES' : 'OK',
  }
}

/** BR-PRC-03: the request's unit price against the median of its samples */
export function priceReference(samples: readonly PriceSample[], price: Satang, requestIncludesVat: boolean, at: Date, settings: PriceRefSettings): PriceReference {
  const stats = priceStats(samples, at, settings)
  const median = stats.median
  if (median === null || median === 0n || requestIncludesVat) return { ...stats, deviationBp: null, alert: null }
  // bigint division truncates toward zero
  const deviationBp = Number(((price - median) * BP_PER_WHOLE) / median)
  const threshold = median * BigInt(settings.alertBp)
  const alert = (price - median) * BP_PER_WHOLE > threshold ? 'HIGH' : (median - price) * BP_PER_WHOLE > threshold ? 'LOW' : null
  return { ...stats, deviationBp, alert }
}

export interface QuoteInput {
  readonly ref: string
  readonly amountSatang: Satang
  readonly includesVat: boolean
}

export interface QuoteRange {
  readonly count: number
  readonly lowest: Satang | null
  readonly highest: Satang | null
  readonly selected: Satang | null
  readonly selectedIsLowest: boolean
}

/** BR-PRC-04: the quotations of the request before VAT (BR-FORM-06), lowest, highest and the one chosen */
export function quoteRange(quotes: readonly QuoteInput[], selectedRef: string | null, vatRateBp: number): QuoteRange {
  const nets = new Map(quotes.map((q) => [q.ref, q.includesVat ? vatFromGross(q.amountSatang, vatRateBp).net : q.amountSatang]))
  const values = [...nets.values()]
  const lowest = values.reduce<Satang | null>((m, v) => (m === null || v < m ? v : m), null)
  const highest = values.reduce<Satang | null>((m, v) => (m === null || v > m ? v : m), null)
  const selected = selectedRef === null ? null : (nets.get(selectedRef) ?? null)
  return { count: quotes.length, lowest, highest, selected, selectedIsLowest: selected !== null && selected === lowest }
}

export interface CardBadge {
  /** Lines with HIGH, and the largest deviation among them in whole percent (deviationBp ÷ 100 truncated toward zero) */
  readonly high: { readonly lines: number; readonly maxPct: number } | null
  /** Lines with LOW, and the lowest deviation among them in whole percent (negative) */
  readonly low: { readonly lines: number; readonly minPct: number } | null
}

/**
 * BR-PRC-05: the one price badge of a LINE approval card, for the whole request — counts and the furthest deviation
 * only, never an item's name, a unit price or an AI summary (BR-NOTI-01 · OQ-107). null when no line is HIGH or LOW.
 */
export function cardBadge(lines: ReadonlyArray<Pick<PriceReference, 'deviationBp' | 'alert'>>): CardBadge | null {
  const pct = (bp: number) => Math.trunc(bp / 100)
  const highs = lines.filter((l) => l.alert === 'HIGH' && l.deviationBp !== null).map((l) => l.deviationBp!)
  const lows = lines.filter((l) => l.alert === 'LOW' && l.deviationBp !== null).map((l) => l.deviationBp!)
  if (highs.length === 0 && lows.length === 0) return null
  return {
    high: highs.length ? { lines: highs.length, maxPct: pct(Math.max(...highs)) } : null,
    low: lows.length ? { lines: lows.length, minPct: pct(Math.min(...lows)) } : null,
  }
}
