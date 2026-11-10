import { describe, expect, it } from 'vitest'
import {
  assessmentCompleteness,
  evidenceSource,
  maxTier,
  normalizeScope,
  overrideApplies,
  overrideExpiryCheck,
  overrideWindow,
  poGate,
  riskConditionHolds,
  riskStatusAt,
  scoreAssessment,
  screeningCovers,
  selectQuestions,
  tierByPoints,
  type PoGateInput,
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

// ---------- S11-07 · poGate (BR-RSK-09 BR-RSK-12): what golden risk-gate.yaml leaves out ----------

const GATE_TIERS = [
  { code: 'LOW', blocksPo: false },
  { code: 'MEDIUM', blocksPo: false },
  { code: 'HIGH', blocksPo: true },
] as const
const gateInput = (over: Partial<PoGateInput> = {}): PoGateInput => ({
  tier: 'HIGH',
  tiers: GATE_TIERS,
  policy: { registryFlagBlocks: true, mediumOverdueBlocks: false },
  registryFlag: 'NONE',
  assessedAfterFlag: false,
  assessment: 'NONE',
  screeningCovered: true,
  override: null,
  poId: 'PO-1',
  poDate: '2026-10-16',
  grossSatang: 12_000_000n,
  countedGrossSatang: 0n,
  trigger: 'SUBMIT',
  ...over,
})
const approved = { status: 'APPROVED', poId: null, expiresOn: '2026-10-16', capGrossSatang: 15_000_000n, usedGrossSatang: 0n }

describe('poGate (S11-07 · BR-RSK-09)', () => {
  it('[FR-RSK-203/AC1] a MEDIUM whose assessment is overdue blocks when the policy says so', () => {
    expect(poGate(gateInput({ tier: 'MEDIUM', assessment: 'OVERDUE', policy: { registryFlagBlocks: true, mediumOverdueBlocks: true } }))).toEqual({ allowed: false, error: 'RISK_REASSESSMENT_REQUIRED', reason: 'VALIDITY_LAPSED' })
    expect(poGate(gateInput({ tier: 'MEDIUM', assessment: 'OVERDUE', policy: { registryFlagBlocks: true, mediumOverdueBlocks: true }, override: approved }))).toMatchObject({ allowed: true, source: 'OVERRIDE' })
    // LOW stays a warning: the policy names MEDIUM only
    expect(poGate(gateInput({ tier: 'LOW', assessment: 'OVERDUE', policy: { registryFlagBlocks: true, mediumOverdueBlocks: true } }))).toEqual({ allowed: true, source: 'NOT_REQUIRED', warnings: ['REASSESSMENT_OVERDUE'], requiresReason: true })
  })

  it('[FR-RSK-203/AC1] a tier the organization does not list does not block', () => {
    expect(poGate(gateInput({ tiers: [] }))).toEqual({ allowed: true, source: 'NOT_REQUIRED', warnings: [], requiresReason: false })
  })

  it('[FR-RSK-203/AC4] a flag the policy lets through stays a warning with a reason on a HIGH that passes', () => {
    const policy = { registryFlagBlocks: false, mediumOverdueBlocks: false }
    expect(poGate(gateInput({ registryFlag: 'VAT_CANCELLED', assessment: 'CURRENT', policy }))).toEqual({ allowed: true, source: 'ASSESSMENT', warnings: ['REGISTRY_FLAGGED'], requiresReason: true })
    expect(poGate(gateInput({ registryFlag: 'NOT_FOUND', policy, override: approved }))).toEqual({ allowed: true, source: 'OVERRIDE', warnings: ['REGISTRY_FLAGGED', 'OVERRIDE_USED'], requiresReason: true })
    // a reassessment after a VAT flag clears it; CEASED never clears
    expect(poGate(gateInput({ registryFlag: 'VAT_CANCELLED', assessedAfterFlag: true, assessment: 'CURRENT', policy }))).toMatchObject({ warnings: [] })
    expect(poGate(gateInput({ registryFlag: 'CEASED', assessedAfterFlag: true, assessment: 'CURRENT' }))).toEqual({ allowed: false, error: 'RISK_BLOCKED', reason: 'REGISTRY_CEASED' })
  })

  it('[FR-RSK-203/AC1] an override closed EXPIRED by the job still says OVERRIDE_EXPIRED', () => {
    expect(poGate(gateInput({ override: { ...approved, status: 'EXPIRED', expiresOn: '2026-10-15' } }))).toEqual({ allowed: false, error: 'RISK_BLOCKED', reason: 'OVERRIDE_EXPIRED' })
    expect(overrideApplies({ ...approved, status: 'REJECTED' }, 'PO-1')).toBe(false)
    expect(overrideApplies({ ...approved, poId: 'PO-1' }, 'PO-1')).toBe(true)
    expect(overrideApplies(null, 'PO-1')).toBe(false)
  })

  it('[FR-RSK-203/AC1] a send of a PO the override already holds does not count it twice', () => {
    const held = { ...approved, usedGrossSatang: 12_000_000n }
    expect(poGate(gateInput({ trigger: 'SEND', override: held, countedGrossSatang: 12_000_000n }))).toMatchObject({ allowed: true, source: 'OVERRIDE' })
    expect(poGate(gateInput({ trigger: 'SEND', override: held, countedGrossSatang: 0n }))).toMatchObject({ allowed: false, reason: 'OVERRIDE_CAP_EXCEEDED' })
    // a PO change that lowers the amount fits again
    expect(poGate(gateInput({ trigger: 'PO_CHANGE', grossSatang: 10_000_000n, override: held, countedGrossSatang: 12_000_000n }))).toMatchObject({ allowed: true })
  })

  it('[FR-RSK-203/AC1] screeningCovers: the Y answers and the high-risk categories of the PO are the assessment’s', () => {
    const assessment = { screening: { processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' } as const, categoryCodes: ['PROF'] }
    expect(screeningCovers(assessment, { screening: { accessesSystems: 'Y' }, categoryCodes: ['PROF', 'MAT'] }, ['PROF'])).toBe(true)
    expect(screeningCovers(assessment, { screening: { processesPersonalData: 'Y' }, categoryCodes: [] }, ['PROF'])).toBe(false)
    expect(screeningCovers(assessment, { screening: { accessesPremises: 'N' }, categoryCodes: ['SUBCON'] }, ['PROF', 'SUBCON'])).toBe(false)
    expect(screeningCovers(assessment, { screening: { processesPersonalData: undefined }, categoryCodes: [] }, [])).toBe(true)
  })
})

describe('[FR-RSK-203/AC3] [BR-RSK-10] the last day of an override (S11-08 · the values of GC-RSK-73 to 76)', () => {
  it('runs from the send day to the send day + overrideMaxDays, both days included', () => {
    expect(overrideWindow({ submittedOn: '2026-10-16', overrideMaxDays: 90 })).toEqual({ lastAllowed: '2027-01-14' })
    expect(overrideExpiryCheck({ submittedOn: '2026-10-16', expiresOn: '2026-10-16', overrideMaxDays: 90 })).toEqual({ ok: true })
    expect(overrideExpiryCheck({ submittedOn: '2026-10-16', expiresOn: '2027-01-14', overrideMaxDays: 90 })).toEqual({ ok: true })
    expect(overrideExpiryCheck({ submittedOn: '2026-10-16', expiresOn: '2026-10-15', overrideMaxDays: 90 })).toEqual({ ok: false, error: 'VALIDATION_FAILED', reason: 'OVERRIDE_EXPIRY_PAST' })
    expect(overrideExpiryCheck({ submittedOn: '2026-10-16', expiresOn: '2027-01-15', overrideMaxDays: 90 })).toEqual({ ok: false, error: 'VALIDATION_FAILED', reason: 'OVERRIDE_EXPIRY_TOO_FAR' })
  })
})
