import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { checkAiText, type RiskDraftQuestion } from '../src/core/ai-checks'
import { isValidThaiTaxId } from '../src/core/thai/taxid'
import { DECISION_ADVICE_WORDS, EVAL_THRESHOLDS_BP, RISK_PROFILE } from '../src/lib/ai-config'
import { riskDraftInputText, type RiskAnswerDraft, type RiskSummaryText } from '../src/lib/ai-schemas/agents'
import { proposedRiskAnswers, riskSummaryRequestText } from '../src/server/services/ai/agents/risk-calls'
import { riskFacts, type RiskFacts, type RiskSummaryQuestion } from '../src/server/services/risk/ai-facts'
import { ROOT } from './lib/ai-eval-cases'

// The evaluation set of the Risk Agent, demo tier (S11-14 · FR-AI-306 AC5 · BR-AI-34 · ADR-146): the cases of
// tests/fixtures/ai-docs/risk/cases.yaml, one shape for the file generator (scripts/ai-docs-risk.ts), the evaluation
// (pnpm ai:eval --agent risk) and the tests. Each document is one RISK_ANSWER_DRAFT call that asks the 12 questions of
// SIMEC's draft set, built with the app's own code (riskDraftInputText, proposedRiskAnswers). The floors of BR-AI-34:
// optionCode right for at least 90 % of the questions a document answers, and an answer proposed for a question it does
// not answer (a false positive) at most 5 % — scored on what the form proposes to a person (after ai-risk-verify).
// RISK_FILE_SUMMARY of each paper that is not a certificate, for the reviewer of its domain (FR-AI-306 AC3): its text
// passes ai-text (BR-AI-27 profile RISK) and never advises a decision, both 100 %, as OQ-209 set for the Sourcing Agent's
// texts; the questions it lists as contradicted by the file are right for at least 90 % of the answered questions of the
// slot (EVAL_THRESHOLDS_BP.other · a floor S11-14 chose, the spec names none).

export const RISK_DOCS_DIR = path.join(ROOT, 'tests', 'fixtures', 'ai-docs', 'risk')

/** SIMEC's draft set of 12 questions (docs/sub-specs/S11.md · OQ-221 · the words of S11-12's sheet Risk_Questionnaire) */
const YN = (evidence = false) => [
  { code: 'Y', labelTh: 'มี', ...(evidence ? { evidence: true } : {}) },
  { code: 'N', labelTh: 'ไม่มี' },
]
const NY = [
  { code: 'N', labelTh: 'ไม่ใช่' },
  { code: 'Y', labelTh: 'ใช่' },
]
export const RISK_QUESTIONS = [
  { code: 'RQ-GEN-01', domain: 'GENERAL', textTh: 'บริษัทดำเนินกิจการมานานเท่าใด', options: [{ code: 'A', labelTh: '5 ปีขึ้นไป' }, { code: 'B', labelTh: '2 ถึง 5 ปี' }, { code: 'C', labelTh: 'น้อยกว่า 2 ปี' }] },
  { code: 'RQ-GEN-02', domain: 'GENERAL', textTh: 'มูลค่างานกับบริษัทต่อปีที่คาด', options: [{ code: 'A', labelTh: 'ไม่เกิน 1 ล้านบาท' }, { code: 'B', labelTh: '1 ถึง 10 ล้านบาท' }, { code: 'C', labelTh: 'เกิน 10 ล้านบาท' }] },
  { code: 'RQ-GEN-03', domain: 'GENERAL', textTh: 'มีประกันภัยความรับผิดต่อบุคคลภายนอก', options: YN() },
  { code: 'RQ-PRV-01', domain: 'PRIVACY', textTh: 'จำนวนเจ้าของข้อมูลส่วนบุคคลที่จะประมวลผลแทนบริษัท', options: [{ code: 'A', labelTh: 'น้อยกว่า 1,000 คน' }, { code: 'B', labelTh: '1,000 ถึง 10,000 คน' }, { code: 'C', labelTh: 'มากกว่า 10,000 คน' }] },
  { code: 'RQ-PRV-02', domain: 'PRIVACY', textTh: 'มีนโยบายคุ้มครองข้อมูลส่วนบุคคลและยอมลงนามข้อตกลงประมวลผลข้อมูล (DPA)', options: YN() },
  { code: 'RQ-PRV-03', domain: 'PRIVACY', textTh: 'มีการโอนข้อมูลส่วนบุคคลออกนอกประเทศ', options: NY },
  { code: 'RQ-IS-01', domain: 'INFOSEC', textTh: 'มีใบรับรอง ISO/IEC 27001 ที่ครอบขอบเขตงาน', options: YN(true) },
  { code: 'RQ-IS-02', domain: 'INFOSEC', textTh: 'บังคับยืนยันตัวตนหลายขั้นตอน (MFA) สำหรับผู้ใช้ที่เข้าระบบของบริษัท', options: YN() },
  { code: 'RQ-IS-03', domain: 'INFOSEC', textTh: 'มีแผนรับมือเหตุการณ์ด้านความปลอดภัยและแจ้งบริษัทภายใน 72 ชั่วโมง', options: YN() },
  { code: 'RQ-PRM-01', domain: 'PREMISES', textTh: 'พนักงานที่เข้าพื้นที่ผ่านอบรมความปลอดภัยและมีบัตรประจำตัว', options: YN() },
  { code: 'RQ-PRM-02', domain: 'PREMISES', textTh: 'มีใบรับรอง ISO 45001 ที่ครอบงานที่จ้าง', options: YN(true) },
  { code: 'RQ-FIN-01', domain: 'FINANCE', textTh: 'มีงบการเงินที่ผู้สอบบัญชีรับรองของปีล่าสุด', options: YN() },
] as const satisfies readonly { code: string; domain: string; textTh: string; options: readonly { code: string; labelTh: string; evidence?: boolean }[] }[]

const CODES = RISK_QUESTIONS.map((q) => q.code) as string[]
const optionOf = (code: string, option: string) => RISK_QUESTIONS.find((q) => q.code === code)?.options.find((o) => o.code === option)

const ISO = /^\d{4}-\d{2}-\d{2}$/
const Code = z.string().refine((c) => CODES.includes(c), 'a question of the draft set')
const Answers = z.record(Code, z.string())
const Case = z
  .strictObject({
    id: z.string().regex(/^RK-\d{2}$/),
    group: z.enum(['PDPA', 'INFOSEC', 'PREMISES', 'COMPANY_CERT']),
    layout: z.enum(['A4_TYPED', 'A4_SCANNED', 'PHOTO']),
    quality: z.enum(['CLEAN', 'SKEWED', 'BLURRY', 'STAMPED']),
    digits: z.enum(['ARABIC', 'THAI']),
    file: z.union([z.strictObject({ kind: z.literal('EVIDENCE'), question: Code }), z.strictObject({ kind: z.literal('DOCUMENT'), type: z.literal('COMPANY_CERT') })]),
    supplier: z.string().min(1),
    title: z.string().min(1),
    issuedOn: z.string().regex(ISO),
    sections: z.array(z.strictObject({ heading: z.string().min(1), body: z.string().min(1) })).optional(),
    certificate: z
      .strictObject({
        taxId: z.string().refine(isValidThaiTaxId, 'a tax id with its check digit'),
        registrationDate: z.string().regex(ISO),
        address: z.string().min(1),
        capital: z.string().regex(/^\d+$/),
        directors: z.array(z.string()).min(1),
      })
      .optional(),
    expect: Answers,
    mayAnswer: Answers.optional(),
    review: z.strictObject({ domain: z.enum(['PRIVACY', 'INFOSEC', 'PREMISES']), answers: Answers, inconsistent: z.array(Code) }).optional(),
  })
  .superRefine((c, ctx) => {
    for (const [code, option] of [...Object.entries(c.expect), ...Object.entries(c.mayAnswer ?? {}), ...Object.entries(c.review?.answers ?? {})]) {
      if (!optionOf(code, option)) ctx.addIssue({ code: 'custom', message: `${c.id}: ${code} has no option ${option}` })
    }
    if ((c.group === 'COMPANY_CERT') !== (c.certificate !== undefined) || (c.group === 'COMPANY_CERT') === (c.sections !== undefined)) ctx.addIssue({ code: 'custom', message: `${c.id}: a certificate has its registry fields, a paper its sections` })
    // the summary sends a certificate only when an answer rests on it (riskSummarySource): no review for one
    if ((c.group === 'COMPANY_CERT') === (c.review !== undefined)) ctx.addIssue({ code: 'custom', message: `${c.id}: a review for every paper and none for a certificate` })
    for (const code of c.review?.inconsistent ?? []) if (!c.review?.answers[code]) ctx.addIssue({ code: 'custom', message: `${c.id}: ${code} contradicted but not answered` })
  })
export type RiskCase = z.infer<typeof Case>

export function loadRiskCases(): { today: string; cases: RiskCase[] } {
  const raw = parse(readFileSync(path.join(RISK_DOCS_DIR, 'cases.yaml'), 'utf8')) as { today: unknown; cases: unknown[] }
  return { today: z.string().regex(ISO).parse(raw.today), cases: raw.cases.map((c) => Case.parse(c)) }
}

// ---------- RISK_ANSWER_DRAFT: the call as the job makes it, and what the form proposes ----------

/** What the file is in the call, as riskDraftSource names it: a document by its type, an evidence file by its question */
export const riskFileAbout = (c: RiskCase): string => (c.file.kind === 'DOCUMENT' ? c.file.type : `evidence for ${c.file.question}`)

/** The question set as ai-risk-verify sees it (evidence options flagged) */
export const RISK_QUESTION_SET: readonly RiskDraftQuestion[] = RISK_QUESTIONS.map((q) => ({ code: q.code, options: q.options.map((o) => ({ code: o.code, ...('evidence' in o && o.evidence ? { evidence: true } : {}) })) }))

/** The text of the call: today, every question of the set unanswered, and the one file F1 */
export const riskDraftText = (c: RiskCase, today: string): string =>
  riskDraftInputText({
    today,
    questions: RISK_QUESTIONS.map((q) => ({ code: q.code, text: q.textTh, options: q.options.map((o) => ({ code: o.code, label: o.labelTh })) })),
    files: [{ label: 'F1', kind: riskFileAbout(c) }],
  })

export interface RiskDraftScore {
  /** One per question the document answers: the form proposes the option a person read */
  readonly optionCode: readonly { readonly code: string; readonly ok: boolean; readonly got: string | null }[]
  /** One per question the document does not answer: the form proposes nothing (or the allowed option of mayAnswer) */
  readonly noFalsePositive: readonly { readonly code: string; readonly ok: boolean; readonly got: string | null }[]
}

/** Scores one draft on what the form proposes (no certificate verified: an evidence option stays, with its WARN) */
export function scoreRiskDraft(c: RiskCase, answers: RiskAnswerDraft['answers']): RiskDraftScore {
  const { proposed } = proposedRiskAnswers({ questionSet: RISK_QUESTION_SET, evidenceAvailable: [], asked: CODES, answers })
  const got = (code: string) => proposed[code] ?? null
  const optionCode = Object.entries(c.expect).map(([code, option]) => ({ code, ok: got(code) === option, got: got(code) }))
  const noFalsePositive = CODES.filter((code) => !Object.hasOwn(c.expect, code)).map((code) => {
    const allowed = c.mayAnswer?.[code]
    return { code, ok: got(code) === null || got(code) === allowed, got: got(code) }
  })
  return { optionCode, noFalsePositive }
}

// ---------- RISK_FILE_SUMMARY: the reviewer's slot of a paper ----------

/** The reviewer's part of a paper, as riskSummarySource builds it: GENERAL and the domain, the paper the one evidence file */
export function riskSummaryCall(c: RiskCase): { facts: RiskFacts; text: string; answered: readonly string[] } {
  const review = c.review!
  const evidenceOf = c.file.kind === 'EVIDENCE' ? c.file.question : null
  const questions: RiskSummaryQuestion[] = RISK_QUESTIONS.filter((q) => q.domain === 'GENERAL' || q.domain === review.domain).map((q) => {
    const option = review.answers[q.code]
    return { code: q.code, domain: q.domain, text: q.textTh, answer: option ? optionOf(q.code, option)!.labelTh : null, source: option ? 'EXPLICIT' : null, files: option && q.code === evidenceOf ? 1 : 0 }
  })
  const n = Number(c.id.slice(3))
  const facts = riskFacts({ number: `RA-2569-${String(n).padStart(5, '0')}`, supplierCode: `SP09${String(n).padStart(2, '0')}`, questions })
  return { facts, text: riskSummaryRequestText(facts, questions, [{ label: 'F1', about: riskFileAbout(c) }]), answered: questions.filter((q) => q.answer !== null).map((q) => q.code) }
}

export interface RiskSummaryScore {
  readonly text: boolean
  readonly reason: string | null
  readonly noAdvice: boolean
  /** One per answered question of the slot: listed as contradicted exactly when the paper contradicts it */
  readonly inconsistent: readonly { readonly code: string; readonly ok: boolean }[]
}

export function scoreRiskSummary(c: RiskCase, output: RiskSummaryText): RiskSummaryScore {
  const { facts, answered } = riskSummaryCall(c)
  const checked = checkAiText(output.sentences, facts, RISK_PROFILE, DECISION_ADVICE_WORDS)
  const lower = output.sentences.join(' ').toLowerCase()
  // the job keeps only codes of answered questions of the slot (writeRiskSummary)
  const listed = new Set(output.inconsistentQuestionCodes.filter((code) => answered.includes(code)))
  const expected = new Set(c.review!.inconsistent)
  return {
    text: checked.ok,
    reason: checked.ok ? null : checked.reason,
    noAdvice: !DECISION_ADVICE_WORDS.some((w) => lower.includes(w.toLowerCase())),
    inconsistent: answered.map((code) => ({ code, ok: listed.has(code) === expected.has(code) })),
  }
}

/** The floors per metric of the report (BR-AI-34 for the draft; the summary's as written above) */
export const RISK_FLOORS = {
  optionCode: EVAL_THRESHOLDS_BP.other,
  noFalsePositive: 9500,
  text: 10_000,
  noDecisionAdvice: 10_000,
  inconsistent: EVAL_THRESHOLDS_BP.other,
} as const

// ---------- the truth as an answer (fixture mode without a live run) ----------

export const riskTruthDraft = (c: RiskCase): RiskAnswerDraft => ({
  answers: Object.entries(c.expect).map(([questionCode, optionCode]) => ({ questionCode, optionCode, sourceRef: 'F1', quote: '', confidence: 95 })),
})

export const riskTruthSummary = (c: RiskCase): RiskSummaryText => ({
  sentences: ['ใบ {{v:assessment}} ของผู้ขาย {{v:supplier}} ตอบแล้ว {{v:answeredCount}} จาก {{v:questionCount}} ข้อ', 'ยังไม่ได้ตอบ {{v:missingCount}} ข้อ'],
  inconsistentQuestionCodes: [...c.review!.inconsistent],
})
