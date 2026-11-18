import { fieldConfidence } from './confidence'

// Checks of the Risk Agent (S11-13 · FR-AI-306 · BR-AI-33 BR-AI-34 · golden ai-risk-verify GC-AI-100 to 103). Pure.
//
// What the agent proposes for a risk assessment is checked answer by answer against the assessment's own questions and
// what the system already knows from evidence (BR-RSK-05):
//  - a question not in the assessment's set → QUESTION_NOT_IN_SET FAIL
//  - an option the question does not have → OPTION_UNKNOWN FAIL
//  - the evidence option of a question no document answers → EVIDENCE_MISSING WARN (a certificate claimed, none sent)
//  - another option of a question a document answers → EVIDENCE_CONFLICT FAIL (the system's answer wins)
// The confidence of each answer is the model's percent in bp capped by its check (BR-AI-16), and every answer of the AI
// is confirmed one by one (BR-AI-33: an answer moves the tier, so there is no "confirm all"). Never a score or a tier.

export type RiskCheckCode = 'QUESTION_NOT_IN_SET' | 'OPTION_UNKNOWN' | 'EVIDENCE_MISSING' | 'EVIDENCE_CONFLICT'
export type RiskCheckOutcome = 'WARN' | 'FAIL'

/** A question of the assessment's set as the checks see it: its options and which one evidence chooses */
export interface RiskDraftQuestion {
  readonly code: string
  readonly options: readonly { readonly code: string; readonly evidence?: boolean }[]
}

export interface RiskDraftAnswer {
  readonly questionCode: string
  readonly optionCode: string
  /** The model's confidence, 0–100 */
  readonly confidence: number
}

export interface RiskDraftCheck {
  readonly questionCode: string
  readonly code: RiskCheckCode
  readonly result: RiskCheckOutcome
}

export interface RiskDraftVerdict {
  /** Only the answers that did not pass, in the order of the answers */
  readonly checks: readonly RiskDraftCheck[]
  readonly confidenceBp: Readonly<Record<string, number>>
  /** Every question the AI answered (BR-AI-33) */
  readonly mustConfirm: readonly string[]
}

function checkOne(answer: RiskDraftAnswer, questions: ReadonlyMap<string, RiskDraftQuestion>, evidence: ReadonlySet<string>): RiskDraftCheck | null {
  const q = questions.get(answer.questionCode)
  const at = (code: RiskCheckCode, result: RiskCheckOutcome): RiskDraftCheck => ({ questionCode: answer.questionCode, code, result })
  if (!q) return at('QUESTION_NOT_IN_SET', 'FAIL')
  const option = q.options.find((o) => o.code === answer.optionCode)
  if (!option) return at('OPTION_UNKNOWN', 'FAIL')
  const answeredByEvidence = evidence.has(q.code)
  if (option.evidence === true && !answeredByEvidence) return at('EVIDENCE_MISSING', 'WARN')
  if (answeredByEvidence && option.evidence !== true) return at('EVIDENCE_CONFLICT', 'FAIL')
  return null
}

/**
 * The checks, the confidence and the questions to confirm of the answers the agent proposed (GC-AI-100 to 102).
 * `evidenceAvailable` holds the codes of the questions a supplier document answers today (BR-RSK-05).
 */
export function checkRiskDraft(input: { readonly questionSet: readonly RiskDraftQuestion[]; readonly evidenceAvailable: readonly string[]; readonly answers: readonly RiskDraftAnswer[] }): RiskDraftVerdict {
  const questions = new Map(input.questionSet.map((q) => [q.code, q]))
  const evidence = new Set(input.evidenceAvailable)
  const checks: RiskDraftCheck[] = []
  const confidenceBp: Record<string, number> = {}
  const mustConfirm: string[] = []
  for (const answer of input.answers) {
    const check = checkOne(answer, questions, evidence)
    if (check) checks.push(check)
    // only the bp is taken from fieldConfidence: every answer of the AI is confirmed one by one whatever its confidence
    // (mustConfirm below holds them all), so its threshold plays no part here
    confidenceBp[answer.questionCode] = fieldConfidence({ field: answer.questionCode, modelConfidence: answer.confidence, check: check?.result ?? 'PASS', minConfidenceBp: 0, critical: [] }).confidenceBp
    if (!mustConfirm.includes(answer.questionCode)) mustConfirm.push(answer.questionCode)
  }
  return { checks, confidenceBp, mustConfirm }
}

export type DraftDecision = { readonly draft: true } | { readonly draft: false; readonly reason: 'PAYEE_TYPE_EXCLUDED' | 'SETTING_OFF' }

/**
 * BR-AI-34: whether the agent drafts answers for an assessment — never for a supplier who is a person (their answers
 * and files carry personal data), then only when the organization's settings.risk.aiAssist is on
 */
export function shouldDraftFor(input: { readonly payeeType: string; readonly aiAssist: boolean }): DraftDecision {
  if (input.payeeType === 'INDIVIDUAL') return { draft: false, reason: 'PAYEE_TYPE_EXCLUDED' }
  if (!input.aiAssist) return { draft: false, reason: 'SETTING_OFF' }
  return { draft: true }
}

export type EvidenceSendDecision = { readonly send: true } | { readonly send: false; readonly reason: 'UPLOADER_NOT_CONSENTED' | 'QUESTION_NOT_AI_READABLE' }

/**
 * BR-AI-34: whether a RISK_EVIDENCE file goes to the AI — the uploader ticked it may (asked first), and the question is
 * one the organization opened to the AI (RiskQuestion.aiReadable): both must hold
 */
export function aiReadableEvidence(input: { readonly questionAiReadable: boolean; readonly evidenceAiReadable: boolean }): EvidenceSendDecision {
  if (!input.evidenceAiReadable) return { send: false, reason: 'UPLOADER_NOT_CONSENTED' }
  if (!input.questionAiReadable) return { send: false, reason: 'QUESTION_NOT_AI_READABLE' }
  return { send: true }
}

/** GC-AI-103: the data scope of the agent, both decisions over lists of cases in one object */
export function aiScope(input: {
  readonly shouldDraftFor: readonly { readonly payeeType: string; readonly aiAssist: boolean }[]
  readonly aiReadableEvidence: readonly { readonly questionAiReadable: boolean; readonly evidenceAiReadable: boolean }[]
}): { readonly shouldDraftFor: readonly DraftDecision[]; readonly aiReadableEvidence: readonly EvidenceSendDecision[] } {
  return { shouldDraftFor: input.shouldDraftFor.map(shouldDraftFor), aiReadableEvidence: input.aiReadableEvidence.map(aiReadableEvidence) }
}
