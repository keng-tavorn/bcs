'use client'

import { useLocale, useTranslations } from 'next-intl'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { nameIn, type Named } from '../admin-org/names'
import {
  MONEY_VARIABLES,
  PAYEE_TYPES,
  RISK_DOMAIN_CODES,
  RISK_TIERS,
  SCREENING_FIELDS,
  VARIABLES,
  conditionDraftOf,
  isListOp,
  takesValue,
  type ConditionRow,
  type ConditionValue,
  type Mode,
  type ReviewerValue,
  type RuleScope,
} from './model'

// Words for the workflow screens in the reader's language (§9.9 rule 6: money with thousands separators and two
// decimals): request types, condition rows, reviewers, how many must pass and the time under the SLA. Names are data:
// English when the screen is in English and the name has one, Thai otherwise. S11-06: a RISK_ASSESSMENT rule's
// condition reads the fields of a supplier risk assessment (screening answers, tiers, categories, payee type) in words
// of their own, never a request form's labels, and the parts of the assessment its reviewer sees.

/** The fields of a risk assessment by the key of their words (adminWorkflow.riskFields) */
const RISK_FIELD_KEYS = {
  processesPersonalData: 'processesPersonalData',
  accessesSystems: 'accessesSystems',
  accessesPremises: 'accessesPremises',
  $tier: 'tier',
  $inherentTier: 'inherentTier',
  $category: 'category',
  $payeeType: 'payeeType',
} as const
const riskFieldKey = (field: string) => (Object.hasOwn(RISK_FIELD_KEYS, field) ? RISK_FIELD_KEYS[field as keyof typeof RISK_FIELD_KEYS] : null)
const isOneOf = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value)

export interface FormFieldOption {
  readonly value: string
  readonly labelTh: string | null
  readonly labelEn: string | null
}

export interface FormField {
  readonly id: string
  readonly type: string
  readonly labelTh: string | null
  readonly labelEn: string | null
  readonly options: readonly FormFieldOption[]
}

export interface RequestTypeOption extends Named {
  readonly code: string
  readonly fields: readonly FormField[]
}

export interface PositionOption extends Named {
  readonly code: string
  readonly scope: 'DEPARTMENT' | 'ORG'
}

export interface DepartmentOption extends Named {
  readonly id: string
  readonly code: string
  readonly depth: number
}

export interface MemberOption extends Named {
  readonly id: string
  readonly active: boolean
  readonly primaryDepartmentId: string | null
}

export interface WorkflowContext {
  readonly requestTypes: readonly RequestTypeOption[]
  readonly positions: readonly PositionOption[]
  readonly departments: readonly DepartmentOption[]
  readonly members: readonly MemberOption[]
}

const MINUTES_PER_HOUR = 60

/** The form fields of the given request types (every field once), for the condition builder */
export function fieldsOfTypes(context: WorkflowContext, typeCodes: readonly string[]): FormField[] {
  const seen = new Map<string, FormField>()
  for (const type of context.requestTypes.filter((t) => typeCodes.includes(t.code))) for (const f of type.fields) if (!seen.has(f.id)) seen.set(f.id, f)
  return [...seen.values()]
}

export function useWorkflowWords(context: WorkflowContext) {
  const t = useTranslations('adminWorkflow')
  const locale = useLocale()
  const named = (n: Named) => nameIn(locale, n)
  const formField = (id: string): FormField | undefined => {
    for (const type of context.requestTypes) {
      const f = type.fields.find((x) => x.id === id)
      if (f) return f
    }
    return undefined
  }
  const labelOf = (x: { labelTh: string | null; labelEn: string | null }, fallback: string) => (locale === 'en' && x.labelEn ? x.labelEn : (x.labelTh ?? x.labelEn ?? fallback))

  const versionName = (code: string, versionNo: number) => t('versionName', { code, version: versionNo })
  const requestType = (code: string) => {
    const type = context.requestTypes.find((x) => x.code === code)
    return type ? named(type) : code
  }
  const field = (id: string) => {
    if (VARIABLES.includes(id)) return t(`variables.${id.slice(1) as 'amountGross' | 'amountNet' | 'requestType' | 'lineCategories' | 'budgetAccountCodes'}`)
    const f = formField(id)
    if (f) return labelOf(f, id)
    // A risk variable named where it does not belong (a lint error) is still said in words
    const risk = riskFieldKey(id)
    return risk ? t(`riskFields.${risk}`) : id
  }
  const optionText = (fieldId: string, value: string) => {
    if (fieldId === '$requestType') return requestType(value)
    const option = formField(fieldId)?.options.find((o) => o.value === value)
    return option ? labelOf(option, value) : value
  }
  /** A field of a risk assessment (BR-RSK-07) */
  const riskField = (id: string) => {
    const key = riskFieldKey(id)
    return key ? t(`riskFields.${key}`) : field(id)
  }
  const tier = (code: string) => (isOneOf(RISK_TIERS, code) ? t(`tiers.${code}`) : code)
  const payeeType = (code: string) => (isOneOf(PAYEE_TYPES, code) ? t(`payeeTypes.${code}`) : code)
  const yesNo = (value: string) => (value === 'Y' || value === 'N' ? t(`yesNo.${value}`) : value)
  /** A value of a risk assessment's field: an answer, a tier, a payee type; a category code as it is */
  const riskValue = (fieldId: string, value: string) => {
    if (isOneOf(SCREENING_FIELDS, fieldId)) return yesNo(value)
    if (fieldId === '$tier' || fieldId === '$inherentTier') return tier(value)
    if (fieldId === '$payeeType') return payeeType(value)
    return value
  }
  const domain = (code: string) => (isOneOf(RISK_DOMAIN_CODES, code) ? t(`riskDomains.${code}`) : code)
  /** The parts a rule's reviewer sees, in the order of RISK_DOMAIN_CODES */
  const domains = (codes: readonly string[]) => (codes.length ? [...RISK_DOMAIN_CODES.filter((d) => codes.includes(d)), ...codes.filter((c) => !isOneOf(RISK_DOMAIN_CODES, c))].map(domain).join(', ') : t('noDomains'))
  const scope = (s: RuleScope) => t(`scopes.${s}`)
  const money = (baht: string) => {
    try {
      return t('baht', { amount: formatSatang(amountToSatang(baht.replace(/,/g, ''))) })
    } catch {
      return baht
    }
  }
  const rowText = (row: ConditionRow, ruleScope: RuleScope = 'REQUEST') => {
    const risk = ruleScope === 'RISK_ASSESSMENT'
    const name = risk ? riskField(row.field) : field(row.field)
    const op = row.op ? t(`ops.${row.op}`) : ''
    if (!row.op || !takesValue(row.op)) return t('rowText', { field: name, op, value: '' }).trim()
    const valueOf = (v: string) => (risk ? riskValue(row.field, v) : optionText(row.field, v))
    const value = isListOp(row.op) ? row.values.map(valueOf).join(', ') : !risk && MONEY_VARIABLES.includes(row.field) ? money(row.value) : valueOf(row.value)
    return t('rowText', { field: name, op, value })
  }
  const condition = (when: ConditionValue, ruleScope: RuleScope = 'REQUEST') => {
    const draft = conditionDraftOf(when)
    if (draft.nested) return t('conditionNested')
    if (draft.rows.length === 0) return ruleScope === 'RISK_ASSESSMENT' ? t('risk.conditionAlways') : t('conditionAlways')
    return draft.rows.map((row) => rowText(row, ruleScope)).join(draft.join === 'any' ? t('joinAnyWord') : t('joinAllWord'))
  }
  const position = (code: string) => {
    const p = context.positions.find((x) => x.code === code)
    return p ? `${named(p)} (${code})` : code
  }
  const department = (code: string) => {
    const d = context.departments.find((x) => x.code === code)
    return d ? `${named(d)} (${code})` : code
  }
  const member = (id: string) => {
    const m = context.members.find((x) => x.id === id)
    return m ? named(m) : t('unknownMember')
  }
  const reviewer = (r: ReviewerValue) => (r.kind === 'MEMBER' ? t('reviewerMember', { name: member(r.memberId) }) : t('reviewerPosition', { position: position(r.position), department: department(r.department) }))
  const mode = (m: Mode, quorumCount: number | null, reviewers: number) => (m === 'COUNT' ? t('modeText.COUNT', { count: quorumCount ?? reviewers, total: reviewers }) : t(`modeText.${m}`))
  const sla = (minutes: number) => (minutes % MINUTES_PER_HOUR === 0 ? t('slaHours', { hours: minutes / MINUTES_PER_HOUR }) : t('slaMinutes', { minutes }))
  return { t, locale, versionName, requestType, field, optionText, money, rowText, condition, position, department, member, reviewer, mode, sla, formField, riskField, riskValue, tier, payeeType, yesNo, domain, domains, scope }
}

export type WorkflowWords = ReturnType<typeof useWorkflowWords>
