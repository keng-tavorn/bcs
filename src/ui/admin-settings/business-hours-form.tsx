'use client'

import { CircleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { commonErrorKey, settle, type SettingsOutcome } from './outcome'

export const CALENDAR_WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const
export type CalendarWeekday = (typeof CALENDAR_WEEKDAYS)[number]

export type SaveBusinessHoursAction = (input: { workdays: string[]; start: string; end: string }, idempotencyKey: string) => Promise<SettingsOutcome>

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

type Errors = { workdays?: string; start?: string; end?: string }

// Business days and hours of settings.businessCalendar (FR-ADM-003 AC1, BR-SLA-01): seven tick boxes and two times in
// Thai time. The server checks again (OrgSettingsSchema); its refusal is shown next to the field it names.
export function BusinessHoursForm({
  initial,
  timezone,
  save,
}: {
  initial: { workdays: readonly string[]; start: string; end: string }
  timezone: string
  save: SaveBusinessHoursAction
}) {
  const t = useTranslations('adminSettings.calendar')
  const tCommon = useTranslations('adminSettings')
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<Errors>({})
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const workdays = form.getAll('workdays').map(String)
    const start = String(form.get('start') ?? '')
    const end = String(form.get('end') ?? '')
    const next: Errors = {}
    if (workdays.length === 0) next.workdays = t('errors.NO_WORKDAY')
    if (!TIME.test(start)) next.start = t('errors.TIME')
    if (!TIME.test(end)) next.end = t('errors.TIME')
    else if (TIME.test(start) && end <= start) next.end = t('errors.END_BEFORE_START')
    setErrors(next)
    setResult(null)
    if (next.workdays || next.start || next.end) return
    setPending(true)
    const outcome = await settle(save({ workdays, start, end }, submission.key))
    setPending(false)
    // No answer: the same key goes with a retry (the save runs at most once)
    if (!outcome) return setResult({ tone: 'danger', text: tCommon('errors.FAILED') })
    submission.next()
    if (outcome.ok) return setResult({ tone: 'success', text: t('saved') })
    const field = outcome.code === 'VALIDATION_FAILED' ? (outcome.field ?? '') : ''
    if (field.endsWith('.workdays') || field.includes('.workdays.')) return setErrors({ workdays: t('errors.NO_WORKDAY') })
    if (field.endsWith('.end')) return setErrors({ end: t('errors.END_BEFORE_START') })
    if (field.endsWith('.start')) return setErrors({ start: t('errors.TIME') })
    setResult({ tone: 'danger', text: tCommon(`errors.${commonErrorKey(outcome)}`, { requestId: outcome.requestId ?? '-' }) })
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}
      <fieldset className="flex flex-col gap-2" aria-describedby={errors.workdays ? 'hours-workdays-error' : undefined}>
        <legend className="mb-1.5 font-medium text-ink">{t('workdays')}</legend>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
          {CALENDAR_WEEKDAYS.map((day) => (
            <label key={day} className="flex min-h-11 items-center gap-3">
              <input type="checkbox" name="workdays" value={day} defaultChecked={initial.workdays.includes(day)} className="size-5 accent-[var(--primary)]" />
              <span>{t(`weekdays.${day}`)}</span>
            </label>
          ))}
        </div>
        {errors.workdays ? (
          <p id="hours-workdays-error" className="flex items-start gap-1.5 text-base text-danger md:text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{errors.workdays}</span>
          </p>
        ) : null}
      </fieldset>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field id="hours-start" name="start" type="time" required defaultValue={initial.start} label={t('start')} error={errors.start} />
        <Field id="hours-end" name="end" type="time" required defaultValue={initial.end} label={t('end')} error={errors.end} />
      </div>
      <p className="text-base text-ink-muted md:text-sm">{t('timeHint', { timezone })}</p>
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? t('saving') : t('save')}
      </Button>
    </form>
  )
}
