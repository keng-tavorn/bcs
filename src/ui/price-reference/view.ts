// The price reference of a request as its screens show it (S6-11 · FR-DOA-101 AC1 AC2): the words translated and the
// money formatted (thousands separators, 2 decimals) by src/app/(workspace)/_tracking/price-reference.ts from
// getPriceReference's DTO. No imports: the workspace panel (./panel.tsx) and the LIFF list (./list.tsx, ADR-052) read it.

export type PriceAlert = 'HIGH' | 'LOW'

/** A figure there is none of yet (no price in the window, no quotation chosen) */
export const NO_FIGURE = '-'

export interface PriceLineView {
  readonly key: string
  /** The line's item */
  readonly title: string
  /** The request's unit price */
  readonly unitPrice: string
  readonly median: string
  readonly min: string
  readonly max: string
  readonly last: string
  /** "+12.50%", or why there is none: no median yet, or the request's prices include VAT */
  readonly deviation: string
  readonly alert: { readonly kind: PriceAlert; readonly label: string } | null
  /** How many prices the statistics read, and those that include VAT left out */
  readonly samples: string
  /** Fewer prices than the organization's priceRef.minSamples: said in words, the numbers still shown */
  readonly few: string | null
  /** The agreed price of the item with its supplier (BR-PRC-06) */
  readonly agreement: string | null
}

export interface PriceQuotesView {
  readonly title: string
  readonly rows: ReadonlyArray<{ readonly label: string; readonly value: string }>
  /** The chosen one is the lowest, or why it is not */
  readonly note: string | null
}

export interface PriceReferenceLabels {
  readonly list: string
  readonly item: string
  readonly unitPrice: string
  readonly median: string
  readonly min: string
  readonly max: string
  readonly range: string
  readonly last: string
  readonly deviation: string
  /** The unit of the money columns ("บาท"), read with each amount */
  readonly unit: string
}

export interface PriceReferenceView {
  /** The section's heading */
  readonly title: string
  readonly intro: string
  /** The request's prices include VAT: no deviation is computed (BR-PRC-03) */
  readonly vatNote: string | null
  readonly lines: readonly PriceLineView[]
  readonly quotes: PriceQuotesView | null
  readonly labels: PriceReferenceLabels
}
