import { OPS } from '../forms'
import { RISK_TIER_CODES, SCREENING_FIELDS, type RiskCondition, type RiskOption, type RiskTierCode, type RiskTierDef } from './types'

// BR-RSK-02 (ADR-229): what an administrator may propose for the tiers, and the lint of a questionnaire version before
// it is sent for publishing (BR-RSK-01 · BR-RSK-05). Pure: the rows of the organization are passed in.

/** The values of a tier an administrator may change; any left out keeps the value in effect */
export interface TierChange {
  readonly minPoints?: number
  readonly reviewMonths?: number
  readonly reminderDaysBefore?: number
  readonly blocksPo?: boolean
  readonly requiresExplicitAnswers?: boolean
}

/** The tiers as they would be once the changes are confirmed (the tiers in effect are not changed) */
export function applyTierChanges(tiers: readonly RiskTierDef[], changes: Readonly<Partial<Record<RiskTierCode, TierChange>>>): RiskTierDef[] {
  return tiers.map((t) => ({ ...t, ...(changes[t.code] ?? {}) }))
}

/**
 * The order the tiers must keep (BR-RSK-02 · BR-RSK-04): one row of each code, LOW from 0, and the lower bounds rising
 * strictly LOW < MEDIUM < HIGH, so every number of points falls in exactly one tier. Null when they do.
 */
export function tierOrderProblem(tiers: readonly RiskTierDef[]): 'MISSING_TIER' | 'LOW_NOT_ZERO' | 'NOT_RISING' | null {
  const byCode = RISK_TIER_CODES.map((code) => tiers.filter((t) => t.code === code))
  if (byCode.some((rows) => rows.length !== 1)) return 'MISSING_TIER'
  const [low, medium, high] = byCode.map((rows) => rows[0]!)
  if (low!.minPoints !== 0) return 'LOW_NOT_ZERO'
  return medium!.minPoints > low!.minPoints && high!.minPoints > medium!.minPoints ? null : 'NOT_RISING'
}

// ---------- the lint of a questionnaire version (admin.riskQuestionnaire.submitForPublish) ----------

/** The question code of the file, the sheet, the scenes, golden and S7's linkedRiskQuestionCodes (SEAM-S7xS11-X-17) */
export const RISK_QUESTION_CODE = /^RQ-[A-Z]{2,4}-\d{2}$/

export interface LintQuestion {
  readonly code: string
  readonly options: readonly RiskOption[]
  readonly appliesWhen?: RiskCondition | null
  readonly evidenceScopeRequired: boolean
  readonly evidenceScope: string | null
}

/** An active SupplierDocumentType of the organization and the questions it answers (S7) */
export interface LintDocumentType {
  readonly code: string
  readonly singleInstance: boolean
  readonly linkedRiskQuestionCodes: readonly string[]
}

export type QuestionnaireLintCode = 'RISK_LINT_OPTIONS' | 'RISK_LINT_CONDITION' | 'RISK_LINT_SCOPE_REQUIRED' | 'RISK_LINT_UNKNOWN_QUESTION'

export interface QuestionnaireLintIssue {
  readonly code: QuestionnaireLintCode
  readonly question?: string
  readonly documentType?: string
  /** What is wrong, as a code the screen turns into words */
  readonly reason: string
}

/** The variables a question's condition may read besides the screening fields (BR-RSK-01) */
const RISK_VARIABLES = ['$category', '$payeeType', '$isForeign', '$inherentTier'] as const
const RISK_OPS: readonly string[] = [...OPS, 'anyIn']

function optionIssues(q: LintQuestion): string[] {
  const reasons: string[] = []
  if (!RISK_QUESTION_CODE.test(q.code)) reasons.push('CODE_FORMAT')
  if (q.options.length < 2) reasons.push('FEWER_THAN_TWO')
  if (new Set(q.options.map((o) => o.code)).size !== q.options.length) reasons.push('DUPLICATE_OPTION')
  if (q.options.some((o) => !Number.isInteger(o.points) || o.points < 0)) reasons.push('POINTS')
  if (q.options.some((o) => o.minTier !== undefined && !(RISK_TIER_CODES as readonly string[]).includes(o.minTier))) reasons.push('MIN_TIER')
  if (q.options.filter((o) => o.evidence === true).length > 1) reasons.push('MORE_THAN_ONE_EVIDENCE_OPTION')
  return reasons
}

/** Why a condition cannot be read on an assessment's context, or null (§7.9 on the fields of BR-RSK-01) */
export function riskConditionProblem(when: RiskCondition): string | null {
  if ('all' in when || 'any' in when) {
    const parts = 'all' in when ? when.all : when.any
    if (parts.length === 0) return 'EMPTY_GROUP'
    for (const part of parts) {
      const problem = riskConditionProblem(part)
      if (problem) return problem
    }
    return null
  }
  const known = (SCREENING_FIELDS as readonly string[]).includes(when.field) || (RISK_VARIABLES as readonly string[]).includes(when.field)
  if (!known) return 'UNKNOWN_FIELD'
  if (!RISK_OPS.includes(when.op)) return 'UNKNOWN_OP'
  if ((when.op === 'anyIn') !== (when.field === '$category')) return 'CATEGORY_TAKES_ANY_IN'
  if (when.op === 'anyIn') return Array.isArray(when.value) && when.value.length > 0 ? null : 'VALUE'
  if ((SCREENING_FIELDS as readonly string[]).includes(when.field) && when.op === 'eq' && when.value !== 'Y' && when.value !== 'N') return 'VALUE'
  if (when.field === '$inherentTier' && when.op === 'eq' && !(RISK_TIER_CODES as readonly string[]).includes(String(when.value))) return 'VALUE'
  return null
}

/**
 * The lint of a draft before it is sent (BR-RSK-01 · BR-RSK-05): every question has a code of the agreed format and at
 * least two options with whole points ≥ 0 and at most one chosen by evidence (RISK_LINT_OPTIONS · error); its condition
 * reads only the screening fields and the four variables (RISK_LINT_CONDITION · error); a question that a document type
 * of several copies (singleInstance = false) answers names the scope it asks for (RISK_LINT_SCOPE_REQUIRED · error); a
 * document type that names a question the draft does not have is a warning (RISK_LINT_UNKNOWN_QUESTION).
 */
export function lintQuestionnaire(questions: readonly LintQuestion[], documentTypes: readonly LintDocumentType[]): { errors: QuestionnaireLintIssue[]; warnings: QuestionnaireLintIssue[] } {
  const errors: QuestionnaireLintIssue[] = []
  const warnings: QuestionnaireLintIssue[] = []
  if (questions.length === 0) errors.push({ code: 'RISK_LINT_OPTIONS', reason: 'NO_QUESTIONS' })
  const seen = new Set<string>()
  for (const q of questions) {
    if (seen.has(q.code)) errors.push({ code: 'RISK_LINT_OPTIONS', question: q.code, reason: 'DUPLICATE_QUESTION' })
    seen.add(q.code)
    for (const reason of optionIssues(q)) errors.push({ code: 'RISK_LINT_OPTIONS', question: q.code, reason })
    const problem = q.appliesWhen ? riskConditionProblem(q.appliesWhen) : null
    if (problem) errors.push({ code: 'RISK_LINT_CONDITION', question: q.code, reason: problem })
  }
  for (const type of documentTypes) {
    for (const code of type.linkedRiskQuestionCodes) {
      const q = questions.find((x) => x.code === code)
      if (!q) {
        warnings.push({ code: 'RISK_LINT_UNKNOWN_QUESTION', question: code, documentType: type.code, reason: 'NOT_IN_VERSION' })
        continue
      }
      if (!type.singleInstance && !(q.evidenceScopeRequired && (q.evidenceScope ?? '').trim() !== '')) {
        errors.push({ code: 'RISK_LINT_SCOPE_REQUIRED', question: code, documentType: type.code, reason: 'SCOPE_REQUIRED' })
      }
    }
  }
  return { errors, warnings }
}
