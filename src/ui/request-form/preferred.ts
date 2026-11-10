import type { FormValues } from './model'
import type { PreferredSupplierOption } from './types'

// The preferred suppliers of the request form (S10-13 · BR-FORM-02 BR-FORM-12 BR-RFX-14 · FR-SRC-204 AC7), as the screen
// works them out while the requester types; the server checks the same at submit (src/server/services/sourcing/
// preferred.ts checkPreferredOverride). A line's category is that of its catalogue item. The request's suggested supplier
// is the supplier of its lines (as for agreed prices), so a category is kept to when the suggested supplier is one of its
// preferred suppliers in effect today; otherwise the form warns and asks the reason before sending — unless every
// preferred supplier of the category is one S11 would stop (riskExempt, RISK on). Choosing an item when no supplier is
// suggested yet fills its category's preferred supplier (the latest validFrom the form offers) before anything else.
// Only a form that offers the catalogue knows the categories (the LIFF form leaves this to the server). Pure.

/** The categories of the form's lines, in their order: those of the catalogue items the form knows */
export function lineCategories(values: Pick<FormValues, 'lines' | 'catalog'>): string[] {
  const out: string[] = []
  for (const l of values.lines) {
    const code = l.catalogItemId ? values.catalog?.[l.catalogItemId]?.categoryCode : undefined
    if (code && !out.includes(code)) out.push(code)
  }
  return out
}

/** A category's preferred suppliers in effect today, latest validFrom first (as the server sends them) */
export function preferredOfCategory(values: Pick<FormValues, 'preferred'>, categoryCode: string): PreferredSupplierOption[] {
  return (values.preferred ?? []).filter((p) => p.categoryCode === categoryCode)
}

/** The supplier to fill for an item of `categoryCode` when none is suggested yet: its first preferred one the form offers */
export function preferredToSuggest(values: Pick<FormValues, 'preferred'>, categoryCode: string, offered: readonly string[]): string | null {
  return preferredOfCategory(values, categoryCode).find((p) => offered.includes(p.supplierId))?.supplierId ?? null
}

export interface PreferredState {
  /** The preferred suppliers the request keeps to (one per category: the suggested supplier's row) */
  readonly kept: readonly PreferredSupplierOption[]
  /** Categories whose preferred suppliers the request leaves: the first of each (the one the form would fill) */
  readonly left: readonly PreferredSupplierOption[]
  /** Some category left is not risk-exempt: the reason is needed before sending */
  readonly asksReason: boolean
}

export function preferredState(values: Pick<FormValues, 'lines' | 'catalog' | 'preferred' | 'suggestedSupplierId'>): PreferredState {
  const kept: PreferredSupplierOption[] = []
  const left: PreferredSupplierOption[] = []
  let asksReason = false
  for (const code of lineCategories(values)) {
    const rows = preferredOfCategory(values, code)
    if (rows.length === 0) continue
    const mine = rows.find((r) => r.supplierId === values.suggestedSupplierId)
    if (mine) {
      kept.push(mine)
      continue
    }
    left.push(rows[0]!)
    if (!rows.every((r) => r.riskExempt)) asksReason = true
  }
  return { kept, left, asksReason }
}

/** What the preferred suppliers still need before sending (the server refuses the same: PREFERRED_OVERRIDE_REASON) */
export type PreferredProblem = { readonly kind: 'PREFERRED_REASON' }

export function preferredProblems(values: FormValues): PreferredProblem[] {
  return preferredState(values).asksReason && !(values.preferredSupplierOverrideReason ?? '').trim() ? [{ kind: 'PREFERRED_REASON' }] : []
}

/** Whether the form shows the reason box: a category's preferred supplier is left, or a reason is kept from before */
export function showsPreferredReason(values: FormValues): boolean {
  if (values.preferredSupplierOverrideReason === undefined) return false
  return values.preferredSupplierOverrideReason.trim() !== '' || preferredState(values).left.length > 0
}

/** The last day a preferred supplier is in effect: the day before validTo (not included) */
export function lastPreferredDay(validTo: string): string {
  const d = new Date(`${validTo}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}
