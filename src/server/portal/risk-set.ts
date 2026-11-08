import { questionsInSet, RISK_DOMAINS, RISK_TIER_CODES, SCREENING_FIELDS, type RiskCondition, type RiskContext, type RiskDomain, type RiskQuestionDef, type RiskTierCode, type Screening } from '@/core/risk'
import type { PortalRiskAssessment, PortalRiskQuestion } from './queries-risk'

// The questions of an assessment's set as the portal shows them (S11-05 · BR-RSK-01 · BR-RSK-17): those whose
// appliesWhen holds on the assessment's own context (its screening, categories, payee type, the supplier's isForeign)
// and the inherent tier frozen at open, in sortOrder — the rule the service checks every answer against (questionsOf),
// read from @/core/risk because a portal page may not import it. Pure: it reads only the assessment it is given.

const yn = (v: unknown): 'Y' | 'N' => (v === 'Y' ? 'Y' : 'N')

function contextOf(a: PortalRiskAssessment): RiskContext {
  const s = (a.screening && typeof a.screening === 'object' ? a.screening : {}) as Record<string, unknown>
  const screening = Object.fromEntries(SCREENING_FIELDS.map((f) => [f, yn(s[f])])) as Screening
  return { screening, categoryCodes: a.categoryCodes, payeeType: a.payeeType, isForeign: a.isForeign }
}

/** The assessment's questions that it asks, in sortOrder; the points stay with the organization (BR-RSK-17) */
export function portalQuestionSet(assessment: PortalRiskAssessment): readonly PortalRiskQuestion[] {
  // enum RiskTierCode: always one of the three; the fallback only keeps the type exact
  const inherent: RiskTierCode = (RISK_TIER_CODES as readonly string[]).includes(assessment.inherentTier) ? (assessment.inherentTier as RiskTierCode) : 'LOW'
  const definitions: RiskQuestionDef[] = assessment.questions.map((q) => ({
    code: q.code,
    domain: (RISK_DOMAINS as readonly string[]).includes(q.domain) ? (q.domain as RiskDomain) : 'GENERAL',
    // the set reads no option: the portal never carries the points
    options: [],
    appliesWhen: (q.appliesWhen ?? null) as RiskCondition | null,
    required: q.required,
    sortOrder: q.sortOrder,
  }))
  const byCode = new Map(assessment.questions.map((q) => [q.code, q]))
  return questionsInSet(definitions, contextOf(assessment), inherent).flatMap((d) => {
    const q = byCode.get(d.code)
    return q ? [q] : []
  })
}
