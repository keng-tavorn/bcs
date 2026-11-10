'use client'

import { CalendarIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { enUS, th } from 'react-day-picker/locale'
import { BE_OFFSET, formatEnglishBeDay, formatThaiDay, isoDay, monthNamesShort, partsOf } from '@/core/thai/day'
import { RISK_OVERRIDE_REASON_MAX, RISK_OVERRIDE_REASON_MIN } from '@/lib/constants'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import type { RiskAdminOutcome } from '../risk-admin/model'
import { useFailureText, useRun } from '../risk-admin/run'
import { useSay } from '../risk-admin/say'
import { Calendar } from '../shadcn/calendar'
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { Popover, PopoverContent, PopoverTrigger } from '../shadcn/popover'
import { Textarea } from '../shadcn/textarea'

// The form of a risk override (S11-08 · BR-RSK-10 · FR-RSK-203 AC2 AC3): why (at least 20 characters), the cap with VAT
// that every PO let out under it counts against (OQ-224: cumulative), and its last day — a Calendar in a Popover in the
// Buddhist era that offers only today to today + overrideMaxDays. A new one is kept as a draft and opens its page, where
// it is sent; a draft or a returned one is edited in place. The command checks every term again (and the day against
// the send day when it is sent).

export interface OverrideFormValues {
  readonly reason: string
  readonly capGross: string
  readonly expiresOn: string
}

export type OverrideSave = (values: OverrideFormValues, key: string) => Promise<RiskAdminOutcome>

const BAHT = /^\d{1,13}(\.\d{1,2})?$/

export function OverrideForm({ initial, today, lastAllowed, save, after }: { initial: OverrideFormValues; today: string; lastAllowed: string; save: OverrideSave; after: 'OPEN' | 'REFRESH' }) {
  const t = useSay('risk.override.form')
  const failureText = useFailureText()
  const locale = useLocale() === 'en' ? 'en' : 'th'
  const router = useRouter()
  const working = useRun()
  const hydrated = useHydrated()
  const id = useId()
  const [reason, setReason] = useState(initial.reason)
  const [cap, setCap] = useState(initial.capGross)
  const [expiresOn, setExpiresOn] = useState(initial.expiresOn)
  const [dateOpen, setDateOpen] = useState(false)
  const [errors, setErrors] = useState<{ reason?: string; cap?: string; date?: string }>({})
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  const months = monthNamesShort(locale)
  const parts = expiresOn ? partsOf(expiresOn) : null
  const selected = parts ? new Date(parts.year, parts.month - 1, parts.date) : undefined
  const first = partsOf(today)!
  const last = partsOf(lastAllowed)!
  const words = (d: string) => (locale === 'en' ? formatEnglishBeDay(d) : formatThaiDay(d)) ?? d
  const dayText = expiresOn ? words(expiresOn) : t('pickDate')

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const found: typeof errors = {}
    if (reason.trim().length < RISK_OVERRIDE_REASON_MIN) found.reason = t('reasonShort', { min: RISK_OVERRIDE_REASON_MIN })
    if (!BAHT.test(cap.trim()) || Number(cap) <= 0) found.cap = t('capInvalid')
    if (!expiresOn) found.date = t('dateRequired')
    setErrors(found)
    if (Object.keys(found).length) return
    setMessage(null)
    const outcome = await working.run((key) => save({ reason: reason.trim(), capGross: cap.trim(), expiresOn }, key))
    if (!outcome.ok) return setMessage({ tone: 'danger', text: failureText(outcome) })
    if (after === 'OPEN' && outcome.id) return router.push(`/risk/overrides/${outcome.id}`)
    setMessage({ tone: 'success', text: t('saved') })
  }

  return (
    <form method="post" noValidate className="flex flex-col gap-5" aria-label={t('label')} onSubmit={(event) => void onSubmit(event)}>
      <div className="flex max-w-2xl flex-col gap-1.5">
        <Label htmlFor={`${id}-reason`} className="text-base font-medium text-ink">
          {t('reason')}
        </Label>
        <p id={`${id}-reason-hint`} className="text-base text-ink-muted md:text-sm">
          {t('reasonHint', { min: RISK_OVERRIDE_REASON_MIN })}
        </p>
        <Textarea
          id={`${id}-reason`}
          value={reason}
          maxLength={RISK_OVERRIDE_REASON_MAX}
          rows={4}
          className="text-base"
          aria-describedby={errors.reason ? `${id}-reason-hint ${id}-reason-error` : `${id}-reason-hint`}
          aria-invalid={errors.reason ? true : undefined}
          onChange={(e) => setReason(e.target.value)}
        />
        {errors.reason ? (
          <p id={`${id}-reason-error`} className="text-base text-danger md:text-sm">
            {errors.reason}
          </p>
        ) : null}
      </div>

      <div className="flex max-w-md flex-col gap-1.5">
        <Label htmlFor={`${id}-cap`} className="text-base font-medium text-ink">
          {t('cap')}
        </Label>
        <p id={`${id}-cap-hint`} className="text-base text-ink-muted md:text-sm">
          {t('capHint')}
        </p>
        <Input
          id={`${id}-cap`}
          inputMode="decimal"
          autoComplete="off"
          value={cap}
          className="h-11 text-base tabular-nums"
          aria-describedby={errors.cap ? `${id}-cap-hint ${id}-cap-error` : `${id}-cap-hint`}
          aria-invalid={errors.cap ? true : undefined}
          onChange={(e) => setCap(e.target.value)}
        />
        {errors.cap ? (
          <p id={`${id}-cap-error`} className="text-base text-danger md:text-sm">
            {errors.cap}
          </p>
        ) : null}
      </div>

      <div className="flex max-w-md flex-col gap-1.5">
        <Label htmlFor={`${id}-date`} className="text-base font-medium text-ink">
          {t('expiresOn')}
        </Label>
        <p id={`${id}-date-hint`} className="text-base text-ink-muted md:text-sm">
          {t('expiresOnHint', { last: words(lastAllowed) })}
        </p>
        <Popover open={dateOpen} onOpenChange={setDateOpen}>
          <PopoverTrigger asChild>
            <Button
              id={`${id}-date`}
              variant="secondary"
              className="justify-start self-start font-normal"
              aria-describedby={errors.date ? `${id}-date-hint ${id}-date-error` : `${id}-date-hint`}
              aria-invalid={errors.date ? true : undefined}
              disabled={!hydrated}
            >
              <CalendarIcon aria-hidden="true" className="size-4" />
              {dayText}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0">
            <Calendar
              mode="single"
              locale={locale === 'en' ? enUS : th}
              selected={selected}
              defaultMonth={selected ?? new Date(first.year, first.month - 1, first.date)}
              disabled={[{ before: new Date(first.year, first.month - 1, first.date) }, { after: new Date(last.year, last.month - 1, last.date) }]}
              onSelect={(date) => {
                if (!date) return
                setDateOpen(false)
                setExpiresOn(isoDay(date.getFullYear(), date.getMonth() + 1, date.getDate()))
              }}
              formatters={{ formatCaption: (month) => `${months[month.getMonth()]} ${month.getFullYear() + BE_OFFSET}` }}
            />
          </PopoverContent>
        </Popover>
        {errors.date ? (
          <p id={`${id}-date-error`} className="text-base text-danger md:text-sm">
            {errors.date}
          </p>
        ) : null}
      </div>

      <Button type="submit" className="self-start" disabled={working.pending || !hydrated} aria-busy={working.pending || undefined}>
        {working.pending ? t('saving') : after === 'OPEN' ? t('create') : t('save')}
      </Button>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
    </form>
  )
}
