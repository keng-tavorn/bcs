'use client'

import { CircleAlert } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { formatEnglishBeDay, formatThaiDay } from '@/core/thai/day'
import { DateField } from '../form/date-field'

// The period of the audit search (FR-VIS-004 AC1): "ตั้งแต่วันที่" and "ถึงวันที่", each a day picked as day, month and
// Buddhist-era year (DateField), sent by the search form as it is (GET). A period that ends before it starts holds no
// event, so it is never searched (§9.9 rules 7 and 8: no "nothing found" for a search that could find nothing): the
// form is held before it goes, and the field "ถึงวันที่" says — icon and words, in the danger colour of a field's error —
// which day comes before which and how to fix it, and takes the focus; its three lists are marked invalid and described
// by those words (DateField's errorId), as a field with an error is. The page says the same for an address that carries
// such a period (`reversed`, checked on the server), and shows no results until it is fixed. Changing either day takes
// the words away; the search checks again.

export interface AuditPeriodProps {
  readonly fromLabel: ReactNode
  readonly toLabel: ReactNode
  /** The days the search was made with, yyyy-mm-dd, or '' */
  readonly from: string
  readonly to: string
  /** The address carries a period that ends before it starts: the server did not search it */
  readonly reversed: boolean
}

const FROM_ID = 'audit-from'
const TO_ID = 'audit-to'
const ERROR_ID = 'audit-period-error'

export function AuditPeriod({ fromLabel, toLabel, from, to, reversed }: AuditPeriodProps) {
  const t = useTranslations('audit.search')
  const locale = useLocale() === 'en' ? 'en' : 'th'
  const box = useRef<HTMLDivElement>(null)
  /** The period the error speaks of: the address's, or the one the form was about to send */
  const [wrong, setWrong] = useState<{ from: string; to: string } | null>(reversed ? { from, to } : null)

  useEffect(() => {
    const form = box.current?.closest('form')
    if (!form) return
    const hold = (event: SubmitEvent) => {
      const data = new FormData(form)
      const start = String(data.get('from') ?? '')
      const end = String(data.get('to') ?? '')
      // days of the form yyyy-mm-dd compare as text
      if (!start || !end || start <= end) return
      event.preventDefault()
      setWrong({ from: start, to: end })
      document.getElementById(`${TO_ID}-day`)?.focus()
    }
    form.addEventListener('submit', hold)
    return () => form.removeEventListener('submit', hold)
  }, [])

  const day = (value: string) => (locale === 'en' ? formatEnglishBeDay(value) : formatThaiDay(value)) ?? value

  return (
    // The two fields stay cells of the form's grid; a change to either day takes the error away until the next search
    <div ref={box} className="contents" onChange={() => setWrong(null)}>
      <DateField id={FROM_ID} name="from" label={fromLabel} defaultValue={from} />
      <div className="flex min-w-0 flex-col gap-1.5">
        <DateField id={TO_ID} name="to" label={toLabel} defaultValue={to} errorId={wrong ? ERROR_ID : undefined} />
        {wrong ? (
          <p id={ERROR_ID} role="alert" className="flex items-start gap-1.5 text-base text-danger md:text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{t('periodReversed', { from: day(wrong.from), to: day(wrong.to) })}</span>
          </p>
        ) : null}
      </div>
    </div>
  )
}
