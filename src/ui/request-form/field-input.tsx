'use client'

import { useTranslations } from 'next-intl'
import type { FieldDef } from '@/core/forms/fields'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { Notice } from '../form/notice'
import { checkboxClass, Choices, describedBy, FieldError, Hint, inputClass, Labelled, textareaClass } from './controls'
import { plainMoney } from './money'
import { MoneyInput } from './money-input'
import type { ScreenLocale } from './types'

// One field of a request type's form (spec §7.9, FR-INT-002). Labels, hints and option names are data in the reader's
// language (FieldDef.label/help/optionLabels, FR-ADM-005); the words around them come from messages. A select with
// a few options shows them all as radio buttons, so a yes/no screening question is one tap (BR-FORM-05). A date shows
// its Buddhist-era form under the device's date picker, and an amount of money reads grouped by thousands with two
// decimals once it is typed (FR-PLT-002 AC3).

const RADIO_MAX_OPTIONS = 3
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** "2027-10-31" → "31 ต.ค. 2570" / "31 Oct 2570" */
export function showDay(day: string, locale: ScreenLocale): string {
  return locale === 'en' ? formatEnglishBeDate(day) : formatThaiDate(day)
}

export function fieldLabel(def: FieldDef, locale: ScreenLocale): string {
  return def.label?.[locale] ?? def.label?.th ?? def.id
}

export function optionLabel(def: FieldDef, option: string, locale: ScreenLocale): string {
  return def.optionLabels?.[option]?.[locale] ?? def.optionLabels?.[option]?.th ?? option
}

const text = (v: unknown) => (typeof v === 'string' ? v : '')

export function FieldInput({
  def,
  value,
  onChange,
  locale,
  error,
}: {
  def: FieldDef
  value: unknown
  onChange: (value: unknown) => void
  locale: ScreenLocale
  error?: string
}) {
  const t = useTranslations('requestForm.fields')
  const id = `field-${def.id}`
  const label = fieldLabel(def, locale)
  // A money question without a hint of its own gets the form's, tied to its input as any hint is
  const hint = def.help?.[locale] ?? def.help?.th ?? (def.type === 'money' ? t('moneyHint') : undefined)
  const required = def.required ? t('required') : undefined
  const aria = { 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy(id, Boolean(hint), Boolean(error)), 'aria-required': def.required ? true : undefined }

  switch (def.type) {
    case 'text':
      return (
        <Labelled id={id} label={label} requiredText={required} hint={hint} error={error}>
          <input id={id} name={def.id} className={inputClass} value={text(value)} maxLength={def.maxLength} required={def.required} onChange={(e) => onChange(e.currentTarget.value)} {...aria} />
        </Labelled>
      )
    case 'textarea':
      return (
        <Labelled id={id} label={label} requiredText={required} hint={hint} error={error}>
          <textarea id={id} name={def.id} className={textareaClass} value={text(value)} maxLength={def.maxLength} required={def.required} onChange={(e) => onChange(e.currentTarget.value)} {...aria} />
        </Labelled>
      )
    case 'number':
      return (
        <Labelled id={id} label={label} requiredText={required} hint={hint} error={error}>
          <input id={id} name={def.id} className={`${inputClass} tabular text-right`} inputMode="decimal" value={text(value)} required={def.required} onChange={(e) => onChange(e.currentTarget.value)} {...aria} />
        </Labelled>
      )
    case 'money':
      // §9.9 rule 6: grouped by thousands with two decimals once left, the raw digits while edited; the answer kept and
      // saved is the plain digits the server takes (MONEY_TEXT), separators typed or not
      return (
        <Labelled id={id} label={label} requiredText={required} hint={hint} error={error}>
          <MoneyInput id={id} name={def.id} className={`${inputClass} tabular text-right`} value={text(value)} required={def.required} onChange={(e) => onChange(plainMoney(e.currentTarget.value))} {...aria} />
        </Labelled>
      )
    case 'date': {
      const day = text(value)
      const chosen = DAY.test(day) ? t('dateChosen', { date: showDay(day, locale) }) : null
      const dateHint = [hint, chosen].filter(Boolean).join(' · ') || undefined
      return (
        <Labelled id={id} label={label} requiredText={required} hint={dateHint} error={error}>
          <input id={id} name={def.id} type="date" className={inputClass} value={day} required={def.required} onChange={(e) => onChange(e.currentTarget.value)} {...aria} aria-describedby={describedBy(id, Boolean(dateHint), Boolean(error))} />
        </Labelled>
      )
    }
    case 'select': {
      const options = def.options ?? []
      if (options.length <= RADIO_MAX_OPTIONS) {
        return (
          <Choices id={id} legend={label} requiredText={required} hint={hint} error={error}>
            {options.map((o) => (
              <label key={o} className="flex min-h-11 items-center gap-3">
                <input type="radio" name={def.id} value={o} className={checkboxClass} checked={value === o} required={def.required} onChange={() => onChange(o)} />
                <span>{optionLabel(def, o, locale)}</span>
              </label>
            ))}
          </Choices>
        )
      }
      return (
        <Labelled id={id} label={label} requiredText={required} hint={hint} error={error}>
          <select id={id} name={def.id} className={inputClass} value={text(value)} required={def.required} onChange={(e) => onChange(e.currentTarget.value)} {...aria}>
            <option value="">{t('choose')}</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {optionLabel(def, o, locale)}
              </option>
            ))}
          </select>
        </Labelled>
      )
    }
    case 'multiselect': {
      const chosen = Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === 'string') : []
      return (
        <Choices id={id} legend={label} requiredText={required} hint={hint} error={error}>
          {(def.options ?? []).map((o) => (
            <label key={o} className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                name={def.id}
                value={o}
                className={checkboxClass}
                checked={chosen.includes(o)}
                onChange={(e) => onChange(e.currentTarget.checked ? [...chosen, o] : chosen.filter((c) => c !== o))}
              />
              <span>{optionLabel(def, o, locale)}</span>
            </label>
          ))}
        </Choices>
      )
    }
    case 'checkbox':
      return (
        <div className="flex flex-col gap-1.5">
          <label className="flex min-h-11 items-center gap-3">
            <input id={id} type="checkbox" name={def.id} className={checkboxClass} checked={value === true} onChange={(e) => onChange(e.currentTarget.checked)} {...aria} />
            <span className="font-medium">
              {label}
              {required ? <span className="ml-1.5 font-normal text-ink-muted">({required})</span> : null}
            </span>
          </label>
          {hint ? <Hint id={id}>{hint}</Hint> : null}
          {error ? <FieldError id={id}>{error}</FieldError> : null}
        </div>
      )
    default:
      // Reference fields (member, supplier, …) are filled from the context in later stages (BR-FORM-02, S4)
      return (
        <div className="flex flex-col gap-1.5">
          <p className="font-medium">{label}</p>
          <Notice tone="info">{t('unsupported')}</Notice>
        </div>
      )
  }
}
