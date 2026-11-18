import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fieldScore } from '@/core/ai-checks'
import { fixtureKey } from '@/integrations/ai'
import { AWAITING_EVALUATION, EVAL_GATES, modelForPurpose, PROMPT_VERSIONS } from '@/lib/ai-config'
import { RiskAnswerDraft, RiskSummaryText } from '@/lib/ai-schemas/agents'
import { AI_ANSWERS_DIR, ROOT } from '../../scripts/lib/ai-eval-cases'
import { loadRiskCases, RISK_DOCS_DIR, RISK_FLOORS, RISK_QUESTIONS, riskDraftText, riskSummaryCall, riskTruthDraft, riskTruthSummary, scoreRiskDraft, scoreRiskSummary } from '../../scripts/ai-eval-risk'

// S11-14 (FR-AI-306 AC5 · BR-AI-34 · ADR-146): the evaluation set of the Risk Agent, demo tier — 10 synthetic documents
// (3 privacy, 3 information-security and 2 site-safety papers, 2 company certificates) drawn from their cases, each asked
// the 12 questions of SIMEC's draft set the way the job risk-ai-draft asks them, and scored on what the form proposes.

const { today, cases } = loadRiskCases()
const PURPOSES = ['RISK_ANSWER_DRAFT', 'RISK_FILE_SUMMARY'] as const
const manifest = new Map(
  (JSON.parse(readFileSync(path.join(RISK_DOCS_DIR, 'manifest.json'), 'utf8')) as { files: Array<{ id: string; file: string; mediaType: string; sha256: string }> }).files.map((f) => [f.id, f]),
)
const fileOf = (id: string) => {
  const m = manifest.get(id)!
  return { bytes: readFileSync(path.join(RISK_DOCS_DIR, m.file)), mediaType: m.mediaType as 'application/pdf' }
}
const recorded = (purpose: 'RISK_ANSWER_DRAFT' | 'RISK_FILE_SUMMARY', text: string, id: string) => {
  const file = path.join(AI_ANSWERS_DIR, `${fixtureKey({ purpose, text, files: [fileOf(id)] })}.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { promptVersion: string; model: string; recorded?: string; output: unknown }) : null
}

describe('[FR-AI-306/AC5] the evaluation set of the Risk Agent, demo tier', () => {
  it('[FR-AI-306/AC5] holds 10 documents: 3 privacy, 3 information-security, 2 site-safety papers and 2 company certificates, each a file of the manifest', () => {
    const count = (g: string) => cases.filter((c) => c.group === g).length
    expect([cases.length, count('PDPA'), count('INFOSEC'), count('PREMISES'), count('COMPANY_CERT')]).toEqual([10, 3, 3, 2, 2])
    expect(new Set(cases.map((c) => c.id)).size).toBe(10)
    for (const c of cases) {
      const m = manifest.get(c.id)
      expect(m, c.id).toBeDefined()
      expect(createHash('sha256').update(fileOf(c.id).bytes).digest('hex'), `${c.id}: the file is the one the manifest holds`).toBe(m!.sha256)
    }
    // the hard ones: photos, scans, a stamp across the text, Thai digits; answers N as well as Y; contradictions to find
    expect(cases.some((c) => c.layout === 'PHOTO') && cases.some((c) => c.layout === 'A4_SCANNED') && cases.some((c) => c.quality === 'STAMPED') && cases.some((c) => c.digits === 'THAI')).toBe(true)
    expect(cases.flatMap((c) => Object.values(c.expect))).toEqual(expect.arrayContaining(['Y', 'N', 'A', 'B']))
    expect(cases.filter((c) => (c.review?.inconsistent.length ?? 0) > 0).length).toBeGreaterThanOrEqual(3)
  })

  it('[FR-AI-306/AC5] [BR-AI-34] every document is asked all 12 questions with today and its one file, as the job asks them', () => {
    const text = riskDraftText(cases[0]!, today)
    expect(text.split('\n')[0]).toBe(`Today: ${today} (พ.ศ. ${Number(today.slice(0, 4)) + 543})`)
    // one option a line (S11-14: a count with a thousands comma read wrong on one line)
    expect(text).toContain('RQ-PRV-01: จำนวนเจ้าของข้อมูลส่วนบุคคลที่จะประมวลผลแทนบริษัท\n  A = น้อยกว่า 1,000 คน\n  B = 1,000 ถึง 10,000 คน\n')
    for (const q of RISK_QUESTIONS) expect(text).toContain(`${q.code}: ${q.textTh}\n  ${q.options[0].code} = `)
    expect(text).toContain('F1: evidence for RQ-PRV-02')
    expect(riskDraftText(cases.find((c) => c.group === 'COMPANY_CERT')!, today)).toContain('F1: COMPANY_CERT')
  })

  it('[FR-AI-306/AC5] [BR-AI-34] a draft is scored on what the form proposes: the option of each supported question, nothing for the rest', () => {
    const rk04 = cases.find((c) => c.id === 'RK-04')!
    const a = (questionCode: string, optionCode: string) => ({ questionCode, optionCode, sourceRef: 'F1', quote: '', confidence: 90 })
    const truth = scoreRiskDraft(rk04, riskTruthDraft(rk04).answers)
    expect(truth.optionCode.every((x) => x.ok) && truth.noFalsePositive.every((x) => x.ok)).toBe(true)
    expect(truth.optionCode).toHaveLength(2)
    expect(truth.noFalsePositive).toHaveLength(10)
    // a wrong option, an answer to a question the paper does not answer, the allowed option of mayAnswer and a forbidden one
    const s = scoreRiskDraft(rk04, [a('RQ-IS-02', 'N'), a('RQ-IS-03', 'Y'), a('RQ-GEN-03', 'Y'), a('RQ-IS-01', 'N')])
    expect(s.optionCode.find((x) => x.code === 'RQ-IS-02')).toMatchObject({ ok: false, got: 'N' })
    expect(s.noFalsePositive.filter((x) => !x.ok).map((x) => x.code)).toEqual(['RQ-GEN-03'])
    expect(scoreRiskDraft(rk04, [a('RQ-IS-01', 'Y')]).noFalsePositive.find((x) => x.code === 'RQ-IS-01')!.ok).toBe(false)
    // what ai-risk-verify throws away never reaches the form: an unknown option, a code outside the set, a second answer
    const dropped = scoreRiskDraft(rk04, [a('RQ-GEN-01', 'Z'), a('RQ-XX-01', 'Y'), a('RQ-IS-02', 'Y'), a('RQ-IS-02', 'N')])
    expect(dropped.noFalsePositive.every((x) => x.ok)).toBe(true)
    expect(dropped.optionCode.find((x) => x.code === 'RQ-IS-02')!.ok).toBe(true)
  })

  it('[FR-AI-306/AC5] [BR-AI-27] a summary is scored on ai-text, advice and the questions the paper contradicts', () => {
    const rk02 = cases.find((c) => c.id === 'RK-02')!
    const truth = scoreRiskSummary(rk02, riskTruthSummary(rk02))
    expect(truth.text && truth.noAdvice && truth.inconsistent.every((x) => x.ok)).toBe(true)
    // GENERAL and PRIVACY of RK-02, all six answered
    expect(riskSummaryCall(rk02).answered).toEqual(['RQ-GEN-01', 'RQ-GEN-02', 'RQ-GEN-03', 'RQ-PRV-01', 'RQ-PRV-02', 'RQ-PRV-03'])
    const typed = scoreRiskSummary(rk02, { sentences: ['ผู้ขายตอบแล้ว 6 ข้อ'], inconsistentQuestionCodes: ['RQ-PRV-03', 'RQ-IS-02'] })
    expect([typed.text, typed.reason]).toEqual([false, 'DIGIT_OUTSIDE_PLACEHOLDER'])
    // a code outside the slot is left out as the job leaves it out; RQ-PRV-02 missed
    expect(typed.inconsistent.filter((x) => !x.ok).map((x) => x.code)).toEqual(['RQ-PRV-02'])
    expect(scoreRiskSummary(rk02, { sentences: ['ควรอนุมัติผู้ขาย {{v:supplier}}'], inconsistentQuestionCodes: [] }).noAdvice).toBe(false)
  })

  it('[FR-AI-306/AC5] both purposes are gated SYNTHETIC on the prompt and model in use, and the report is in the repository', () => {
    for (const purpose of PURPOSES) {
      const gate = EVAL_GATES.find((g) => g.purpose === purpose)
      expect(gate, purpose).toMatchObject({ agent: 'RISK', promptVersion: PROMPT_VERSIONS[purpose], model: modelForPurpose(purpose, {}), tier: 'SYNTHETIC' })
      expect(existsSync(path.join(ROOT, 'docs', 'reports', 'ai-eval', gate!.report)), gate!.report).toBe(true)
    }
    expect(AWAITING_EVALUATION.filter((p) => (PURPOSES as readonly string[]).includes(p))).toEqual([])
  })

  it('[FR-AI-306/AC5] [BR-AI-34] every call has the answer Claude gave with the gated prompt and model, and the answers meet every floor', () => {
    const tally = new Map<keyof typeof RISK_FLOORS, { correct: number; total: number }>()
    const add = (field: keyof typeof RISK_FLOORS, ok: boolean) => {
      const t = tally.get(field) ?? { correct: 0, total: 0 }
      t.total++
      if (ok) t.correct++
      tally.set(field, t)
    }
    const live = (purpose: (typeof PURPOSES)[number], text: string, id: string) => {
      const answer = recorded(purpose, text, id)
      expect(answer, `${id} ${purpose}: a recorded answer`).not.toBeNull()
      expect(answer, `${id} ${purpose}`).toMatchObject({ recorded: 'LIVE', promptVersion: PROMPT_VERSIONS[purpose], model: modelForPurpose(purpose, {}) })
      return answer!.output
    }
    for (const c of cases) {
      const draft = RiskAnswerDraft.parse(live('RISK_ANSWER_DRAFT', riskDraftText(c, today), c.id))
      const s = scoreRiskDraft(c, draft.answers)
      for (const x of s.optionCode) add('optionCode', x.ok)
      for (const x of s.noFalsePositive) add('noFalsePositive', x.ok)
      if (!c.review) continue
      const summary = scoreRiskSummary(c, RiskSummaryText.parse(live('RISK_FILE_SUMMARY', riskSummaryCall(c).text, c.id)))
      add('text', summary.text)
      add('noDecisionAdvice', summary.noAdvice)
      for (const x of summary.inconsistent) add('inconsistent', x.ok)
    }
    expect([...tally.keys()].sort()).toEqual(Object.keys(RISK_FLOORS).sort())
    for (const [field, t] of tally) {
      expect(fieldScore({ correct: t.correct, total: t.total, thresholdBp: RISK_FLOORS[field], missed: 0, critical: false }).pass, `${field} ${t.correct}/${t.total}`).toBe(true)
    }
  })
})
