import { amountToSatang, satangToAmount } from '@/core/money/dto'
import type { FormLine, FormValues } from './model'
import type { CatalogItemOption } from './types'

// The request form's lines from the catalogue (S6-10 · FR-INT-102 AC2 · BR-PRC-06), as the screen works them out while
// the requester types; the server checks the same on every save and at submit (src/server/services/requests/
// catalog-lines.ts). The request's suggested supplier is the supplier of its lines: a line of an item with an agreed
// price with that supplier takes exactly that price before VAT (the price is locked); an item whose agreed prices are
// all with other suppliers needs the request's reason (offAgreementReason) before sending. Choosing an item when no
// supplier is suggested yet suggests the supplier of its lowest agreed price. Money as baht text, compared as satang
// (never floating point). Pure.

export interface CatalogAgreementPick {
  readonly supplierId: string
  readonly supplierCode: string
  readonly supplierName: string
  /** Before VAT, baht text with two decimals */
  readonly unitPrice: string
}

/** An item of the catalogue as a line of the form takes it */
export interface CatalogPick {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly uom: string
  readonly categoryCode: string
  /** Before VAT, baht text with two decimals */
  readonly refUnitPrice: string
  /** The agreed prices in effect today */
  readonly agreements: readonly CatalogAgreementPick[]
}

export function catalogPickOf(item: CatalogItemOption): CatalogPick {
  return {
    id: item.id,
    code: item.code,
    nameTh: item.nameTh,
    nameEn: item.nameEn,
    uom: item.uom,
    categoryCode: item.categoryCode,
    refUnitPrice: satangToAmount(BigInt(item.refUnitPriceSatang)),
    agreements: item.agreements.map((a) => ({ supplierId: a.supplierId, supplierCode: a.supplierCode, supplierName: a.supplierName, unitPrice: satangToAmount(BigInt(a.unitPriceSatang)) })),
  }
}

/** The items a form knows, by id */
export function catalogIndex(items: readonly CatalogItemOption[]): Readonly<Record<string, CatalogPick>> {
  return Object.fromEntries(items.map((i) => [i.id, catalogPickOf(i)]))
}

/** The item's agreed price with a supplier, or null */
export function agreementWith(item: CatalogPick, supplierId: string | null | undefined): CatalogAgreementPick | null {
  return supplierId ? (item.agreements.find((a) => a.supplierId === supplierId) ?? null) : null
}

/** The supplier to suggest for an item when none is suggested yet: the one of its lowest agreed price the form offers */
export function supplierToSuggest(item: CatalogPick, offered: readonly string[]): string | null {
  let best: CatalogAgreementPick | null = null
  for (const a of item.agreements) {
    if (!offered.includes(a.supplierId)) continue
    if (best === null || amountToSatang(a.unitPrice) < amountToSatang(best.unitPrice)) best = a
  }
  return best?.supplierId ?? null
}

/**
 * What a line of the form is to the catalogue:
 * - NONE: typed freely, or a catalogue line of a form that does not know the catalogue (the LIFF form: the server checks)
 * - UNLISTED: its item is no longer in the catalogue (taken out since the line was saved)
 * - LISTED: an item without agreed prices
 * - LOCKED: the item's agreed price with the suggested supplier, which the line must take
 * - OFF: the item has agreed prices, none with the suggested supplier (or none is suggested)
 */
export type LineAgreement =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'UNLISTED' }
  | { readonly kind: 'LISTED'; readonly item: CatalogPick }
  | { readonly kind: 'LOCKED'; readonly item: CatalogPick; readonly agreement: CatalogAgreementPick }
  | { readonly kind: 'OFF'; readonly item: CatalogPick }

export function lineAgreement(line: FormLine, values: Pick<FormValues, 'catalog' | 'suggestedSupplierId'>): LineAgreement {
  if (!line.catalogItemId) return { kind: 'NONE' }
  const item = values.catalog?.[line.catalogItemId]
  if (!item) return values.catalog ? { kind: 'UNLISTED' } : { kind: 'NONE' }
  if (item.agreements.length === 0) return { kind: 'LISTED', item }
  const agreement = agreementWith(item, values.suggestedSupplierId)
  return agreement ? { kind: 'LOCKED', item, agreement } : { kind: 'OFF', item }
}

/** Every catalogue line with an agreed price with the suggested supplier takes that price */
export function withAgreedPrices(values: FormValues): FormValues {
  let changed = false
  const lines = values.lines.map((line) => {
    const state = lineAgreement(line, values)
    if (state.kind !== 'LOCKED' || line.unitPrice === state.agreement.unitPrice) return line
    changed = true
    return { ...line, unitPrice: state.agreement.unitPrice }
  })
  return changed ? { ...values, lines } : values
}

/**
 * A line takes an item of the catalogue: its name, unit and id; the supplier of its lowest agreed price when none is
 * suggested yet (one of `offered`); then the agreed price with the suggested supplier. Without one, a price that is
 * blank — or was the agreed price of the item chosen before — takes the item's reference price (before VAT) when the
 * request's prices are before VAT.
 */
export function pickCatalogLine(values: FormValues, key: string, item: CatalogPick, offered: readonly string[]): FormValues {
  const before = values.lines.find((l) => l.key === key)
  if (!before) return values
  const wasLocked = lineAgreement(before, values).kind === 'LOCKED'
  const catalog = { ...(values.catalog ?? {}), [item.id]: item }
  const suggestedSupplierId = values.suggestedSupplierId || supplierToSuggest(item, offered) || ''
  const lines = values.lines.map((l) => (l.key === key ? { ...l, description: item.nameTh, uom: item.uom, catalogItemId: item.id } : l))
  const next = withAgreedPrices({ ...values, catalog, suggestedSupplierId, lines })
  const reference = /[1-9]/.test(item.refUnitPrice) && !values.priceIncludesVat && !agreementWith(item, suggestedSupplierId) && (wasLocked || !before.unitPrice.trim())
  return reference ? { ...next, lines: next.lines.map((l) => (l.key === key ? { ...l, unitPrice: item.refUnitPrice } : l)) } : next
}

/** The line is typed freely from now on: its words and price stay */
export function unlinkCatalogLine(values: FormValues, key: string): FormValues {
  return { ...values, lines: values.lines.map((l) => (l.key === key ? { ...l, catalogItemId: null } : l)) }
}

/** What the catalogue still needs before sending (the server refuses the same) */
export type CatalogProblem =
  /** An item with agreed prices goes to another supplier: the request's reason (AGREEMENT_OFF) */
  | { readonly kind: 'AGREEMENT_REASON' }
  /** An agreed price is before VAT: the request's prices must be too (AGREEMENT_PRICE_BEFORE_VAT) */
  | { readonly kind: 'AGREEMENT_BEFORE_VAT'; readonly lineNo: number }
  /** The line's item is no longer in the catalogue (UNKNOWN catalogItemId) */
  | { readonly kind: 'CATALOG_UNLISTED'; readonly lineNo: number }

export function catalogProblems(values: FormValues): CatalogProblem[] {
  const problems: CatalogProblem[] = []
  let off = false
  values.lines.forEach((line, i) => {
    const state = lineAgreement(line, values)
    if (state.kind === 'UNLISTED') problems.push({ kind: 'CATALOG_UNLISTED', lineNo: i + 1 })
    if (state.kind === 'LOCKED' && values.priceIncludesVat) problems.push({ kind: 'AGREEMENT_BEFORE_VAT', lineNo: i + 1 })
    if (state.kind === 'OFF') off = true
  })
  if (off && !(values.offAgreementReason ?? '').trim()) problems.unshift({ kind: 'AGREEMENT_REASON' })
  return problems
}

/** Whether the reason for another supplier is asked: a catalogue line goes off its agreed prices, or a reason is kept */
export function asksOffAgreementReason(values: FormValues): boolean {
  return values.offAgreementReason !== undefined && (values.offAgreementReason.trim() !== '' || values.lines.some((l) => lineAgreement(l, values).kind === 'OFF'))
}
