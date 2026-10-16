'use client'

import { CalendarIcon } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { enUS, th } from 'react-day-picker/locale'
import { toast } from 'sonner'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { BE_OFFSET, isoDay, monthNamesShort, partsOf } from '@/core/thai/day'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { formatDateTime } from '../format'
import { TextArea } from '../request-view/text-area'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { Calendar } from '../shadcn/calendar'
import { Input } from '../shadcn/input'
import { Label } from '../shadcn/label'
import { Popover, PopoverContent, PopoverTrigger } from '../shadcn/popover'
import { RadioGroup, RadioGroupItem } from '../shadcn/radio-group'
import { AdviceBadge, ItemResultBadge } from './badges'
import { ConfirmDialog } from './confirm-dialog'
import { dayText, money } from './present'
import { supplierName, type PayAction, type RunItemView } from './types'
import { usePayAction, usePayErrorText } from './use-pay-action'

// The results of a payment run sent to the bank (S9-09, FR-PAY-103 AC1 to AC4 AC6, BR-PAY-12 BR-PAY-13, OQ-134 to
// OQ-136, demo step 6). Every item without a result is "paid" unless the member chooses otherwise: a Radio Group per item
// (paid · failed · not now), one transfer date (a Calendar in a Popover in the Buddhist era, from the pay date to today)
// and the bank's reference for the batch, a reference of its own for an item when it differs, and the reason of a
// failure. When every item without a result is chosen and none has a reference of its own, it is "paid, all but these"
// (allPaidExcept); otherwise item by item. A result is final in phase 1, so an Alert Dialog says how many are paid and
// failed before anything is recorded. Each paid item shows its payment advice e-mail (pending, sent, failed, no e-mail)
// and FINANCE sends it again with a reason.

const REASON_MIN = 3
type Choice = 'PAID' | 'FAILED' | 'SKIP'

export interface ResultsPanelProps {
  readonly paymentRunId: string
  readonly version: number
  readonly status: string
  readonly payDate: string
  readonly today: string
  readonly items: readonly RunItemView[]
  readonly adviceEmail: boolean
  readonly may: { readonly recordResults: boolean; readonly resendAdvice: boolean }
  readonly actions: { readonly recordResults: PayAction; readonly resendAdvice: PayAction }
}

export function ResultsPanel({ paymentRunId, version, status, payDate, today, items, adviceEmail, may, actions }: ResultsPanelProps) {
  const t = useTranslations('payRun')
  const locale = useLocale() === 'en' ? 'en' : 'th'
  const errorText = usePayErrorText()
  const action = usePayAction()
  const id = useId()
  const open = items.filter((i) => i.status === 'INCLUDED')
  const recorded = items.filter((i) => i.status !== 'INCLUDED')
  const [paidOn, setPaidOn] = useState(today < payDate ? payDate : today)
  const [reference, setReference] = useState('')
  const [choices, setChoices] = useState<Readonly<Record<string, Choice>>>({})
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({})
  const [ownRefs, setOwnRefs] = useState<Readonly<Record<string, string>>>({})
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set())
  const [dateOpen, setDateOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const choiceOf = (itemId: string): Choice => choices[itemId] ?? 'PAID'
  const paid = open.filter((i) => choiceOf(i.id) === 'PAID')
  const failed = open.filter((i) => choiceOf(i.id) === 'FAILED')
  const months = monthNamesShort(locale)
  const parts = partsOf(paidOn)
  const selected = parts ? new Date(parts.year, parts.month - 1, parts.date) : undefined
  const bound = (day: string) => {
    const p = partsOf(day)!
    return new Date(p.year, p.month - 1, p.date)
  }

  function onRecord() {
    const lacking = new Set(failed.filter((i) => (reasons[i.id] ?? '').trim().length < REASON_MIN).map((i) => i.id))
    setMissing(lacking)
    if (lacking.size > 0 || paid.length + failed.length === 0) return
    action.clear()
    setConfirming(true)
  }

  async function onConfirm() {
    const everyOpen = paid.length + failed.length === open.length
    const ownRef = paid.some((i) => (ownRefs[i.id] ?? '').trim() !== '')
    const input =
      everyOpen && !ownRef
        ? { paymentRunId, version, allPaidExcept: { paidOn, bankReference: reference, failed: failed.map((i) => ({ paymentRunItemId: i.id, reason: (reasons[i.id] ?? '').trim() })) } }
        : {
            paymentRunId,
            version,
            items: [
              ...paid.map((i) => ({ paymentRunItemId: i.id, outcome: 'PAID' as const, paidOn, bankReference: (ownRefs[i.id] ?? '').trim() || reference })),
              ...failed.map((i) => ({ paymentRunItemId: i.id, outcome: 'FAILED' as const, reason: (reasons[i.id] ?? '').trim() })),
            ],
          }
    const outcome = await action.run((key) => actions.recordResults(input, key))
    if (outcome.ok) {
      setConfirming(false)
      setChoices({})
      setReasons({})
      setOwnRefs({})
      toast.success(outcome.completed ? t('results.completed') : t('results.recorded'))
    }
  }

  const failure = action.outcome && !action.outcome.ok ? errorText(action.outcome) : null
  const canRecord = may.recordResults && status === 'SENT_TO_BANK' && open.length > 0

  return (
    <section aria-labelledby="run-results-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="run-results-title" className="text-base font-semibold text-ink">
          {t('results.title')}
        </h2>
        <p className="text-ink-muted">{t('results.hint')}</p>
      </div>
      {status !== 'SENT_TO_BANK' && status !== 'COMPLETED' ? <p className="text-ink-muted">{t('results.notYet')}</p> : null}

      {canRecord ? (
        <form
          method="post"
          noValidate
          aria-labelledby={`${id}-all`}
          className="flex flex-col gap-4 rounded-md border border-line p-3"
          onSubmit={(event) => {
            event.preventDefault()
            onRecord()
          }}
        >
          <div className="flex flex-col gap-1">
            <h3 id={`${id}-all`} className="font-semibold text-ink">
              {t('results.allTitle')}
            </h3>
            <p className="text-ink-muted">{t('results.allHint')}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-date`} className="text-base font-medium text-ink">
                {t('results.paidOn')}
              </Label>
              <Popover open={dateOpen} onOpenChange={setDateOpen}>
                <PopoverTrigger asChild>
                  <Button id={`${id}-date`} variant="secondary" className="justify-start self-start font-normal">
                    <CalendarIcon aria-hidden="true" className="size-4" />
                    {dayText(locale, paidOn)}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar
                    mode="single"
                    locale={locale === 'en' ? enUS : th}
                    selected={selected}
                    defaultMonth={selected}
                    disabled={[{ before: bound(payDate) }, { after: bound(today < payDate ? payDate : today) }]}
                    onSelect={(date) => {
                      if (!date) return
                      setPaidOn(isoDay(date.getFullYear(), date.getMonth() + 1, date.getDate()))
                      setDateOpen(false)
                    }}
                    formatters={{ formatCaption: (month) => `${months[month.getMonth()]} ${month.getFullYear() + BE_OFFSET}` }}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-ref`} className="text-base font-medium text-ink">
                {t('results.bankReference')}
              </Label>
              <Input id={`${id}-ref`} value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} className="h-11 text-base" />
            </div>
          </div>

          <ul aria-label={t('results.list')} className="flex flex-col divide-y divide-line border-y border-line">
            {open.map((item) => {
              const choice = choiceOf(item.id)
              const name = `${item.supplier.code} · ${supplierName(locale, item.supplier)}`
              return (
                <li key={item.id} className="flex flex-col gap-2 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium break-words text-ink">{name}</span>
                    <span className="money text-ink">
                      {money(item.transferSatang)}
                      <span className="sr-only"> {t('unit')}</span>
                    </span>
                  </div>
                  <RadioGroup
                    value={choice}
                    onValueChange={(value) => setChoices((c) => ({ ...c, [item.id]: value as Choice }))}
                    aria-label={t('results.outcomeLabel', { supplier: name })}
                    className="flex flex-wrap gap-x-6 gap-y-1"
                  >
                    {(['PAID', 'FAILED', 'SKIP'] as const).map((value) => (
                      <div key={value} className="flex min-h-11 items-center gap-2">
                        <RadioGroupItem id={`${id}-${item.id}-${value}`} value={value} className="size-5" />
                        <Label htmlFor={`${id}-${item.id}-${value}`} className="text-base font-normal text-ink">
                          {t(`results.outcome.${value}`)}
                        </Label>
                      </div>
                    ))}
                  </RadioGroup>
                  {choice === 'PAID' ? (
                    <div className="flex max-w-sm flex-col gap-1.5">
                      <Label htmlFor={`${id}-${item.id}-ref`} className="text-base font-normal text-ink-muted">
                        {t('results.ownReference')}
                      </Label>
                      <Input
                        id={`${id}-${item.id}-ref`}
                        value={ownRefs[item.id] ?? ''}
                        maxLength={100}
                        onChange={(e) => {
                          const value = e.target.value
                          setOwnRefs((r) => ({ ...r, [item.id]: value }))
                        }}
                        className="h-11 text-base"
                      />
                    </div>
                  ) : null}
                  {choice === 'FAILED' ? (
                    <TextArea
                      id={`${id}-${item.id}-reason`}
                      name="reason"
                      label={t('results.failureReason')}
                      value={reasons[item.id] ?? ''}
                      maxLength={REASON_MAX_LENGTH}
                      onChange={(event) => {
                        const value = event.currentTarget.value
                        setReasons((r) => ({ ...r, [item.id]: value }))
                        setMissing((m) => {
                          const next = new Set(m)
                          next.delete(item.id)
                          return next
                        })
                      }}
                      error={missing.has(item.id) ? t('dialog.reasonRequired') : undefined}
                    />
                  ) : null}
                </li>
              )
            })}
          </ul>
          {failure && !confirming ? <Notice tone="danger">{failure}</Notice> : null}
          <Button type="submit" className="self-start" disabled={paid.length + failed.length === 0}>
            {t('results.record')}
          </Button>
        </form>
      ) : null}
      {may.recordResults && status === 'SENT_TO_BANK' && open.length === 0 ? <p className="text-ink-muted">{t('results.nothingLeft')}</p> : null}

      <AlertDialog open={confirming} onOpenChange={(next) => (next ? null : setConfirming(false))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold text-ink">{t('results.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription className="text-base text-ink-muted">{t('results.confirmText', { paid: paid.length, failed: failed.length })}</AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-ink">{t('results.paidOnValue', { date: dayText(locale, paidOn) })}</p>
          {failure ? <Notice tone="danger">{failure}</Notice> : null}
          <AlertDialogFooter className="gap-3">
            <AlertDialogCancel className="h-11 px-4 text-base" disabled={action.pending}>
              {t('dialog.back')}
            </AlertDialogCancel>
            <Button disabled={action.pending} aria-busy={action.pending || undefined} onClick={() => void onConfirm()}>
              {action.pending ? t('results.recording') : t('results.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {recorded.length > 0 ? (
        <ul aria-label={t('results.list')} className="flex flex-col divide-y divide-line border-y border-line">
          {recorded.map((item) => (
            <li key={item.id} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium break-words text-ink">{`${item.supplier.code} · ${supplierName(locale, item.supplier)}`}</span>
                <ItemResultBadge status={item.status} label={t(`results.itemStatus.${item.status}`)} />
              </div>
              <span className="money text-ink">
                {money(item.transferSatang)}
                <span className="sr-only"> {t('unit')}</span>
              </span>
              {item.status === 'PAID' && item.paidOn ? (
                <span className="text-ink">
                  {t('results.paid', { date: dayText(locale, item.paidOn) })}
                  {item.bankReference ? ` · ${t('results.paidRef', { ref: item.bankReference })}` : ''}
                </span>
              ) : null}
              {item.status === 'FAILED' ? <span className="break-words text-ink">{t('results.failed', { reason: item.failureReason ?? '-' })}</span> : null}
              {item.status === 'PAID' ? (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ink-muted">{t('results.advice.title')}</span>
                    {item.advice ? (
                      <AdviceBadge status={item.advice.status} label={t.has(`results.advice.${item.advice.status}` as 'results.advice.SENT') ? t(`results.advice.${item.advice.status}` as 'results.advice.SENT') : item.advice.status} />
                    ) : (
                      <span className="text-ink-muted">{adviceEmail ? t('results.advice.none') : t('results.advice.off')}</span>
                    )}
                    {item.advice?.sentAt ? <span className="text-ink-muted">{t('results.advice.sentAt', { time: formatDateTime(locale, item.advice.sentAt) })}</span> : null}
                    {item.advice && item.advice.sendings > 1 ? <span className="text-ink-muted">{t('results.advice.times', { count: item.advice.sendings })}</span> : null}
                  </div>
                  {may.resendAdvice ? (
                    <ConfirmDialog
                      trigger={t('results.resend')}
                      title={t('results.resendTitle')}
                      hint={t('results.resendHint')}
                      confirm={t('results.resendConfirm')}
                      busy={t('results.resending')}
                      done={() => t('results.resent')}
                      reason
                      run={(values, key) => actions.resendAdvice({ paymentRunItemId: item.id, reason: values.reason }, key)}
                    />
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
