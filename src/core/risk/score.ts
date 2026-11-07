import { inherentTier, maxTier, questionsInSet } from './select'
import type { RiskContext, RiskPolicyDef, RiskQuestionDef, RiskTierCode, RiskTierDef } from './types'

// BR-RSK-04 and BR-RSK-06: the points and tier of an assessment, and whether it may be sent. Pure.

export interface Score {
  readonly inherentTier: RiskTierCode
  readonly points: number
  readonly tierByPoints: RiskTierCode
  /** The highest minTier of the options answered; LOW when none sets one */
  readonly minTierFloor: RiskTierCode
  readonly tier: RiskTierCode
}

/** The tier whose minPoints is the highest at or below the points; the lowest tier when none is */
export function tierByPoints(points: number, tiers: readonly RiskTierDef[]): RiskTierCode {
  const sorted = tiers.slice().sort((a, b) => a.minPoints - b.minPoints)
  let tier: RiskTierCode = sorted[0]?.code ?? 'LOW'
  for (const t of sorted) if (t.minPoints <= points) tier = t.code
  return tier
}

/**
 * BR-RSK-04: points = the sum of the points of the options answered in the questions of the set (an answer that is not
 * an option of its question, or to a question outside the set, counts nothing); the tier is the highest of the tier by
 * points, the inherent tier and the minTier of each option answered.
 */
export function scoreAssessment(
  questions: readonly RiskQuestionDef[],
  tiers: readonly RiskTierDef[],
  policy: RiskPolicyDef,
  context: RiskContext,
  answers: Readonly<Record<string, string>>,
): Score {
  const inherent = inherentTier(context, policy)
  let points = 0
  let floor: RiskTierCode = 'LOW'
  for (const q of questionsInSet(questions, context, inherent)) {
    const option = q.options.find((o) => o.code === answers[q.code])
    if (!option) continue
    points += option.points
    if (option.minTier) floor = maxTier(floor, option.minTier)
  }
  const byPoints = tierByPoints(points, tiers)
  return { inherentTier: inherent, points, tierByPoints: byPoints, minTierFloor: floor, tier: maxTier(maxTier(byPoints, inherent), floor) }
}

/** Where an answer came from (RiskAnswer.source); NONE = not answered */
export type AnswerSource = 'EXPLICIT' | 'EVIDENCE' | 'ON_BEHALF' | 'NONE'

export interface Completeness {
  readonly complete: boolean
  /** Codes of the required questions with no answer that counts, in sortOrder */
  readonly missing: readonly string[]
}

/**
 * BR-RSK-06: every required question of the set has an answer; for a tier that requires explicit answers (HIGH), an
 * answer from evidence does not count until the contact confirms it.
 */
export function assessmentCompleteness(
  questions: readonly RiskQuestionDef[],
  tiers: readonly RiskTierDef[],
  policy: RiskPolicyDef,
  context: RiskContext,
  tier: RiskTierCode,
  sources: Readonly<Record<string, AnswerSource>>,
): Completeness {
  const explicitOnly = tiers.find((t) => t.code === tier)?.requiresExplicitAnswers === true
  const counts = (s: AnswerSource | undefined) => s !== undefined && s !== 'NONE' && !(explicitOnly && s === 'EVIDENCE')
  const missing = questionsInSet(questions, context, inherentTier(context, policy))
    .filter((q) => q.required !== false && !counts(sources[q.code]))
    .map((q) => q.code)
  return { complete: missing.length === 0, missing }
}
