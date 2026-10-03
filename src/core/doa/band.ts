import type { AmountCondition, DoaDocumentType, DoaRuleSnapshot, DoaVersionSnapshot, DoaWhen } from './types'

// Amount bands (BR-DOA-02): a rule's amount condition is the interval (lower, upper] in satang. "gte X" is the same as
// "gt X−1" because amounts are whole satang. A missing lower bound starts below zero; a missing upper bound has no end.

export interface Band {
  /** exclusive; null = no lower bound */
  readonly lower: bigint | null
  /** inclusive; null = no upper bound */
  readonly upper: bigint | null
}

export function bandOf(condition: AmountCondition): Band {
  const lower = condition.gt ?? (condition.gte !== undefined ? condition.gte - 1n : null)
  return { lower, upper: condition.lte ?? null }
}

export function inBand(amount: bigint, band: Band): boolean {
  return (band.lower === null || amount > band.lower) && (band.upper === null || amount <= band.upper)
}

/** Number of conditions in `when` (BR-DOA-03 ranks the more specific rule first). */
export function conditionCount(when: DoaWhen): number {
  return when.amount ? 1 : 0
}

/** The rule's conditions hold for this document. A rule with an amount band never matches a document without an amount. */
export function whenMatches(when: DoaWhen, basisAmount: bigint | null): boolean {
  if (when.amount) return basisAmount !== null && inBand(basisAmount, bandOf(when.amount))
  return true
}

/** A rule whose only condition is an amount band; such rules must cover (0, ∞) without gaps or overlaps (BR-DOA-08 (ก)). */
export function isAmountOnly(rule: DoaRuleSnapshot): boolean {
  return rule.when.amount !== undefined && conditionCount(rule.when) === 1
}

export type RuleChoice = { readonly kind: 'rule'; readonly rule: DoaRuleSnapshot } | { readonly kind: 'none' } | { readonly kind: 'ambiguous'; readonly rules: readonly DoaRuleSnapshot[] }

/**
 * BR-DOA-03: rules of the document type whose conditions hold, lowest priority first, then the most conditions; a tie
 * at the top is ambiguous. `among` narrows the candidates (used when escalating to the next band).
 */
export function chooseRule(
  version: DoaVersionSnapshot,
  documentType: DoaDocumentType,
  basisAmount: bigint | null,
  among: (rule: DoaRuleSnapshot) => boolean = () => true,
): RuleChoice {
  const candidates = version.rules.filter((r) => r.documentType === documentType && among(r) && whenMatches(r.when, basisAmount))
  if (candidates.length === 0) return { kind: 'none' }
  const rank = (r: DoaRuleSnapshot) => [r.priority, -conditionCount(r.when)] as const
  const sorted = [...candidates].sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1])
  const best = rank(sorted[0]!)
  const top = sorted.filter((r) => rank(r)[0] === best[0] && rank(r)[1] === best[1])
  return top.length === 1 ? { kind: 'rule', rule: top[0]! } : { kind: 'ambiguous', rules: top }
}

/** Distinct lower bounds of the document type's amount bands above `from`, nearest first (BR-DOA-06 escalation). */
export function higherBandLowers(version: DoaVersionSnapshot, documentType: DoaDocumentType, from: bigint | null): bigint[] {
  const lowers = new Set<bigint>()
  for (const rule of version.rules) {
    if (rule.documentType !== documentType || !rule.when.amount) continue
    const lower = bandOf(rule.when.amount).lower
    if (lower === null) continue
    if (from === null || lower > from) lowers.add(lower)
  }
  // The values are distinct (a Set), so no two compare equal
  return [...lowers].sort((a, b) => (a < b ? -1 : 1))
}
