import { describe, expect, it } from 'vitest'
import { checkRiskDraft } from '@/core/ai-checks'

// S11-13 (BR-AI-33 · BR-AI-16): the branches of checkRiskDraft the golden ai-risk-verify does not reach — an answer that
// agrees with the evidence passes at the model's confidence, and a question answered twice is confirmed once.

const questionSet = [
  { code: 'RQ-IS-01', options: [{ code: 'Y', evidence: true }, { code: 'N' }] },
  { code: 'RQ-GEN-01', options: [{ code: 'A' }, { code: 'B' }] },
]

describe('[BR-AI-33] checkRiskDraft beyond the golden', () => {
  it('the evidence option of a question a document answers passes; confidence clamps to 0–100', () => {
    expect(checkRiskDraft({ questionSet, evidenceAvailable: ['RQ-IS-01'], answers: [{ questionCode: 'RQ-IS-01', optionCode: 'Y', confidence: 140 }] })).toEqual({ checks: [], confidenceBp: { 'RQ-IS-01': 10000 }, mustConfirm: ['RQ-IS-01'] })
  })

  it('a question answered twice is listed once to confirm, the later confidence kept', () => {
    const verdict = checkRiskDraft({ questionSet, evidenceAvailable: [], answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'A', confidence: 90 }, { questionCode: 'RQ-GEN-01', optionCode: 'B', confidence: 40 }] })
    expect(verdict).toEqual({ checks: [], confidenceBp: { 'RQ-GEN-01': 4000 }, mustConfirm: ['RQ-GEN-01'] })
  })
})
