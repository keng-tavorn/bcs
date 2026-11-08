import { describe, expect, it } from 'vitest'
import {
  assessmentCompleteness,
  evidenceSource,
  inherentTier,
  scoreAssessment,
  selectQuestions,
  type AnswerSource,
  type CurrentAnswer,
  type EvidenceDocument,
  type RiskCondition,
  type RiskContext,
  type RiskDomain,
  type RiskPolicyDef,
  type RiskQuestionDef,
  type RiskTierCode,
  type RiskTierDef,
  type Screening,
} from '@/core/risk'
import { loadYaml } from './doa-fixtures'

// tests/golden/risk-tier.yaml (spec §7.24 · S11-03): GC-RSK-01 to 24, the inherent tier, the question set, points and
// tier, answers from evidence and completeness of a supplier risk assessment (BR-RSK-01 BR-RSK-03 to BR-RSK-06). The
// file writes a question's options as { code: points }, its evidence option and minTier per option code; the order of
// the questions in the file is their sortOrder.

interface QuestionIn {
  code: string
  domain: RiskDomain
  options: Record<string, number>
  appliesWhen?: RiskCondition
  minTier?: Record<string, RiskTierCode>
  evidenceOption?: string
  evidenceScopeRequired?: boolean
  evidenceScope?: string
}
interface Input {
  screening?: Screening
  categoryCodes?: string[]
  answers?: Record<string, string>
  question?: string
  workScopes?: string[]
  document?: EvidenceDocument & { expiresOn: string }
  current?: { source: AnswerSource; optionCode: string; evidenceDocumentId: string }
  tier?: RiskTierCode
  sources?: Record<string, AnswerSource>
}
interface Suite {
  tiers: RiskTierDef[]
  policy: RiskPolicyDef
  questions: QuestionIn[]
  defaults: { screening: Screening; categoryCodes: string[]; payeeType: string; today: string }
  cases: Array<{ id: string; title: string; fn: string; input: Input; expect: unknown }>
}

const suite = loadYaml<Suite>('risk-tier.yaml')
const df = suite.defaults

const questions: RiskQuestionDef[] = suite.questions.map((q, n) => ({
  code: q.code,
  domain: q.domain,
  options: Object.entries(q.options).map(([code, points]) => ({
    code,
    points,
    ...(q.minTier?.[code] ? { minTier: q.minTier[code] } : {}),
    ...(code === q.evidenceOption ? { evidence: true } : {}),
  })),
  appliesWhen: q.appliesWhen ?? null,
  sortOrder: n + 1,
  evidenceScopeRequired: q.evidenceScopeRequired ?? false,
  evidenceScope: q.evidenceScope ?? null,
}))

const contextOf = (i: Input): RiskContext => ({ screening: i.screening ?? df.screening, categoryCodes: i.categoryCodes ?? df.categoryCodes, payeeType: df.payeeType, isForeign: false })

function run(fn: string, i: Input): unknown {
  const ctx = contextOf(i)
  switch (fn) {
    case 'inherentTier':
      return inherentTier(ctx, suite.policy)
    case 'selectQuestions':
      return selectQuestions(questions, ctx, suite.policy)
    case 'scoreAssessment':
      return scoreAssessment(questions, suite.tiers, suite.policy, ctx, i.answers ?? {})
    case 'evidenceSource': {
      const question = questions.find((q) => q.code === i.question)!
      const current: CurrentAnswer | null = i.current ?? null
      return evidenceSource(question, { workScopes: i.workScopes ?? [], document: i.document ?? null, current, today: df.today })
    }
    case 'assessmentCompleteness':
      return assessmentCompleteness(questions, suite.tiers, suite.policy, ctx, i.tier!, i.sources ?? {})
    default:
      throw new Error(`unknown fn ${fn}`)
  }
}

describe('golden risk-tier.yaml', () => {
  it('has the cases of S11-03', () => expect(suite.cases.map((c) => c.id)).toEqual(Array.from({ length: 24 }, (_, i) => `GC-RSK-${String(i + 1).padStart(2, '0')}`)))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, () => expect(run(c.fn, c.input)).toEqual(c.expect))
  }
})
