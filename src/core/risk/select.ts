import { evaluateCondition, type Condition, type FormInput } from '../forms'
import { RISK_TIER_CODES, SCREENING_FIELDS, type RiskCondition, type RiskContext, type RiskPolicyDef, type RiskQuestionDef, type RiskTierCode } from './types'

// BR-RSK-01 and BR-RSK-03: the tier from the screening answers and the line categories, and the questions an assessment
// asks. Pure.

const rank = (t: RiskTierCode): number => RISK_TIER_CODES.indexOf(t)

/** The higher of two tiers in the order of the enum */
export function maxTier(a: RiskTierCode, b: RiskTierCode): RiskTierCode {
  return rank(b) > rank(a) ? b : a
}

/**
 * BR-RSK-03: the highest tier that the policy gives a screening answer Y, and HIGH when a line category is one of the
 * policy's high-risk categories; LOW when nothing matches.
 */
export function inherentTier(context: Pick<RiskContext, 'screening' | 'categoryCodes'>, policy: RiskPolicyDef): RiskTierCode {
  let tier: RiskTierCode = 'LOW'
  for (const field of SCREENING_FIELDS) if (context.screening[field] === 'Y') tier = maxTier(tier, policy.screeningTierMap[field])
  if (context.categoryCodes.some((c) => policy.highRiskCategories.includes(c))) tier = 'HIGH'
  return tier
}

/** BR-RSK-01: a condition holds on the context; anyIn = the set $category and the list share a member */
export function riskConditionHolds(when: RiskCondition, context: RiskContext, inherent: RiskTierCode): boolean {
  if ('all' in when) return when.all.every((c) => riskConditionHolds(c, context, inherent))
  if ('any' in when) return when.any.some((c) => riskConditionHolds(c, context, inherent))
  if (when.op === 'anyIn') {
    const set = when.field === '$category' ? context.categoryCodes : []
    return Array.isArray(when.value) && when.value.some((v) => set.includes(String(v)))
  }
  const fields: Record<string, unknown> = {
    ...context.screening,
    $category: context.categoryCodes,
    $payeeType: context.payeeType,
    $isForeign: context.isForeign,
    $inherentTier: inherent,
  }
  const input: FormInput = { fields, attachments: {}, variables: { $amountGross: 0n, $amountNet: 0n, $requestType: 'RISK_ASSESSMENT' } }
  return evaluateCondition(when as Condition, input)
}

/** The questions in the assessment's set, in sortOrder (BR-RSK-01) */
export function questionsInSet(questions: readonly RiskQuestionDef[], context: RiskContext, inherent: RiskTierCode): readonly RiskQuestionDef[] {
  return questions
    .filter((q) => !q.appliesWhen || riskConditionHolds(q.appliesWhen, context, inherent))
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

export interface QuestionSet {
  readonly inherentTier: RiskTierCode
  /** Question codes in sortOrder */
  readonly questions: readonly string[]
}

/** BR-RSK-01 with BR-RSK-03: the tier from screening and the questions the assessment asks */
export function selectQuestions(questions: readonly RiskQuestionDef[], context: RiskContext, policy: RiskPolicyDef): QuestionSet {
  const inherent = inherentTier(context, policy)
  return { inherentTier: inherent, questions: questionsInSet(questions, context, inherent).map((q) => q.code) }
}
