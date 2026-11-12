import { describe, expect, it } from 'vitest'
import { aiScope, checkRiskDraft, type RiskDraftAnswer } from '@/core/ai-checks'
import { loadGolden } from './support'

// tests/golden/ai-risk-verify.yaml (spec §12.9 · BR-AI-33 BR-AI-34 · S11-13): the checks of what the Risk Agent proposed
// for an assessment, and the data scope of the agent (GC-AI-103 · fn aiScope).

interface Assessment {
  payeeType: string
  questionSet: string[]
  evidenceAvailable: string[]
}

interface Suite {
  questions: Record<string, { options: string[]; evidenceOption?: string }>
  assessment: Assessment
  cases: Array<{ id: string; title?: string; fn?: string; input: Record<string, unknown>; expect: unknown }>
}

describe('[BR-AI-33] [BR-AI-34] golden ai-risk-verify.yaml', () => {
  const suite = loadGolden('ai-risk-verify') as unknown as Suite
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`, () => {
      if (c.fn === 'aiScope') {
        expect(aiScope(c.input as Parameters<typeof aiScope>[0])).toEqual(c.expect)
        return
      }
      // the case's assessment is set over the suite's field by field (ai-quotation-map's way)
      const assessment = { ...suite.assessment, ...((c.input.assessment as Partial<Assessment> | undefined) ?? {}) }
      const questionSet = assessment.questionSet.map((code) => {
        const q = suite.questions[code]!
        return { code, options: q.options.map((o) => ({ code: o, ...(o === q.evidenceOption ? { evidence: true } : {}) })) }
      })
      expect(checkRiskDraft({ questionSet, evidenceAvailable: assessment.evidenceAvailable, answers: c.input.answers as RiskDraftAnswer[] })).toEqual(c.expect)
    })
  }
})
