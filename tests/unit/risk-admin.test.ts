import { describe, expect, it } from 'vitest'
import { applyTierChanges, lintQuestionnaire, riskConditionProblem, tierOrderProblem, type LintQuestion } from '@/core/risk/admin'
import type { RiskTierDef } from '@/core/risk'

// src/core/risk/admin.ts (S11-04 · BR-RSK-02 · ADR-229): what a tier proposal would make of the tiers, the order they must
// keep, and the lint of a questionnaire version. Thresholds here are test data of an organization, never code.

const tiers: RiskTierDef[] = [
  { code: 'LOW', minPoints: 0, reviewMonths: 36, reminderDaysBefore: 30, blocksPo: false, requiresExplicitAnswers: false },
  { code: 'MEDIUM', minPoints: 20, reviewMonths: 24, reminderDaysBefore: 30, blocksPo: false, requiresExplicitAnswers: false },
  { code: 'HIGH', minPoints: 40, reviewMonths: 12, reminderDaysBefore: 30, blocksPo: true, requiresExplicitAnswers: true },
]
const yn = [
  { code: 'Y', points: 0 },
  { code: 'N', points: 6 },
]
const question = (code: string, over: Partial<LintQuestion> = {}): LintQuestion => ({ code, options: yn, appliesWhen: null, evidenceScopeRequired: false, evidenceScope: null, ...over })

describe('[BR-RSK-02] a tier proposal', () => {
  it('changes only the fields it names, and leaves the tiers in effect as they were', () => {
    const merged = applyTierChanges(tiers, { MEDIUM: { minPoints: 25 }, HIGH: { blocksPo: false } })
    expect(merged.find((t) => t.code === 'MEDIUM')).toMatchObject({ minPoints: 25, reviewMonths: 24 })
    expect(merged.find((t) => t.code === 'HIGH')).toMatchObject({ minPoints: 40, blocksPo: false })
    expect(tiers[1]!.minPoints).toBe(20)
  })

  it('keeps one row per code, LOW from 0 and the bounds rising strictly', () => {
    expect(tierOrderProblem(tiers)).toBeNull()
    expect(tierOrderProblem(tiers.slice(0, 2))).toBe('MISSING_TIER')
    expect(tierOrderProblem([...tiers, tiers[2]!])).toBe('MISSING_TIER')
    expect(tierOrderProblem(applyTierChanges(tiers, { LOW: { minPoints: 1 } }))).toBe('LOW_NOT_ZERO')
    expect(tierOrderProblem(applyTierChanges(tiers, { MEDIUM: { minPoints: 0 } }))).toBe('NOT_RISING')
    expect(tierOrderProblem(applyTierChanges(tiers, { HIGH: { minPoints: 20 } }))).toBe('NOT_RISING')
    expect(tierOrderProblem(applyTierChanges(tiers, { MEDIUM: { minPoints: 50 } }))).toBe('NOT_RISING')
  })
})

describe('[BR-RSK-01] [BR-RSK-05] the lint of a questionnaire version', () => {
  it('passes a version whose questions are well formed and whose linked types find them', () => {
    const scoped = question('RQ-IS-01', { evidenceScopeRequired: true, evidenceScope: 'ISO 27001', options: [{ code: 'Y', points: 0, evidence: true }, { code: 'N', points: 12, minTier: 'HIGH' }] })
    const r = lintQuestionnaire([question('RQ-GEN-01'), scoped], [{ code: 'ISO_CERT', singleInstance: false, linkedRiskQuestionCodes: ['RQ-IS-01'] }, { code: 'DBD', singleInstance: true, linkedRiskQuestionCodes: ['RQ-GEN-01'] }])
    expect(r).toEqual({ errors: [], warnings: [] })
  })

  it('RISK_LINT_OPTIONS: no question, a bad code, a duplicate, fewer than two options, a repeated option, points, minTier, two evidence options', () => {
    expect(lintQuestionnaire([], []).errors).toEqual([{ code: 'RISK_LINT_OPTIONS', reason: 'NO_QUESTIONS' }])
    const r = lintQuestionnaire(
      [
        question('RA-01'),
        question('RQ-GEN-01'),
        question('RQ-GEN-01'),
        question('RQ-GEN-02', { options: [{ code: 'Y', points: 0 }] }),
        question('RQ-GEN-03', { options: [{ code: 'Y', points: 0 }, { code: 'Y', points: 1 }] }),
        question('RQ-GEN-04', { options: [{ code: 'Y', points: 1.5 }, { code: 'N', points: -1 }] }),
        question('RQ-GEN-05', { options: [{ code: 'Y', points: 0, minTier: 'EXTREME' as never }, { code: 'N', points: 1 }] }),
        question('RQ-GEN-06', { options: [{ code: 'Y', points: 0, evidence: true }, { code: 'N', points: 1, evidence: true }] }),
      ],
      [],
    )
    expect(r.errors.map((e) => `${e.question}:${e.reason}`)).toEqual([
      'RA-01:CODE_FORMAT',
      'RQ-GEN-01:DUPLICATE_QUESTION',
      'RQ-GEN-02:FEWER_THAN_TWO',
      'RQ-GEN-03:DUPLICATE_OPTION',
      'RQ-GEN-04:POINTS',
      'RQ-GEN-05:MIN_TIER',
      'RQ-GEN-06:MORE_THAN_ONE_EVIDENCE_OPTION',
    ])
    expect(r.errors.every((e) => e.code === 'RISK_LINT_OPTIONS')).toBe(true)
  })

  it('RISK_LINT_SCOPE_REQUIRED: a question a type of several copies answers names its scope; a single copy type needs none', () => {
    const iso = { code: 'ISO_CERT', singleInstance: false, linkedRiskQuestionCodes: ['RQ-IS-01', 'RQ-PRM-02'] }
    const r = lintQuestionnaire([question('RQ-IS-01'), question('RQ-PRM-02', { evidenceScopeRequired: true, evidenceScope: '  ' })], [iso, { code: 'DBD', singleInstance: true, linkedRiskQuestionCodes: ['RQ-IS-01'] }])
    expect(r.errors).toEqual([
      { code: 'RISK_LINT_SCOPE_REQUIRED', question: 'RQ-IS-01', documentType: 'ISO_CERT', reason: 'SCOPE_REQUIRED' },
      { code: 'RISK_LINT_SCOPE_REQUIRED', question: 'RQ-PRM-02', documentType: 'ISO_CERT', reason: 'SCOPE_REQUIRED' },
    ])
    expect(lintQuestionnaire([question('RQ-IS-01', { evidenceScope: 'ISO 27001' })], [iso]).errors[0]).toMatchObject({ question: 'RQ-IS-01', code: 'RISK_LINT_SCOPE_REQUIRED' })
    expect(lintQuestionnaire([question('RQ-IS-01', { evidenceScopeRequired: true, evidenceScope: null })], [iso]).errors[0]).toMatchObject({ question: 'RQ-IS-01', code: 'RISK_LINT_SCOPE_REQUIRED' })
  })

  it('RISK_LINT_UNKNOWN_QUESTION is a warning: the version may still be sent', () => {
    const r = lintQuestionnaire([question('RQ-GEN-01')], [{ code: 'PDPA_POLICY', singleInstance: true, linkedRiskQuestionCodes: ['RQ-PRV-09'] }])
    expect(r).toEqual({ errors: [], warnings: [{ code: 'RISK_LINT_UNKNOWN_QUESTION', question: 'RQ-PRV-09', documentType: 'PDPA_POLICY', reason: 'NOT_IN_VERSION' }] })
  })

  it('RISK_LINT_CONDITION: a condition reads only the screening fields and the four variables', () => {
    const r = lintQuestionnaire([question('RQ-PRV-01', { appliesWhen: { field: 'amount', op: 'gt', value: 1 } })], [])
    expect(r.errors).toEqual([{ code: 'RISK_LINT_CONDITION', question: 'RQ-PRV-01', reason: 'UNKNOWN_FIELD' }])
  })
})

describe('[BR-RSK-01] riskConditionProblem', () => {
  it.each([
    [{ field: 'processesPersonalData', op: 'eq', value: 'Y' }, null],
    [{ field: 'accessesSystems', op: 'ne', value: 'N' }, null],
    [{ field: '$category', op: 'anyIn', value: ['IT', 'PROF'] }, null],
    [{ field: '$payeeType', op: 'eq', value: 'FOREIGN' }, null],
    [{ field: '$isForeign', op: 'eq', value: true }, null],
    [{ field: '$inherentTier', op: 'eq', value: 'HIGH' }, null],
    [{ field: '$inherentTier', op: 'in', value: ['MEDIUM', 'HIGH'] }, null],
    [{ all: [{ field: 'accessesPremises', op: 'eq', value: 'Y' }, { any: [{ field: '$isForeign', op: 'eq', value: false }] }] }, null],
    [{ all: [] }, 'EMPTY_GROUP'],
    [{ any: [{ field: 'accessesPremises', op: 'eq', value: 'Y' }, { field: 'budget', op: 'eq', value: 1 }] }, 'UNKNOWN_FIELD'],
    [{ field: 'processesPersonalData', op: 'like', value: 'Y' }, 'UNKNOWN_OP'],
    [{ field: '$category', op: 'eq', value: 'IT' }, 'CATEGORY_TAKES_ANY_IN'],
    [{ field: '$payeeType', op: 'anyIn', value: ['JURISTIC'] }, 'CATEGORY_TAKES_ANY_IN'],
    [{ field: '$category', op: 'anyIn', value: [] }, 'VALUE'],
    [{ field: '$category', op: 'anyIn', value: 'IT' }, 'VALUE'],
    [{ field: 'processesPersonalData', op: 'eq', value: 'yes' }, 'VALUE'],
    [{ field: '$inherentTier', op: 'eq', value: 'EXTREME' }, 'VALUE'],
  ] as const)('%j → %s', (when, expected) => {
    expect(riskConditionProblem(when as never)).toBe(expected)
  })
})
