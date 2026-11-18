import type { TextValue } from '@/core/ai-checks'

// The facts of a reviewer's part of a risk assessment (S11-13 · BR-AI-03 · BR-AI-27), with no database: the job
// risk-ai-summary builds them from riskSummarySource, the evaluation set of S11-14 from its cases (pnpm ai:eval --agent risk).

export interface RiskSummaryQuestion {
  readonly code: string
  readonly domain: string
  /** The question's words (sent with the facts so the summary knows what each answer answers; never a fact) */
  readonly text: string
  /** The words of the option chosen, or null when unanswered */
  readonly answer: string | null
  readonly source: 'EXPLICIT' | 'EVIDENCE' | 'ON_BEHALF' | null
  readonly files: number
}

export type RiskFacts = Readonly<Record<string, TextValue>>

/** The facts of a reviewer's part, from code (BR-AI-03): codes, counts and the words of the options chosen */
export function riskFacts(s: { readonly number: string; readonly supplierCode: string; readonly questions: readonly RiskSummaryQuestion[] }): RiskFacts {
  const integer = (value: number): TextValue => ({ kind: 'integer', value })
  const out: Record<string, TextValue> = {
    assessment: { kind: 'ref', value: s.number },
    supplier: { kind: 'ref', value: s.supplierCode },
    questionCount: integer(s.questions.length),
    answeredCount: integer(s.questions.filter((q) => q.answer !== null).length),
    missingCount: integer(s.questions.filter((q) => q.answer === null).length),
    evidenceCount: integer(s.questions.filter((q) => q.source === 'EVIDENCE').length),
    fileCount: integer(s.questions.reduce((n, q) => n + q.files, 0)),
  }
  for (const q of s.questions) {
    out[`${q.code}.code`] = { kind: 'ref', value: q.code }
    out[`${q.code}.answer`] = { kind: 'text', value: q.answer ?? '-' }
    if (q.source) out[`${q.code}.source`] = { kind: 'enum', value: q.source }
  }
  return out
}
