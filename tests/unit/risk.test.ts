import { describe, expect, it } from 'vitest'
import {
  assessmentCompleteness,
  evidenceSource,
  maxTier,
  normalizeScope,
  riskConditionHolds,
  riskStatusAt,
  scoreAssessment,
  selectQuestions,
  tierByPoints,
  type RiskContext,
  type RiskPolicyDef,
  type RiskQuestionDef,
  type RiskTierDef,
} from '@/core/risk'
import { normalizeScope as supplierDocsNormalizeScope } from '@/core/supplier-docs'

// src/core/risk (spec §7.24 · S11-03): the branches golden risk-tier.yaml leaves out. Thresholds here are test data of
// the organization, as in the golden file; the engine holds none (BR-RSK-02).

const tiers: RiskTierDef[] = [
  { code: 'MEDIUM', minPoints: 20, reviewMonths: 24, reminderDaysBefore: 30, blocksPo: false, requiresExplicitAnswers: false },
  { code: 'LOW', minPoints: 0, reviewMonths: 36, reminderDaysBefore: 30, blocksPo: false, requiresExplicitAnswers: false },
  { code: 'HIGH', minPoints: 40, reviewMonths: 12, reminderDaysBefore: 30, blocksPo: true, requiresExplicitAnswers: true },
]
const policy: RiskPolicyDef = { screeningTierMap: { processesPersonalData: 'HIGH', accessesSystems: 'MEDIUM', accessesPremises: 'MEDIUM' }, highRiskCategories: ['PROF'] }
const ctx = (over: Partial<RiskContext> = {}): RiskContext => ({
  screening: { processesPersonalData: 'N', accessesSystems: 'N', accessesPremises: 'N' },
  categoryCodes: ['MAT'],
  payeeType: 'JURISTIC',
  isForeign: false,
  ...over,
})
const q = (code: string, over: Partial<RiskQuestionDef> = {}): RiskQuestionDef => ({
  code,
  domain: 'GENERAL',
  options: [
    { code: 'Y', points: 0, evidence: true },
    { code: 'N', points: 10 },
  ],
  sortOrder: 1,
  ...over,
})

describe('[BR-RSK-01] the question set', () => {
  it('a question on $category with anyIn joins when a line category is listed, and the set follows sortOrder', () => {
    const qs = [q('RQ-B', { sortOrder: 2 }), q('RQ-A', { sortOrder: 1, appliesWhen: { field: '$category', op: 'anyIn', value: ['IT', 'SUBCON'] } })]
    expect(selectQuestions(qs, ctx({ categoryCodes: ['MAT', 'IT'] }), policy).questions).toEqual(['RQ-A', 'RQ-B'])
    expect(selectQuestions(qs, ctx(), policy).questions).toEqual(['RQ-B'])
  })
  it('anyIn on another field, or with no list, holds for nothing', () => {
    expect(riskConditionHolds({ field: '$payeeType', op: 'anyIn', value: ['JURISTIC'] }, ctx(), 'LOW')).toBe(false)
    expect(riskConditionHolds({ field: '$category', op: 'anyIn' }, ctx(), 'LOW')).toBe(false)
  })
  it('all and any combine conditions of §7.9 on the payee type and foreign flag', () => {
    const foreignOrIndividual = { any: [{ field: '$isForeign', op: 'eq', value: true }, { field: '$payeeType', op: 'eq', value: 'INDIVIDUAL' }] }
    expect(riskConditionHolds(foreignOrIndividual, ctx(), 'LOW')).toBe(false)
    expect(riskConditionHolds(foreignOrIndividual, ctx({ isForeign: true }), 'LOW')).toBe(true)
    expect(riskConditionHolds({ all: [foreignOrIndividual, { field: '$inherentTier', op: 'ne', value: 'HIGH' }] }, ctx({ payeeType: 'INDIVIDUAL' }), 'HIGH')).toBe(false)
  })
})

describe('[BR-RSK-04] points and tier', () => {
  it('an answer that is not an option of its question, or to a question outside the set, counts nothing', () => {
    const qs = [q('RQ-A'), q('RQ-B', { appliesWhen: { field: 'accessesSystems', op: 'eq', value: 'Y' } })]
    expect(scoreAssessment(qs, tiers, policy, ctx(), { 'RQ-A': 'X', 'RQ-B': 'N' })).toEqual({ inherentTier: 'LOW', points: 0, tierByPoints: 'LOW', minTierFloor: 'LOW', tier: 'LOW' })
  })
  it('the tier by points is the lowest tier when no tier starts at or below the points', () => {
    expect(tierByPoints(5, [{ ...tiers[0]!, minPoints: 10 }])).toBe('MEDIUM')
    expect(tierByPoints(5, [])).toBe('LOW')
  })
  it('maxTier keeps the higher tier either way round', () => {
    expect(maxTier('HIGH', 'LOW')).toBe('HIGH')
    expect(maxTier('LOW', 'MEDIUM')).toBe('MEDIUM')
  })
})

describe('[BR-RSK-05] answers from evidence', () => {
  const doc = { id: 'D1', status: 'VERIFIED', expiresOn: '2027-03-31', scope: 'ISO 27001' }
  const today = '2026-11-01'
  it('a question with no evidence option is never answered from a document', () => {
    expect(evidenceSource(q('RQ-A', { options: [{ code: 'Y', points: 0 }] }), { workScopes: [], document: doc, today })).toEqual({ source: 'NONE', reason: 'NOT_LINKED' })
  })
  it('no document of the linked type: nothing to fill; a saved answer from evidence is emptied', () => {
    expect(evidenceSource(q('RQ-A'), { workScopes: [], document: null, today })).toEqual({ source: 'NONE', reason: 'NO_DOCUMENT' })
    expect(evidenceSource(q('RQ-A'), { workScopes: [], document: null, current: { source: 'EVIDENCE', optionCode: 'Y', evidenceDocumentId: 'D1' }, today })).toEqual({
      source: 'NONE',
      reason: 'NO_DOCUMENT',
      clearAnswer: true,
      event: 'EVIDENCE_REVOKED',
    })
  })
  it('a document with no end date counts; a question that needs no scope ignores the scopes', () => {
    expect(evidenceSource(q('RQ-A'), { workScopes: [], document: { status: 'VERIFIED', expiresOn: null }, today })).toEqual({ source: 'EVIDENCE', optionCode: 'Y' })
  })
  it('a confirmed answer that still holds its valid document keeps its source', () => {
    expect(evidenceSource(q('RQ-A'), { workScopes: [], document: doc, current: { source: 'EXPLICIT', optionCode: 'Y', evidenceDocumentId: 'D1' }, today })).toEqual({ source: 'EXPLICIT', optionCode: 'Y' })
    expect(evidenceSource(q('RQ-A'), { workScopes: [], document: doc, current: { source: 'NONE', optionCode: null, evidenceDocumentId: 'D1' }, today })).toEqual({ source: 'EVIDENCE', optionCode: 'Y' })
  })
  it('a saved answer typed by hand (no document) does not stop the document filling it', () => {
    expect(evidenceSource(q('RQ-A'), { workScopes: [], document: doc, current: { source: 'EXPLICIT', optionCode: 'N', evidenceDocumentId: null }, today })).toEqual({ source: 'EVIDENCE', optionCode: 'Y' })
  })
  it('a scope is required: a document without a scope, or a question without one, does not match', () => {
    const scoped = q('RQ-IS-01', { evidenceScopeRequired: true, evidenceScope: 'ISO 27001' })
    expect(evidenceSource(scoped, { workScopes: ['ISO 27001'], document: { ...doc, scope: null }, today })).toEqual({ source: 'NONE', reason: 'SCOPE_MISMATCH' })
    expect(evidenceSource(q('RQ-X', { evidenceScopeRequired: true, evidenceScope: null }), { workScopes: ['ISO 27001'], document: doc, today })).toEqual({ source: 'NONE', reason: 'SCOPE_MISMATCH' })
    expect(evidenceSource(scoped, { workScopes: ['ISO 9001'], document: doc, today })).toEqual({ source: 'NONE', reason: 'SCOPE_MISMATCH' })
  })
  it('normalizeScope is the one of S7 (BR-SDOC ข้อ 03): trims, lowers case and makes runs of white space one space', () => {
    expect(normalizeScope).toBe(supplierDocsNormalizeScope)
    expect(normalizeScope('  ISO 27001 ')).toBe('iso 27001')
    expect(normalizeScope(`iso ${'\t'} 27001`)).toBe(normalizeScope('ISO 27001'))
  })
  it('a document whose scope differs only by white space and case still answers the question', () => {
    const scoped = q('RQ-IS-01', { evidenceScopeRequired: true, evidenceScope: 'ISO 27001' })
    expect(evidenceSource(scoped, { workScopes: ['iso  27001'], document: { ...doc, scope: ' ISO' + String.fromCharCode(0xa0) + '27001' }, today })).toEqual({ source: 'EVIDENCE', optionCode: 'Y' })
  })
})

describe('[BR-RSK-06] completeness', () => {
  it('a question that is not required may stay empty; NONE is no answer', () => {
    const qs = [q('RQ-A'), q('RQ-B', { required: false, sortOrder: 2 })]
    expect(assessmentCompleteness(qs, tiers, policy, ctx(), 'LOW', { 'RQ-A': 'ON_BEHALF' })).toEqual({ complete: true, missing: [] })
    expect(assessmentCompleteness(qs, tiers, policy, ctx(), 'LOW', { 'RQ-A': 'NONE' })).toEqual({ complete: false, missing: ['RQ-A'] })
  })
  it('a tier missing from the rows asks no explicit answers', () => {
    expect(assessmentCompleteness([q('RQ-A')], [], policy, ctx(), 'HIGH', { 'RQ-A': 'EVIDENCE' })).toEqual({ complete: true, missing: [] })
  })
})

describe('[BR-RSK-13] status on a day', () => {
  it('CURRENT before the reminder, EXPIRING from the reminder to the last valid day, OVERDUE after', () => {
    const at = (today: string) => riskStatusAt({ validUntil: '2026-12-15', remindOn: '2026-11-15', today })
    expect([at('2026-11-14'), at('2026-11-15'), at('2026-12-15'), at('2026-12-16')]).toEqual(['CURRENT', 'EXPIRING', 'EXPIRING', 'OVERDUE'])
  })
})
