'use client'

import { CircleAlert } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useState, type ReactNode } from 'react'
import { THAI_TIME_ZONE } from '@/core/thai/date'
import { BE_OFFSET, daysInMonth, formatEnglishBeDay, formatThaiDay, isoDay, monthNamesShort, partsOf } from '@/core/thai/day'

// A date field of a form sent as it is (a search, a period), in the reader's words only (§9.9: no English in a Thai
// screen; BR-DATE-01: the Buddhist-era year): the label over three lists — the day, the month by its short name, the
// year of the Buddhist era — instead of the device's own date picker, which writes its placeholder ("dd/mm/yyyy") and
// the year of the Christian era in the language of the browser, whatever the page's. The form sends the day as the
// picker did, yyyy-mm-dd of the Christian era, under the field's name (a hidden input with the field's id), or nothing
// while no day is chosen. Under the lists, the day it holds in words — "วันที่เลือก: 8 ส.ค. 2569" (FR-PLT-002 AC3). A
// day chosen in part is not sent: the field says what is missing, and the lists it lacks are required, so the form waits
// until the day is chosen in full, or — for a field that may stay empty — not at all.

export interface DateFieldProps {
  /** The id of the hidden input that carries the day; the lists take it with -day, -month and -year */
  readonly id: string
  /** The name the form sends the day under */
  readonly name: string
  readonly label: ReactNode
  /** The day it opens with, yyyy-mm-dd of the Christian era */
  readonly defaultValue?: string
  readonly hint?: string
  readonly required?: boolean
}

/** The three lists as chosen: the day (1–31), the month (1–12) and the year of the Christian era, each '' while not chosen */
export interface DateParts {
  readonly day: string
  readonly month: string
  readonly year: string
}

/** How many years back from this one the list of years goes */
const YEARS_BACK = 10

const NONE: DateParts = { day: '', month: '', year: '' }

/** The lists of a day given as yyyy-mm-dd; none chosen for anything else */
export function datePartsOf(day: string | undefined): DateParts {
  const p = day ? partsOf(day) : null
  return p ? { day: String(p.date), month: String(p.month), year: String(p.year) } : NONE
}

/**
 * One list chosen anew. A day past the end of the month now chosen becomes the month's last day ("31" with ก.พ. 2569 →
 * 28), which the words under the lists then say.
 */
export function chooseDatePart(parts: DateParts, part: keyof DateParts, value: string): DateParts {
  const next = { ...parts, [part]: value }
  if (!next.day || !next.month || !next.year) return next
  const last = daysInMonth(Number(next.year), Number(next.month))
  return Number(next.day) > last ? { ...next, day: String(last) } : next
}

/** What the lists hold: the day the form sends (yyyy-mm-dd, or '' unless all three are chosen) and whether it is chosen only in part */
export function dateOfParts(parts: DateParts): { readonly value: string; readonly partial: boolean } {
  const chosen = [parts.day, parts.month, parts.year].filter(Boolean).length
  return { value: chosen === 3 ? isoDay(Number(parts.year), Number(parts.month), Number(parts.day)) : '', partial: chosen > 0 && chosen < 3 }
}

/** The years of the list, newest first: this year by Thai time and the ten before it, with the year of the opening day if it is not among them */
export function yearsOf(thisYear: number, opening: DateParts): readonly number[] {
  const years = Array.from({ length: YEARS_BACK + 1 }, (_, i) => thisYear - i)
  const own = Number(opening.year)
  return opening.year && !years.includes(own) ? [...years, own].sort((a, b) => b - a) : years
}

/** This year of the Christian era by Thai time: the same on the server and in the reader's browser */
const thisYear = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: THAI_TIME_ZONE, year: 'numeric' }).format(new Date()))

const selectClass = 'h-11 w-full min-w-0 rounded-md border border-input bg-bg px-3 text-base text-ink aria-[invalid=true]:border-danger'

export function DateField({ id, name, label, defaultValue, hint, required = false }: DateFieldProps) {
  const t = useTranslations('app')
  const locale = useLocale() === 'en' ? 'en' : 'th'
  const [parts, setParts] = useState(() => datePartsOf(defaultValue))
  // The years are fixed when the field first draws: the server and the browser agree on them
  const [years] = useState(() => yearsOf(thisYear(), datePartsOf(defaultValue)))
  const { value, partial } = dateOfParts(parts)
  const lastDay = parts.month && parts.year ? daysInMonth(Number(parts.year), Number(parts.month)) : 31
  const said = value ? (locale === 'en' ? formatEnglishBeDay : formatThaiDay)(value) : null
  const words = [hint, said ? t('dateChosen', { date: said }) : null].filter(Boolean).join(' · ')
  const hintId = words ? `${id}-hint` : undefined
  const errorId = partial ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  // A field that may stay empty asks for all three lists once one is chosen
  const each = (part: keyof DateParts) => ({
    id: `${id}-${part}`,
    className: selectClass,
    value: parts[part],
    required: required || partial,
    'aria-label': t(`dateParts.${part}`),
    'aria-invalid': partial && !parts[part] ? true : undefined,
    'aria-describedby': describedBy,
    onChange: (event: { currentTarget: { value: string } }) => {
      const chosen = event.currentTarget.value
      setParts((now) => chooseDatePart(now, part, chosen))
    },
  })
  const months = monthNamesShort(locale)
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={describedBy}>
      <legend className="mb-1.5 font-medium text-ink">{label}</legend>
      <div className="grid grid-cols-[minmax(0,4fr)_minmax(0,5fr)_minmax(0,6fr)] gap-2">
        <select {...each('day')}>
          <option value="">{t('dateParts.day')}</option>
          {Array.from({ length: lastDay }, (_, i) => (
            <option key={i + 1} value={String(i + 1)}>
              {i + 1}
            </option>
          ))}
        </select>
        <select {...each('month')}>
          <option value="">{t('dateParts.month')}</option>
          {months.map((month, i) => (
            <option key={month} value={String(i + 1)}>
              {month}
            </option>
          ))}
        </select>
        <select {...each('year')}>
          <option value="">{t('dateParts.year')}</option>
          {years.map((year) => (
            <option key={year} value={String(year)}>
              {year + BE_OFFSET}
            </option>
          ))}
        </select>
      </div>
      <input type="hidden" id={id} name={name} value={value} />
      {words ? (
        <p id={hintId} className="text-base md:text-sm text-ink-muted">
          {words}
        </p>
      ) : null}
      {partial ? (
        <p id={errorId} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t(required ? 'dateParts.incomplete' : 'dateParts.incompleteOrNone')}</span>
        </p>
      ) : null}
    </fieldset>
  )
}
