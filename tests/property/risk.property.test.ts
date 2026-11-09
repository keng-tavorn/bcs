import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { evidenceSource, poGate, RISK_TIER_CODES, scoreAssessment, selectQuestions, type RiskContext, type RiskPolicyDef, type RiskQuestionDef, type RiskTierCode, type RiskTierDef } from '@/core/risk'

// src/core/risk (spec §7.24 · S11-03): properties of the tier engine over random questionnaires, answers and documents.

const rank = (t: RiskTierCode) => RISK_TIER_CODES.indexOf(t)
const yn = fc.constantFrom<'Y' | 'N'>('Y', 'N')
const tierCode = fc.constantFrom<RiskTierCode>(...RISK_TIER_CODES)
const day = fc.date({ min: new Date('2025-01-01T00:00:00Z'), max: new Date('2028-12-31T00:00:00Z'), noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10))

const context = fc.record<RiskContext>({
  screening: fc.record({ processesPersonalData: yn, accessesSystems: yn, accessesPremises: yn }),
  categoryCodes: fc.subarray(['MAT', 'IT', 'PROF', 'SUBCON']),
  payeeType: fc.constantFrom('JURISTIC', 'INDIVIDUAL'),
  isForeign: fc.boolean(),
})
const policy = fc.record<RiskPolicyDef>({
  screeningTierMap: fc.record({ processesPersonalData: tierCode, accessesSystems: tierCode, accessesPremises: tierCode }),
  highRiskCategories: fc.subarray(['IT', 'PROF', 'SUBCON']),
})
/** Rising, distinct lower bounds starting at 0 (the shape BR-RSK-02 lets an organization confirm) */
const tiers = fc.tuple(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 40 })).map(([a, b]): RiskTierDef[] =>
  [0, a, a + b].map((minPoints, n) => ({ code: RISK_TIER_CODES[n]!, minPoints, reviewMonths: 12, reminderDaysBefore: 30, blocksPo: n === 2, requiresExplicitAnswers: n === 2 })),
)
const conditionField = fc.constantFrom('processesPersonalData', 'accessesSystems', 'accessesPremises')
const question = (n: number) =>
  fc.record({
    options: fc.array(fc.record({ points: fc.nat({ max: 20 }), minTier: fc.option(tierCode, { nil: undefined }) }), { minLength: 2, maxLength: 4 }),
    when: fc.option(fc.oneof(fc.record({ field: conditionField, op: fc.constant('eq'), value: yn }), fc.record({ field: fc.constant('$inherentTier'), op: fc.constant('eq'), value: tierCode })), { nil: null }),
  }).map(
    ({ options, when }): RiskQuestionDef => ({
      code: `RQ-GEN-${String(n).padStart(2, '0')}`,
      domain: 'GENERAL',
      options: options.map((o, k) => ({ code: String.fromCharCode(65 + k), points: o.points, ...(o.minTier ? { minTier: o.minTier } : {}) })),
      appliesWhen: when,
      sortOrder: n,
    }),
  )
const questionnaire = fc.integer({ min: 1, max: 8 }).chain((count) => fc.tuple(...Array.from({ length: count }, (_, n) => question(n + 1))))

describe('[BR-RSK-04] a higher-scoring answer never lowers the tier', () => {
  it('raising one answer to an option with more points raises the points and keeps or raises the tier', () => {
    fc.assert(
      fc.property(questionnaire, tiers, policy, context, fc.nat(), fc.nat(), (qs, ts, pol, ctx, pickSeed, qSeed) => {
        const set = selectQuestions(qs, ctx, pol).questions
        fc.pre(set.length > 0)
        const answers: Record<string, string> = {}
        for (const [n, code] of set.entries()) {
          const options = qs.find((x) => x.code === code)!.options
          answers[code] = options[(pickSeed + n) % options.length]!.code
        }
        const target = qs.find((x) => x.code === set[qSeed % set.length])!
        const now = target.options.find((o) => o.code === answers[target.code])!
        const higher = target.options.filter((o) => o.points > now.points && rank(o.minTier ?? 'LOW') >= rank(now.minTier ?? 'LOW'))
        fc.pre(higher.length > 0)
        const before = scoreAssessment(qs, ts, pol, ctx, answers)
        const after = scoreAssessment(qs, ts, pol, ctx, { ...answers, [target.code]: higher[0]!.code })
        expect(after.points).toBeGreaterThan(before.points)
        expect(rank(after.tier)).toBeGreaterThanOrEqual(rank(before.tier))
      }),
      { numRuns: 1000 },
    )
  })
})

describe('[BR-RSK-01] selectQuestions is idempotent', () => {
  it('selecting again from the questions selected gives the same set', () => {
    fc.assert(
      fc.property(questionnaire, policy, context, (qs, pol, ctx) => {
        const first = selectQuestions(qs, ctx, pol)
        const again = selectQuestions(
          qs.filter((x) => first.questions.includes(x.code)),
          ctx,
          pol,
        )
        expect(again).toEqual(first)
        expect(selectQuestions(qs, ctx, pol)).toEqual(first)
      }),
      { numRuns: 1000 },
    )
  })
})

describe('[BR-RSK-05] an expired document is never evidence', () => {
  it('expiresOn before today gives no EVIDENCE answer whatever the status, scope or saved answer', () => {
    const q: RiskQuestionDef = {
      code: 'RQ-IS-01',
      domain: 'INFOSEC',
      options: [
        { code: 'Y', points: 0, evidence: true },
        { code: 'N', points: 12 },
      ],
      sortOrder: 1,
      evidenceScopeRequired: true,
      evidenceScope: 'ISO 27001',
    }
    fc.assert(
      fc.property(
        day,
        fc.integer({ min: 1, max: 2000 }),
        fc.constantFrom('VERIFIED', 'PENDING', 'REJECTED', 'EXPIRED', 'SUPERSEDED'),
        fc.constantFrom('ISO 27001', ' iso 27001 ', 'ISO 9001'),
        fc.option(fc.constantFrom('EXPLICIT', 'EVIDENCE', 'ON_BEHALF') as fc.Arbitrary<'EXPLICIT' | 'EVIDENCE' | 'ON_BEHALF'>, { nil: null }),
        (today, daysBefore, status, scope, saved) => {
          const expiresOn = new Date(Date.parse(`${today}T00:00:00Z`) - daysBefore * 86_400_000).toISOString().slice(0, 10)
          const current = saved ? { source: saved, optionCode: 'Y', evidenceDocumentId: 'D1' } : null
          const result = evidenceSource(q, { workScopes: ['ISO 27001'], document: { id: 'D1', status, expiresOn, scope }, current, today })
          expect(result.source).toBe('NONE')
          if (current) expect(result).toMatchObject({ clearAnswer: true, event: 'EVIDENCE_REVOKED' })
        },
      ),
      { numRuns: 1000 },
    )
  })
})

// ---------- S11-07 · poGate (BR-RSK-09 ข้อ 4 · OQ-224): the cap of an override is cumulative ----------

describe('poGate under one override (S11-07)', () => {
  const gate = (used: bigint, gross: bigint, counted: bigint, cap: bigint) =>
    poGate({
      tier: 'HIGH',
      tiers: [
        { code: 'LOW', blocksPo: false },
        { code: 'MEDIUM', blocksPo: false },
        { code: 'HIGH', blocksPo: true },
      ],
      policy: { registryFlagBlocks: true, mediumOverdueBlocks: false },
      registryFlag: 'NONE',
      assessedAfterFlag: false,
      assessment: 'NONE',
      screeningCovered: true,
      override: { status: 'APPROVED', poId: null, expiresOn: '2026-10-16', capGrossSatang: cap, usedGrossSatang: used },
      poId: 'PO',
      poDate: '2026-10-16',
      grossSatang: gross,
      countedGrossSatang: counted,
      trigger: counted > 0n ? 'PO_CHANGE' : 'SUBMIT',
    })
  const satang = fc.bigInt({ min: 1n, max: 50_000_000n })

  it('[FR-RSK-203/AC3] the POs it lets out never sum above the cap, however they come', () => {
    fc.assert(
      fc.property(satang, fc.array(satang, { maxLength: 12 }), (cap, grosses) => {
        let used = 0n
        for (const g of grosses) if (gate(used, g, 0n, cap).allowed) used += g
        expect(used <= cap).toBe(true)
      }),
    )
  })

  it('[FR-RSK-203/AC3] a smaller amount never turns a pass into a block, and a change is judged on its new amount alone', () => {
    fc.assert(
      fc.property(satang, satang, satang, satang, (cap, used, a, b) => {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        if (gate(used, hi, 0n, cap).allowed) expect(gate(used, lo, 0n, cap).allowed).toBe(true)
        // a PO the override holds at `lo` changed to `hi` passes as a new PO of `hi` would with `lo` taken out
        const held = used + lo
        expect(gate(held, hi, lo, cap).allowed).toBe(gate(used, hi, 0n, cap).allowed)
      }),
    )
  })
})
