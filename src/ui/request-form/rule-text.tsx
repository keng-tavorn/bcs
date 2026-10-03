'use client'

import { CircleAlert, CircleCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { evaluateCondition, type Condition, type FormInput, type Requirement } from '@/core/forms'
import type { FieldDef } from '@/core/forms/fields'
import { fieldLabel, optionLabel } from './field-input'
import { showMoney } from './money'
import type { ScreenLocale } from './types'

// The attachment rules of a form in words (FR-INT-005 AC1, BR-FORM-03): why a rule applies now (its condition) and what it
// asks for (kinds of file and how many, fields to fill, either/or). Rules are data, so the sentence is built from them;
// amounts written in a rule are shown as money, field names and answers in the reader's language.

const MONEY_VARIABLES = new Set(['$amountGross', '$amountNet'])

type T = ReturnType<typeof useTranslations<'requestForm.rules'>>

function subjectOf(field: string, fields: readonly FieldDef[], locale: ScreenLocale, t: T): string {
  if (field === '$amountGross') return t('amountGross')
  if (field === '$amountNet') return t('amountNet')
  if (field === '$requestType') return t('requestType')
  const def = fields.find((f) => f.id === field)
  return def ? fieldLabel(def, locale) : field
}

function valueOf(field: string, value: unknown, fields: readonly FieldDef[], locale: ScreenLocale, t: T): string {
  if (MONEY_VARIABLES.has(field) && typeof value === 'string' && /^\d+(\.\d{1,2})?$/.test(value)) return t('baht', { amount: showMoney(value) })
  const def = fields.find((f) => f.id === field)
  const one = (v: unknown) => (def && typeof v === 'string' ? optionLabel(def, v, locale) : String(v))
  return Array.isArray(value) ? value.map(one).join(t('orJoin')) : one(value)
}

/** A condition in words: "ยอดรวม VAT มากกว่า 100,000.00 บาท" */
export function conditionText(condition: Condition, fields: readonly FieldDef[], locale: ScreenLocale, t: T): string {
  if ('all' in condition) return condition.all.length === 0 ? t('always') : condition.all.map((c) => conditionText(c, fields, locale, t)).join(t('andJoin'))
  if ('any' in condition) return condition.any.map((c) => conditionText(c, fields, locale, t)).join(t('orJoin'))
  const subject = subjectOf(condition.field, fields, locale, t)
  const value = valueOf(condition.field, condition.value, fields, locale, t)
  return t(`op.${condition.op}`, { subject, value })
}

function Status({ met, t, quiet }: { met: boolean; t: T; quiet?: boolean }) {
  // Once the rule is met, a branch it no longer needs is not shown as missing
  if (!met && quiet) return null
  return met ? (
    <span className="inline-flex items-center gap-1 text-primary">
      <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
      {t('met')}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-danger">
      <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
      {t('missing')}
    </span>
  )
}

/**
 * What a rule asks for, as a list; either/or and all-of read as words, each part with its own status. `ruleMet`: the
 * whole rule is met, so parts of an alternative it does not need are not marked missing.
 */
export function RequirementList({
  requirement,
  input,
  fields,
  locale,
  kindLabel,
  ruleMet = false,
}: {
  requirement: Requirement
  input: FormInput
  fields: readonly FieldDef[]
  locale: ScreenLocale
  kindLabel: (kind: string) => string
  ruleMet?: boolean
}) {
  const t = useTranslations('requestForm.rules')
  if ('attachments' in requirement) {
    const have = input.attachments[requirement.attachments] ?? 0
    return (
      <p className="flex flex-wrap items-center gap-x-2">
        <span>{t('files', { kind: kindLabel(requirement.attachments), min: requirement.min, have })}</span>
        <Status met={have >= requirement.min} t={t} quiet={ruleMet} />
      </p>
    )
  }
  if ('all' in requirement || 'any' in requirement) {
    const parts = 'all' in requirement ? requirement.all : requirement.any
    return (
      <div className="flex flex-col gap-1">
        <p>{'all' in requirement ? t('allOf') : t('anyOf')}</p>
        <ul className="ml-5 flex list-disc flex-col gap-1">
          {parts.map((part, i) => (
            <li key={i}>
              <RequirementList requirement={part} input={input} fields={fields} locale={locale} kindLabel={kindLabel} ruleMet={ruleMet} />
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2">
      <span>{conditionText(requirement, fields, locale, t)}</span>
      <Status met={evaluateCondition(requirement, input)} t={t} quiet={ruleMet} />
    </p>
  )
}
