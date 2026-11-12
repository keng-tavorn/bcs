import { z } from 'zod'
import { RISK_DOMAINS, RISK_QUESTION_CODE, RISK_TIER_CODES, tierOrderProblem, type RiskTierCode } from '@/core/risk'
import type { InputWorkbook, SheetRow } from './workbook'

// Supplier risk of the phase-1 organization (S11-12 · docs/sub-specs/S11.md "การอ่านชีตของไฟล์ระยะ 1"): the sheets
// Risk_Tiers Risk_Policy Risk_Questionnaire (the organization's draft values, OQ-221 OQ-222 OQ-226 OQ-227) seeded in effect
// as the customer's ORG_ADMINs would leave them after the 4-eyes of BR-RSK-02 (the first of sheet Org's orgAdmins
// proposed, the second confirmed and published), and the rows of Risk_Assessments and Risk_Overrides read for the
// history (src/server/services/demo-seed/risk.ts plays those with the real commands). Rules RR of Risk_Reviewers are
// read by seed/workflow.ts. Nothing of this is in code: a row that cannot be read stops the seed with a Thai message
// naming the sheet and row, for the person to fix scripts/inputs_p1. The demo workbook has none of these sheets.

const TIERS = 'Risk_Tiers'
const POLICY = 'Risk_Policy'
const QUESTIONS = 'Risk_Questionnaire'
const ASSESSMENTS = 'Risk_Assessments'
const OVERRIDES = 'Risk_Overrides'
const SCREENING = ['processesPersonalData', 'accessesSystems', 'accessesPremises'] as const
const ASSESSMENT_STATUSES = ['COMPLETED', 'IN_REVIEW', 'RETURNED', 'DRAFT', 'CANCELLED'] as const

const yesNo = (at: string, v: string | null | undefined): boolean => {
  if (v !== 'Y' && v !== 'N') throw new Error(`${at}: ต้องเป็น Y หรือ N (ได้ "${v ?? ''}")`)
  return v === 'Y'
}
const whole = (at: string, v: string | null | undefined, min = 0): number => {
  const n = Number(v)
  if (v === null || !Number.isInteger(n) || n < min) throw new Error(`${at}: ต้องเป็นจำนวนเต็มตั้งแต่ ${min} (ได้ "${v ?? ''}")`)
  return n
}
const list = (v: string | null | undefined, separator = ','): string[] => (v ?? '').split(separator).map((x) => x.trim()).filter(Boolean)
const json = (at: string, v: string | null | undefined): unknown => {
  try {
    return JSON.parse(v ?? '')
  } catch {
    throw new Error(`${at}: อ่านเป็น JSON ไม่ได้`)
  }
}
const cell = (sheet: string, r: SheetRow, key: string) => `ชีต ${sheet} แถว ${r.row} (${key})`

const Option = z.strictObject({
  code: z.string().regex(/^[A-Z0-9_]{1,20}$/),
  labelTh: z.string().min(1),
  labelEn: z.string().min(1),
  points: z.int().min(0),
  minTier: z.enum(RISK_TIER_CODES).optional(),
  evidence: z.boolean().optional(),
})

export interface RiskTierRow {
  readonly code: RiskTierCode
  readonly nameTh: string
  readonly nameEn: string
  readonly minPoints: number
  readonly reviewMonths: number
  readonly reminderDaysBefore: number
  readonly blocksPo: boolean
  readonly requiresExplicitAnswers: boolean
}
export interface RiskQuestionRow {
  readonly code: string
  readonly domain: (typeof RISK_DOMAINS)[number]
  readonly textTh: string
  readonly textEn: string
  readonly options: ReadonlyArray<z.infer<typeof Option>>
  readonly appliesWhen: Record<string, unknown> | null
  readonly required: boolean
  readonly evidenceScopeRequired: boolean
  readonly evidenceScope: string | null
  readonly aiReadable: boolean
  readonly sortOrder: number
}
export type Screening = Record<(typeof SCREENING)[number], 'Y' | 'N'>
export interface RiskAssessmentRow {
  readonly ref: string
  readonly supplierCode: string
  readonly screening: Screening
  readonly categoryCodes: readonly string[]
  readonly workScopes: readonly string[]
  readonly openedBy: string
  readonly openedDaysAgo: number
  readonly answers: Readonly<Record<string, string>>
  readonly filledOnBehalf: string | null
  readonly status: (typeof ASSESSMENT_STATUSES)[number]
  readonly completedDaysAgo: number | null
  /** A fixed day (YYYY-MM-DD) instead of completedDaysAgo; openedDaysAgo then counts back from it */
  readonly completedOn: string | null
  readonly expectedPoints: number | null
  readonly expectedTier: RiskTierCode | null
  readonly reviewers: readonly string[]
}
export interface RiskOverrideRow {
  readonly ref: string
  readonly supplierCode: string
  readonly capGross: string
  readonly expiresDaysAhead: number
  readonly requestedBy: string
  readonly requestedDaysAgo: number
  readonly approver: string
  readonly reason: string
}
export interface RiskSheets {
  readonly tiers: readonly RiskTierRow[]
  readonly policy: {
    readonly screeningTierMap: Readonly<Record<string, RiskTierCode>>
    readonly highRiskCategories: readonly string[]
    readonly registryFlagBlocks: boolean
    readonly mediumOverdueBlocks: boolean
    readonly overrideChatButton: boolean
  }
  readonly questions: readonly RiskQuestionRow[]
  readonly assessments: readonly RiskAssessmentRow[]
  readonly overrides: readonly RiskOverrideRow[]
  /** sheet Org's orgAdmins: the first proposes, the second confirms and publishes (BR-RSK-02) */
  readonly admins: readonly [string, string]
}

/** null for a workbook without the risk sheets (the demo) */
export function parseRiskSheets(workbook: InputWorkbook): RiskSheets | null {
  if (!workbook.hasSheet(TIERS)) return null
  const tiers = workbook.table(TIERS).map((r): RiskTierRow => {
    const at = (k: string) => cell(TIERS, r, k)
    const code = r.values.code ?? null
    if (!(RISK_TIER_CODES as readonly (string | null)[]).includes(code)) throw new Error(`${at('code')}: ต้องเป็น ${RISK_TIER_CODES.join(' ')}`)
    return {
      code: code as RiskTierCode,
      nameTh: r.values.nameTh ?? code!,
      nameEn: r.values.nameEn ?? code!,
      minPoints: whole(at('minPoints'), r.values.minPoints),
      reviewMonths: whole(at('reviewMonths'), r.values.reviewMonths, 1),
      reminderDaysBefore: whole(at('reminderDaysBefore'), r.values.reminderDaysBefore),
      blocksPo: yesNo(at('blocksPo'), r.values.blocksPo),
      requiresExplicitAnswers: yesNo(at('requiresExplicitAnswers'), r.values.requiresExplicitAnswers),
    }
  })
  const order = tierOrderProblem(tiers.map((t) => ({ ...t })))
  if (order || tiers.length !== RISK_TIER_CODES.length) throw new Error(`ชีต ${TIERS}: ต้องมี LOW MEDIUM HIGH ระดับละแถว LOW เริ่มที่ 0 และคะแนนเรียงขึ้น (${order ?? 'จำนวนแถวไม่ใช่ 3'})`)

  const [p] = workbook.table(POLICY)
  if (!p) throw new Error(`ชีต ${POLICY}: ต้องมี 1 แถว`)
  const screeningTierMap: Record<string, RiskTierCode> = {}
  for (const pair of list(p.values.screeningTierMap)) {
    const [field, tier] = pair.split(':').map((x) => x.trim())
    if (!(SCREENING as readonly (string | undefined)[]).includes(field) || !(RISK_TIER_CODES as readonly (string | undefined)[]).includes(tier)) {
      throw new Error(`${cell(POLICY, p, 'screeningTierMap')}: "${pair}" ต้องเป็น ${SCREENING.join('/')}:${RISK_TIER_CODES.join('/')}`)
    }
    screeningTierMap[field!] = tier as RiskTierCode
  }
  const policy = {
    screeningTierMap,
    highRiskCategories: list(p.values.highRiskCategories),
    registryFlagBlocks: yesNo(cell(POLICY, p, 'registryFlagBlocks'), p.values.registryFlagBlocks),
    mediumOverdueBlocks: yesNo(cell(POLICY, p, 'mediumOverdueBlocks'), p.values.mediumOverdueBlocks),
    overrideChatButton: yesNo(cell(POLICY, p, 'overrideChatButton'), p.values.overrideChatButton),
  }

  const questions = workbook.table(QUESTIONS).map((r): RiskQuestionRow => {
    const at = (k: string) => cell(QUESTIONS, r, k)
    const code = r.values.code ?? ''
    if (!RISK_QUESTION_CODE.test(code)) throw new Error(`${at('code')}: "${code}" ต้องเป็นรูปแบบ RQ-ด้าน-เลข`)
    const domain = r.values.domain ?? null
    if (!(RISK_DOMAINS as readonly (string | null)[]).includes(domain)) throw new Error(`${at('domain')}: ต้องเป็น ${RISK_DOMAINS.join(' ')}`)
    if ((r.values.kind ?? 'SINGLE_CHOICE') !== 'SINGLE_CHOICE') throw new Error(`${at('kind')}: ต้องเป็น SINGLE_CHOICE`)
    const options = z.array(Option).min(2).safeParse(json(at('optionsJson'), r.values.optionsJson))
    if (!options.success) throw new Error(`${at('optionsJson')}: ตัวเลือกใช้ไม่ได้ (${options.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`)
    const when = r.values.appliesWhenJson ? json(at('appliesWhenJson'), r.values.appliesWhenJson) : null
    if (when !== null && (typeof when !== 'object' || Array.isArray(when))) throw new Error(`${at('appliesWhenJson')}: ต้องเป็นเงื่อนไข { field op value }`)
    if (!r.values.textTh || !r.values.textEn) throw new Error(`${at('textTh')}: ต้องมีคำถามไทยและอังกฤษ`)
    return {
      code,
      domain: domain as RiskQuestionRow['domain'],
      textTh: r.values.textTh,
      textEn: r.values.textEn,
      options: options.data,
      appliesWhen: when as Record<string, unknown> | null,
      required: yesNo(at('required'), r.values.required),
      evidenceScopeRequired: yesNo(at('evidenceScopeRequired'), r.values.evidenceScopeRequired),
      evidenceScope: r.values.evidenceScope ?? null,
      aiReadable: yesNo(at('aiReadable'), r.values.aiReadable),
      sortOrder: whole(at('sortOrder'), r.values.sortOrder),
    }
  })

  const assessments = workbook.hasSheet(ASSESSMENTS)
    ? workbook.table(ASSESSMENTS).map((r): RiskAssessmentRow => {
        const at = (k: string) => cell(ASSESSMENTS, r, k)
        const screening = json(at('screeningJson'), r.values.screeningJson) as Record<string, unknown>
        for (const k of SCREENING) if (screening[k] !== 'Y' && screening[k] !== 'N') throw new Error(`${at('screeningJson')}: ${k} ต้องเป็น Y หรือ N`)
        const status = r.values.status ?? null
        if (!(ASSESSMENT_STATUSES as readonly (string | null)[]).includes(status)) throw new Error(`${at('status')}: ต้องเป็น ${ASSESSMENT_STATUSES.join(' ')}`)
        const answers = r.values.answersJson ? (json(at('answersJson'), r.values.answersJson) as Record<string, string>) : {}
        const completedOn = r.values.completedOn ?? null
        if (completedOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(completedOn)) throw new Error(`${at('completedOn')}: ต้องเป็นวันที่ YYYY-MM-DD`)
        const done = status === 'COMPLETED'
        if (done && completedOn === null && r.values.completedDaysAgo == null) throw new Error(`${at('completedDaysAgo')}: ใบที่เสร็จต้องมี completedDaysAgo หรือ completedOn`)
        const tier = r.values.expectedTier ?? null
        if (done && !(RISK_TIER_CODES as readonly (string | null)[]).includes(tier)) throw new Error(`${at('expectedTier')}: ใบที่เสร็จต้องมีระดับที่คาด`)
        return {
          ref: r.values.ref ?? `แถว ${r.row}`,
          supplierCode: r.values.supplierCode ?? '',
          screening: screening as Screening,
          categoryCodes: list(r.values.categoryCodes),
          workScopes: list(r.values.workScopes),
          openedBy: r.values.openedBy ?? '',
          openedDaysAgo: whole(at('openedDaysAgo'), r.values.openedDaysAgo),
          answers,
          filledOnBehalf: r.values.filledOnBehalf ?? null,
          status: status as RiskAssessmentRow['status'],
          completedDaysAgo: completedOn === null && r.values.completedDaysAgo != null ? whole(at('completedDaysAgo'), r.values.completedDaysAgo) : null,
          completedOn,
          expectedPoints: done ? whole(at('expectedPoints'), r.values.expectedPoints) : null,
          expectedTier: done ? (tier as RiskTierCode) : null,
          reviewers: list(r.values.reviewers, '·'),
        }
      })
    : []

  const overrides = workbook.hasSheet(OVERRIDES)
    ? workbook.table(OVERRIDES).map((r): RiskOverrideRow => {
        const at = (k: string) => cell(OVERRIDES, r, k)
        const cap = r.values.capGross ?? ''
        if (!/^\d+(\.\d{1,2})?$/.test(cap) || Number(cap) <= 0) throw new Error(`${at('capGross')}: ต้องเป็นยอดบาทมากกว่า 0`)
        if (!r.values.reason) throw new Error(`${at('reason')}: ต้องมีเหตุผล`)
        return {
          ref: r.values.ref ?? `แถว ${r.row}`,
          supplierCode: r.values.supplierCode ?? '',
          capGross: Number(cap).toFixed(2),
          expiresDaysAhead: whole(at('expiresDaysAhead'), r.values.expiresDaysAhead, 1),
          requestedBy: r.values.requestedBy ?? '',
          requestedDaysAgo: whole(at('requestedDaysAgo'), r.values.requestedDaysAgo, 1),
          approver: r.values.approver ?? '',
          reason: r.values.reason,
        }
      })
    : []

  const admins = list(workbook.keyValues('Org').get('orgAdmins')?.value ?? null)
  if (admins.length < 2) throw new Error(`ชีต Org (orgAdmins): ต้องมีผู้ดูแลองค์กร 2 คน ให้คนที่สองยืนยันเกณฑ์และแบบประเมินความเสี่ยง (BR-RSK-02)`)
  return { tiers, policy, questions, assessments, overrides, admins: [admins[0]!, admins[1]!] }
}

/** The day YYYY-MM-DD `days` before `on`, as plain calendar arithmetic */
export function daysBefore(on: string, days: number): string {
  const d = new Date(`${on}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

/** The first day an assessment of the history opens (completedOn rows count back from that day), or null */
export function earliestAssessmentOpen(sheets: RiskSheets, today: string): string | null {
  const days = sheets.assessments.map((a) => daysBefore(a.completedOn ?? today, a.openedDaysAgo))
  return days.length ? days.sort()[0]! : null
}
