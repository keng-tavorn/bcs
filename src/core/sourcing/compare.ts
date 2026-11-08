import { allocateLargestRemainder, lineNet, vatFromGross, vatFromNet, type Satang } from '../money/math'

// The comparison table of an RFx (spec §7.23, BR-RFX-08 · S10-03). Pure: the caller passes the RFx lines and the bids
// as stored (unit prices as the supplier quoted them, the VAT flag and the rate snapshot of the bid). Bids are compared
// by their amount before VAT, like the quotations of BR-FORM-06; nothing but BR-MONEY-02's points is rounded, so the
// table is always recomputed from the stored unit prices (INV-RFX-05).

export interface RfxLineInput {
  readonly ref: string
  /** Decimal string, up to 4 places (BR-MONEY-01) */
  readonly quantity: string
}

export interface BidInput {
  readonly ref: string
  /** The quoted unit prices include VAT (OQ-212) */
  readonly priceIncludesVat: boolean
  /** The rate of the bid: 0 for a supplier not registered for VAT or abroad (BR-VAT-04) */
  readonly vatRateBp: number
  /** Unit price as quoted, per RFx line ref; a line the bid does not offer is absent */
  readonly unitPrices: Readonly<Record<string, Satang>>
}

export interface BidComparison {
  readonly ref: string
  readonly net: Satang
  readonly vat: Satang
  readonly gross: Satang
  /** The bid leaves out at least one line of the RFx */
  readonly partial: boolean
  /** Amount before VAT per offered line, in the RFx's line order; adds up to `net` exactly */
  readonly lineNet: ReadonlyArray<readonly [string, Satang]>
}

export interface Comparison {
  /** In the order the bids were given */
  readonly bids: readonly BidComparison[]
  /** Every complete bid at the lowest amount before VAT, in the order given; empty without a complete bid */
  readonly lowest: readonly string[]
  readonly lowestNet: Satang | null
  /** Per RFx line, the bid with the lowest amount before VAT on it (the first given on a tie); lines nobody offers are absent */
  readonly lineLowest: ReadonlyArray<readonly [string, string]>
}

function compareBid(lines: readonly RfxLineInput[], bid: BidInput): BidComparison {
  const offered = lines.filter((l) => bid.unitPrices[l.ref] !== undefined)
  const quoted = offered.map((l) => lineNet(l.quantity, bid.unitPrices[l.ref]!))
  const total = quoted.reduce((a, b) => a + b, 0n)
  let net: Satang
  let vat: Satang
  let parts: Satang[]
  if (bid.priceIncludesVat) {
    ;({ vat, net } = vatFromGross(total, bid.vatRateBp))
    parts = allocateLargestRemainder(net, quoted)
  } else {
    net = total
    vat = vatFromNet(net, bid.vatRateBp).vat
    parts = quoted
  }
  return { ref: bid.ref, net, vat, gross: net + vat, partial: offered.length < lines.length, lineNet: offered.map((l, i) => [l.ref, parts[i]!] as const) }
}

/** BR-RFX-08: the comparison table — per bid its amounts and lines before VAT, the lowest complete bids, the lowest per line */
export function compareBids(lines: readonly RfxLineInput[], bids: readonly BidInput[]): Comparison {
  const rows = bids.map((b) => compareBid(lines, b))
  const complete = rows.filter((r) => !r.partial)
  const lowestNet = complete.length ? complete.reduce((m, r) => (r.net < m ? r.net : m), complete[0]!.net) : null
  const lineLowest: Array<readonly [string, string]> = []
  for (const line of lines) {
    let best: { ref: string; amount: Satang } | null = null
    for (const row of rows) {
      const hit = row.lineNet.find(([ref]) => ref === line.ref)
      if (hit && (best === null || hit[1] < best.amount)) best = { ref: row.ref, amount: hit[1] }
    }
    if (best) lineLowest.push([line.ref, best.ref])
  }
  return { bids: rows, lowest: complete.filter((r) => r.net === lowestNet).map((r) => r.ref), lowestNet, lineLowest }
}
