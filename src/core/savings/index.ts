import { MS_PER_DAY } from '../money/constants'
import { lineNet, type Satang } from '../money/math'
import { agreementsInEffect, type AgreementPeriod } from '../pricing/agreement'
import { priceReference, type PriceRefSettings } from '../pricing/reference'

// The savings the assistant finds (spec §7.21, BR-SAV-01 to BR-SAV-06 · NEW-123 · ADR-084). Pure: the caller gives the
// request lines still to be ordered, the lines of approved POs and the agreed prices; every amount is the difference of
// two line amounts (BR-MONEY-02 (1)), so nothing is rounded here. No new threshold: a price above history is the HIGH
// of the price reference (BR-PRC-03) with enough samples, an agreed price is one in effect today (BR-PRC-06), and an
// agreement ending soon uses the home card's 30 days (ADR-078). The AI only words what these numbers say.

export const SAVINGS_KINDS = ['PRICE_ABOVE_HISTORY', 'OFF_AGREEMENT', 'SAME_ITEM_DEPARTMENTS', 'AGREEMENT_EXPIRING'] as const
export type SavingsKind = (typeof SAVINGS_KINDS)[number]

/** A request line with a quantity still to be ordered: its request waits for approval, or is approved and in the pool */
export interface OpenLine {
  readonly ref: string
  readonly stage: 'PENDING_APPROVAL' | 'POOL'
  /** BR-DUP-01 */
  readonly key: string
  readonly kind: 'GOODS' | 'SERVICE'
  /** The department charged */
  readonly departmentId: string
  readonly siteId: string | null
  readonly catalogItemId: string | null
  /** The supplier chosen in the pool, else the one the requester suggests; null: none yet */
  readonly supplierId: string | null
  /** Still to be ordered, decimal text (×10⁴ at most) */
  readonly quantity: string
  readonly unitPriceSatang: Satang
  readonly priceIncludesVat: boolean
}

/** A line of a PO approved and not rejected or cancelled (BR-PRC-01) */
export interface Purchase {
  readonly ref: string
  /** BR-DUP-01 */
  readonly key: string
  readonly approvedAt: Date
  readonly unitPriceSatang: Satang
  readonly priceIncludesVat: boolean
  /**
   * The agreed prices its request lines took (BR-PRC-06), each with the quantity bought at it: what the sources at that
   * price order, never more than the line kept after what was cancelled
   */
  readonly agreements: ReadonlyArray<{ readonly id: string; readonly quantity: string }>
}

export interface SavingsAgreement extends AgreementPeriod {
  readonly id: string
  /** Before VAT */
  readonly unitPriceSatang: Satang
  /** Ended by PROCUREMENT (BR-PRC-06): it still holds to its last day but is not one to renew */
  readonly ended: boolean
}

export interface SavingsSettings extends PriceRefSettings {
  readonly at: Date
  /** The Thai calendar day of `at`, YYYY-MM-DD (agreementDay) */
  readonly today: string
  /** An agreement ending within this many days is listed (the home card's AGREEMENT_DAYS) */
  readonly agreementDays: number
}

export interface LineSaving {
  readonly ref: string
  readonly savingSatang: Satang
}

export type Opportunity =
  | {
      readonly kind: 'PRICE_ABOVE_HISTORY'
      readonly line: string
      readonly savingSatang: Satang
      /** The lower median of the samples (BR-PRC-02) */
      readonly referenceSatang: Satang
      readonly minSatang: Satang
      readonly maxSatang: Satang
      readonly count: number
      readonly deviationBp: number
      /** The purchases the median comes from, the latest first */
      readonly purchases: readonly string[]
    }
  | {
      readonly kind: 'OFF_AGREEMENT'
      readonly line: string
      readonly savingSatang: Satang
      /** The lowest agreed price of the item in effect today */
      readonly agreementId: string
      readonly agreedSatang: Satang
    }
  | {
      readonly kind: 'SAME_ITEM_DEPARTMENTS'
      /** Every line of the group in request-line order, each with what the lowest price saves on it */
      readonly lines: readonly LineSaving[]
      readonly savingSatang: Satang
      readonly lowestSatang: Satang
      readonly lowestLine: string
      readonly departments: number
    }
  | {
      readonly kind: 'AGREEMENT_EXPIRING'
      readonly agreementId: string
      /** Days it still holds, today included */
      readonly daysLeft: number
      /** What was bought at this price in the window */
      readonly spentSatang: Satang
      /** Those purchases, the latest first */
      readonly purchases: readonly string[]
      readonly savingSatang: null
    }

export interface Savings {
  /** The largest saving first; agreements ending soon last, the soonest first */
  readonly opportunities: readonly Opportunity[]
  /** Σ over request lines of the largest saving any opportunity finds on the line: a line is counted once (BR-SAV-06) */
  readonly totalSatang: Satang
}

const dayNumber = (day: string) => new Date(`${day}T00:00:00Z`).getTime() / MS_PER_DAY
const byRef = (a: { ref: string }, b: { ref: string }) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)
/** What buying `quantity` at `lower` instead of `price` saves: two line amounts, each rounded once (BR-MONEY-02 (1)) */
const savedOn = (quantity: string, price: Satang, lower: Satang) => lineNet(quantity, price) - lineNet(quantity, lower)
const latestFirst = (a: Purchase, b: Purchase) => b.approvedAt.getTime() - a.approvedAt.getTime() || byRef(a, b)

/**
 * BR-SAV-01: a line of goods priced before VAT whose price reference is HIGH on enough samples, against the median. A
 * service is often priced as one job whose scope differs from the last (a hospital's plumbing against a warehouse's), so
 * its difference is no amount the code can claim; its approver still sees the reference's badge (BR-PRC-03)
 */
function aboveHistory(line: OpenLine, purchases: readonly Purchase[], settings: SavingsSettings): Opportunity | null {
  if (line.priceIncludesVat || line.kind !== 'GOODS') return null
  const own = purchases.filter((p) => p.key === line.key)
  const r = priceReference(own, line.unitPriceSatang, false, settings.at, settings)
  if (r.alert !== 'HIGH' || r.status !== 'OK' || r.median === null || r.deviationBp === null) return null
  const savingSatang = savedOn(line.quantity, line.unitPriceSatang, r.median)
  if (savingSatang <= 0n) return null
  const from = settings.at.getTime() - settings.windowDays * MS_PER_DAY
  const used = own.filter((p) => !p.priceIncludesVat && p.approvedAt.getTime() >= from && p.approvedAt.getTime() < settings.at.getTime())
  return {
    kind: 'PRICE_ABOVE_HISTORY',
    line: line.ref,
    savingSatang,
    referenceSatang: r.median,
    minSatang: r.min!,
    maxSatang: r.max!,
    count: r.count,
    deviationBp: r.deviationBp,
    purchases: [...used].sort(latestFirst).map((p) => p.ref),
  }
}

/**
 * The agreed prices a line could still be bought at: in effect, and not ended — an ended one holds for its last day only
 * (BR-PRC-06), so no order still to be placed is counted against it — the lowest first, the smaller id on a tie
 */
export function agreementsToBuyAt<A extends SavingsAgreement>(agreements: readonly A[], catalogItemId: string, today: string): A[] {
  return agreementsInEffect(agreements, catalogItemId, today)
    .filter((a) => !a.ended)
    .sort((a, b) => (a.unitPriceSatang < b.unitPriceSatang ? -1 : a.unitPriceSatang > b.unitPriceSatang ? 1 : a.id < b.id ? -1 : 1))
}

/**
 * BR-SAV-02: a catalogue line priced before VAT whose supplier has none of the item's agreed prices in effect today (an
 * ended one still holds today), against the lowest one it could still be bought at
 */
function offAgreement(line: OpenLine, agreements: readonly SavingsAgreement[], settings: SavingsSettings): Opportunity | null {
  if (line.priceIncludesVat || !line.catalogItemId) return null
  if (agreementsInEffect(agreements, line.catalogItemId, settings.today).some((a) => a.supplierId === line.supplierId)) return null
  const best = agreementsToBuyAt(agreements, line.catalogItemId, settings.today)[0]
  if (!best) return null
  const savingSatang = savedOn(line.quantity, line.unitPriceSatang, best.unitPriceSatang)
  return savingSatang > 0n ? { kind: 'OFF_AGREEMENT', line: line.ref, savingSatang, agreementId: best.id, agreedSatang: best.unitPriceSatang } : null
}

/**
 * BR-SAV-03: lines of goods in the pool priced before VAT for the same thing (key and delivery site — what one PO may
 * hold, BR-CONS-01 without the supplier) from two departments or more, each at the group's lowest price; services are
 * left out as in BR-SAV-01
 */
function sameItem(lines: readonly OpenLine[]): Opportunity[] {
  const groups = new Map<string, OpenLine[]>()
  for (const l of [...lines].sort(byRef)) {
    if (l.stage !== 'POOL' || l.priceIncludesVat || l.kind !== 'GOODS') continue
    const k = JSON.stringify([l.key, l.siteId])
    groups.set(k, [...(groups.get(k) ?? []), l])
  }
  const out: Opportunity[] = []
  for (const group of groups.values()) {
    const departments = new Set(group.map((l) => l.departmentId)).size
    if (departments < 2) continue
    const lowest = group.reduce((m, l) => (l.unitPriceSatang < m.unitPriceSatang ? l : m))
    const saved = group.map((l) => ({ ref: l.ref, savingSatang: savedOn(l.quantity, l.unitPriceSatang, lowest.unitPriceSatang) }))
    const savingSatang = saved.reduce((s, l) => s + l.savingSatang, 0n)
    if (savingSatang > 0n) out.push({ kind: 'SAME_ITEM_DEPARTMENTS', lines: saved, savingSatang, lowestSatang: lowest.unitPriceSatang, lowestLine: lowest.ref, departments })
  }
  return out
}

/**
 * BR-SAV-04: agreed prices in effect today, not ended, whose last day falls within `agreementDays` and that no agreement
 * of the same item and supplier continues from their end; with what was bought at them in the window
 */
function expiring(agreements: readonly SavingsAgreement[], purchases: readonly Purchase[], settings: SavingsSettings): Opportunity[] {
  const today = dayNumber(settings.today)
  const from = settings.at.getTime() - settings.windowDays * MS_PER_DAY
  return agreements
    .filter((a) => !a.ended && a.validFrom <= settings.today && settings.today < a.validTo && dayNumber(a.validTo) - today <= settings.agreementDays)
    .filter((a) => !agreements.some((b) => b.id !== a.id && !b.ended && b.catalogItemId === a.catalogItemId && b.supplierId === a.supplierId && b.validFrom === a.validTo))
    .sort((a, b) => (a.validTo < b.validTo ? -1 : a.validTo > b.validTo ? 1 : a.id < b.id ? -1 : 1))
    .map((a): Opportunity => {
      const bought = purchases
        .filter((p) => p.agreements.some((g) => g.id === a.id) && !p.priceIncludesVat && p.approvedAt.getTime() >= from && p.approvedAt.getTime() < settings.at.getTime())
        .sort(latestFirst)
      // what each line bought at this price, its own amount (BR-MONEY-02 (1))
      const spentSatang = bought.reduce((s, p) => s + lineNet(p.agreements.find((g) => g.id === a.id)!.quantity, p.unitPriceSatang), 0n)
      return {
        kind: 'AGREEMENT_EXPIRING',
        agreementId: a.id,
        daysLeft: dayNumber(a.validTo) - today,
        spentSatang,
        purchases: bought.map((p) => p.ref),
        savingSatang: null,
      }
    })
}

const firstRef = (o: Opportunity) => (o.kind === 'SAME_ITEM_DEPARTMENTS' ? o.lines[0]!.ref : o.kind === 'AGREEMENT_EXPIRING' ? o.agreementId : o.line)

/** BR-SAV-05: every opportunity of the organization's open lines, purchases and agreed prices, and the total (BR-SAV-06) */
export function findSavings(input: { readonly lines: readonly OpenLine[]; readonly purchases: readonly Purchase[]; readonly agreements: readonly SavingsAgreement[] }, settings: SavingsSettings): Savings {
  const lines = [...input.lines].sort(byRef)
  const saving: Opportunity[] = [
    ...lines.flatMap((l) => [aboveHistory(l, input.purchases, settings), offAgreement(l, input.agreements, settings)].filter((o): o is Opportunity => o !== null)),
    ...sameItem(lines),
  ].sort((a, b) => {
    const d = b.savingSatang! - a.savingSatang!
    if (d !== 0n) return d > 0n ? 1 : -1
    return SAVINGS_KINDS.indexOf(a.kind) - SAVINGS_KINDS.indexOf(b.kind) || (firstRef(a) < firstRef(b) ? -1 : firstRef(a) > firstRef(b) ? 1 : 0)
  })
  // A line two opportunities find (above history and off agreement) counts its larger saving only
  const largest = new Map<string, Satang>()
  const keep = (ref: string, s: Satang) => largest.set(ref, (largest.get(ref) ?? 0n) > s ? largest.get(ref)! : s)
  for (const o of saving) {
    if (o.kind === 'SAME_ITEM_DEPARTMENTS') for (const l of o.lines) keep(l.ref, l.savingSatang)
    else if (o.kind !== 'AGREEMENT_EXPIRING') keep(o.line, o.savingSatang)
  }
  return {
    opportunities: [...saving, ...expiring(input.agreements, input.purchases, settings)],
    totalSatang: [...largest.values()].reduce((s, v) => s + v, 0n),
  }
}
