// The kinds of what the home card "ผู้ช่วยเจอให้คุณ" shows (NEW-121 · ADR-078), shared by the service that finds them,
// the event that records a member setting one aside and the screen that words them. The order is the card's: the most
// pressing first.

export const SUGGESTION_KINDS = ['FOLLOW_OVERDUE', 'SUPPLIER_FLAGS', 'FOLLOW_DUE_SOON', 'REQUEST_FLAG', 'PRICE_HIGH', 'BUDGET_LOW', 'AGREEMENT_EXPIRING'] as const
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number]

export type SuggestionTone = 'DANGER' | 'WARN' | 'INFO'

export const SUGGESTION_TONE: Readonly<Record<SuggestionKind, SuggestionTone>> = {
  FOLLOW_OVERDUE: 'DANGER',
  SUPPLIER_FLAGS: 'DANGER',
  FOLLOW_DUE_SOON: 'WARN',
  REQUEST_FLAG: 'WARN',
  PRICE_HIGH: 'WARN',
  BUDGET_LOW: 'WARN',
  AGREEMENT_EXPIRING: 'INFO',
}

/** A suggestion's key: its kind, then what names the situation (a document and the state it was in) */
export const SUGGESTION_KEY_MAX = 200

/** How many the card shows */
export const SUGGESTION_SHOWN = 5

const TONE_ORDER: readonly SuggestionTone[] = ['DANGER', 'WARN', 'INFO']

/**
 * The card's order: the more pressing tone first; within a tone the earlier moment first (a due time, a date it ends),
 * those without one after; then the kinds in SUGGESTION_KINDS order, then the key, so the same list always reads the same
 */
export function rankSuggestions<T extends { readonly kind: SuggestionKind; readonly key: string; readonly at: Date | null }>(items: readonly T[]): T[] {
  const at = (s: T) => s.at?.getTime() ?? Number.MAX_SAFE_INTEGER
  return [...items].sort(
    (a, b) =>
      TONE_ORDER.indexOf(SUGGESTION_TONE[a.kind]) - TONE_ORDER.indexOf(SUGGESTION_TONE[b.kind]) ||
      at(a) - at(b) ||
      SUGGESTION_KINDS.indexOf(a.kind) - SUGGESTION_KINDS.indexOf(b.kind) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
}

export function kindOfKey(key: string): SuggestionKind | null {
  const kind = key.split(':', 1)[0]
  return (SUGGESTION_KINDS as readonly string[]).includes(kind ?? '') ? (kind as SuggestionKind) : null
}
