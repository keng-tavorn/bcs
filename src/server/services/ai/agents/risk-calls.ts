import { checkRiskDraft, renderValue, type RiskDraftQuestion, type RiskDraftVerdict } from '@/core/ai-checks'
import { riskSummaryInputText, type RiskAnswerDraft } from '@/lib/ai-schemas/agents'
import type { RiskFacts, RiskSummaryQuestion } from '../../risk/ai-facts'
import { asDataValues } from '../data'

// What the Risk Agent sends and what it keeps of an answer (S11-13 · BR-AI-27 · BR-AI-33), by code and without the
// database, so the jobs risk-ai-draft risk-ai-summary and the evaluation set of S11-14 (pnpm ai:eval --agent risk) give
// Claude the same text and score the same proposals a person is shown.

type DraftAnswer = RiskAnswerDraft['answers'][number]

/**
 * The answers of a draft the form proposes: one per question, the first the model gave, checked by ai-risk-verify; only
 * those the commands can take — a question asked, an option it has (a WARN stays, to be looked at one by one); a question
 * answered from a certificate is never proposed (EVIDENCE_CONFLICT · FAIL). `proposed` is question code → option code.
 */
export function proposedRiskAnswers(input: {
  readonly questionSet: readonly RiskDraftQuestion[]
  readonly evidenceAvailable: readonly string[]
  readonly asked: readonly string[]
  readonly answers: readonly DraftAnswer[]
}): { readonly answers: readonly DraftAnswer[]; readonly verdict: RiskDraftVerdict; readonly proposed: Readonly<Record<string, string>> } {
  const seen = new Set<string>()
  const answers = input.answers.filter((a) => (seen.has(a.questionCode) ? false : (seen.add(a.questionCode), true)))
  const verdict = checkRiskDraft({ questionSet: input.questionSet, evidenceAvailable: input.evidenceAvailable, answers })
  const asked = new Set(input.asked)
  const failed = new Set(verdict.checks.filter((c) => c.result === 'FAIL').map((c) => c.questionCode))
  const proposed: Record<string, string> = {}
  for (const a of answers) if (asked.has(a.questionCode) && !failed.has(a.questionCode)) proposed[a.questionCode] = a.optionCode
  return { answers, verdict, proposed }
}

/** The questions of the slot by their words, the facts as the page shows them, each value redacted (BR-AI-18), and what each file given is */
export const riskSummaryRequestText = (facts: RiskFacts, questions: readonly Pick<RiskSummaryQuestion, 'code' | 'text'>[], files: readonly { readonly label: string; readonly about: string }[]): string =>
  riskSummaryInputText(
    asDataValues(Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, renderValue(v)]))),
    questions.map((q) => ({ code: q.code, text: q.text })),
    files.map((f) => ({ label: f.label, kind: f.about })),
  )
