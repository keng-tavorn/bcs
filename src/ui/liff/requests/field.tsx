'use client'

import { useTranslations } from 'next-intl'
import type { FieldDef } from '@/core/forms/fields'
import { formatEnglishBeDay, formatThaiDay } from '@/core/thai/day'
import type { ScreenLocale } from '../../request-form/types'
import { checkboxClass, describedBy, inputClass, textareaClass } from './classes'
import { LiffFieldError, LiffLabelled } from './labelled'

// The questions of a request type on the LIFF form (spec §7.9, FR-INT-002): the same field definitions, labels in the
// reader's language, required words and hints as the workspace's src/ui/request-form/field-input.tsx, drawn with the
// LIFF building blocks — an error is an icon and words (NoticeIcon, never colour alone, NFR-A11Y-03) — so the first
// screen of the LIFF form stays within its JavaScript budget (§9.4: 200 KB gzip with the LINE SDK): the workspace's field
// brings lucide, its notice and the Thai date library along. A select with a few options is a row of radio buttons, so
// a yes/no screening question is one tap (BR-FORM-05); a date also reads with its Buddhist-era year (FR-PLT-002 AC3).

const RADIO_MAX_OPTIONS = 3

export function fieldLabelOf(def: FieldDef, locale: ScreenLocale): string {
  return def.label?.[locale] ?? def.label?.th ?? def.id
}

const optionLabelOf = (def: FieldDef, option: string, locale: ScreenLocale) => def.optionLabels?.[option]?.[locale] ?? def.optionLabels?.[option]?.th ?? option
const text = (v: unknown) => (typeof v === 'string' ? v : '')

export function LiffField({
  def,
  value,
  onChange,
  locale,
  error,
}: {
  readonly def: FieldDef
  readonly value: unknown
  readonly onChange: (value: unknown) => void
  readonly locale: ScreenLocale
  readonly error?: string | undefined
}) {
  const t = useTranslations('requestForm.fields')
  const id = `field-${def.id}`
  const label = fieldLabelOf(def, locale)
  const required = def.required ? t('required') : undefined
  let hint = def.help?.[locale] ?? def.help?.th
  if (def.type === 'money') hint ??= t('moneyHint')
  const day = def.type === 'date' ? (locale === 'en' ? formatEnglishBeDay : formatThaiDay)(text(value)) : null
  // The device's date picker, and the day with its Buddhist-era year in the workspace's words
  if (day) hint = [hint, t('dateChosen', { date: day })].filter(Boolean).join(' · ')
  const frame = { id, label, requiredText: required, hint, error }
  const aria = { 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy(id, Boolean(hint), Boolean(error)), 'aria-required': def.required ? true : undefined }
  const options = def.options ?? []

  if (def.type === 'text' || def.type === 'number' || def.type === 'money' || def.type === 'date' || def.type === 'textarea') {
    const numeric = def.type === 'number' || def.type === 'money'
    const common = { id, name: def.id, value: text(value), required: def.required, ...aria }
    return (
      <LiffLabelled {...frame}>
        {def.type === 'textarea' ? (
          <textarea {...common} className={textareaClass} maxLength={def.maxLength} onChange={(e) => onChange(e.currentTarget.value)} />
        ) : (
          <input
            {...common}
            type={def.type === 'date' ? 'date' : 'text'}
            className={numeric ? `${inputClass} tabular text-right` : inputClass}
            inputMode={numeric ? 'decimal' : undefined}
            maxLength={def.type === 'text' ? def.maxLength : undefined}
            onChange={(e) => onChange(e.currentTarget.value)}
          />
        )}
      </LiffLabelled>
    )
  }
  if (def.type === 'select' && options.length > RADIO_MAX_OPTIONS) {
    return (
      <LiffLabelled {...frame}>
        <select id={id} name={def.id} className={inputClass} value={text(value)} required={def.required} onChange={(e) => onChange(e.currentTarget.value)} {...aria}>
          <option value="">{t('choose')}</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {optionLabelOf(def, o, locale)}
            </option>
          ))}
        </select>
      </LiffLabelled>
    )
  }
  if (def.type === 'select' || def.type === 'multiselect') {
    const many = def.type === 'multiselect'
    const chosen = many && Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === 'string') : []
    return (
      <LiffLabelled {...frame} group>
        {options.map((o) => (
          <label key={o} className="flex min-h-11 items-center gap-3">
            <input
              type={many ? 'checkbox' : 'radio'}
              name={def.id}
              value={o}
              className={checkboxClass}
              checked={many ? chosen.includes(o) : value === o}
              required={!many && def.required}
              onChange={(e) => onChange(many ? (e.currentTarget.checked ? [...chosen, o] : chosen.filter((c) => c !== o)) : o)}
            />
            <span>{optionLabelOf(def, o, locale)}</span>
          </label>
        ))}
      </LiffLabelled>
    )
  }
  if (def.type === 'checkbox') {
    return (
      <div className="flex flex-col gap-1.5">
        <label className="flex min-h-11 items-center gap-3">
          <input id={id} type="checkbox" name={def.id} className={checkboxClass} checked={value === true} onChange={(e) => onChange(e.currentTarget.checked)} {...aria} />
          <span className="font-medium">
            {label}
            {required ? <span className="ml-1.5 font-normal text-ink-muted">({required})</span> : null}
          </span>
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-ink-muted">
            {hint}
          </p>
        ) : null}
        {error ? <LiffFieldError id={id}>{error}</LiffFieldError> : null}
      </div>
    )
  }
  // Reference fields (member, supplier, …) are filled from the context in later stages (BR-FORM-02, S4)
  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-medium">{label}</p>
      <p className="text-ink-muted">{t('unsupported')}</p>
    </div>
  )
}
