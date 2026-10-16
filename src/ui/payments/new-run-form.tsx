'use client'

import { CalendarIcon } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { enUS, th } from 'react-day-picker/locale'
import { BE_OFFSET, isoDay, monthNamesShort, partsOf } from '@/core/thai/day'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { Calendar } from '../shadcn/calendar'
import { Label } from '../shadcn/label'
import { Popover, PopoverContent, PopoverTrigger } from '../shadcn/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../shadcn/select'
import type { PayAction } from './types'
import { usePayAction, usePayErrorText } from './use-pay-action'

// "เตรียมรอบจ่าย" (S9-09, FR-PAY-101 AC1, demo step 1): the payer account (a Select of the company's accounts in force,
// masked) and the pay date (a Calendar in a Popover, shown in the Buddhist era), both filled with what the system
// proposes. Choosing another day asks the server again what a run on that day would take — the page's address carries
// the day (a GET) — and the form then makes the draft with those documents and opens the run. A day that cannot be used
// is said under the field by the server's page; a refusal of the command is said next to the button.

export interface PayerOption {
  readonly id: string
  readonly label: string
}

export function NewRunForm({ payers, payDate, payDateText, create }: { payers: readonly PayerOption[]; payDate: string; payDateText: string; create: PayAction }) {
  const t = useTranslations('payRun.new')
  const locale = useLocale() === 'en' ? 'en' : 'th'
  const router = useRouter()
  const errorText = usePayErrorText()
  const action = usePayAction()
  const hydrated = useHydrated()
  const id = useId()
  // the first account in force by its code, as proposePaymentRun lists them (CB-01 in the demo)
  const [payer, setPayer] = useState(payers[0]?.id ?? '')
  const [payerError, setPayerError] = useState(false)
  const [dateOpen, setDateOpen] = useState(false)
  const [added, setAdded] = useState<{ runId: string; why: string } | null>(null)

  const months = monthNamesShort(locale)
  const parts = partsOf(payDate)
  const selected = parts ? new Date(parts.year, parts.month - 1, parts.date) : undefined

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!payer) return setPayerError(true)
    setPayerError(false)
    setAdded(null)
    const outcome = await action.run((key) => create({ payerBankAccountId: payer, payDate }, key))
    if (!outcome.ok || !outcome.paymentRunId) return
    if (outcome.addFailure) return setAdded({ runId: outcome.paymentRunId, why: errorText(outcome.addFailure) })
    router.push(`/finance/payments/${outcome.paymentRunId}`)
  }

  return (
    <form method="post" noValidate className="flex flex-col gap-5" aria-label={t('title')} onSubmit={(event) => void onSubmit(event)}>
      <div className="flex max-w-md flex-col gap-1.5">
        <Label htmlFor={`${id}-payer`} className="text-base font-medium text-ink">
          {t('payer')}
        </Label>
        <p id={`${id}-payer-hint`} className="text-base text-ink-muted md:text-sm">
          {t('payerHint')}
        </p>
        <Select
          value={payer}
          onValueChange={(value) => {
            setPayer(value)
            setPayerError(false)
          }}
        >
          <SelectTrigger
            id={`${id}-payer`}
            className="h-11 w-full text-base"
            aria-describedby={payerError ? `${id}-payer-hint ${id}-payer-error` : `${id}-payer-hint`}
            aria-invalid={payerError || undefined}
          >
            <SelectValue placeholder={t('payerPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {payers.map((p) => (
              <SelectItem key={p.id} value={p.id} className="min-h-11 text-base">
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {payerError ? (
          <p id={`${id}-payer-error`} className="text-base text-danger md:text-sm">
            {t('choosePayer')}
          </p>
        ) : null}
      </div>

      <div className="flex max-w-md flex-col gap-1.5">
        <Label htmlFor={`${id}-date`} className="text-base font-medium text-ink">
          {t('payDate')}
        </Label>
        <p id={`${id}-date-hint`} className="text-base text-ink-muted md:text-sm">
          {t('payDateHint')}
        </p>
        <Popover open={dateOpen} onOpenChange={setDateOpen}>
          <PopoverTrigger asChild>
            <Button id={`${id}-date`} variant="secondary" className="justify-start self-start font-normal" aria-describedby={`${id}-date-hint`} disabled={!hydrated}>
              <CalendarIcon aria-hidden="true" className="size-4" />
              {payDateText}
              <span className="sr-only">{t('pickDate')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0">
            <Calendar
              mode="single"
              locale={locale === 'en' ? enUS : th}
              selected={selected}
              defaultMonth={selected}
              onSelect={(date) => {
                if (!date) return
                setDateOpen(false)
                const day = isoDay(date.getFullYear(), date.getMonth() + 1, date.getDate())
                // the proposal of that day comes from the server: the address carries it
                router.replace(`/finance/payments/new?payDate=${day}`, { scroll: false })
              }}
              formatters={{ formatCaption: (month) => `${months[month.getMonth()]} ${month.getFullYear() + BE_OFFSET}` }}
            />
          </PopoverContent>
        </Popover>
      </div>

      <Button type="submit" className="self-start" disabled={action.pending || !hydrated || payers.length === 0} aria-busy={action.pending || undefined}>
        {action.pending ? t('submitting') : t('submit')}
      </Button>
      {action.outcome && !action.outcome.ok ? <Notice tone="danger">{errorText(action.outcome)}</Notice> : null}
      {added ? (
        <Notice tone="warning">
          <p>{t('addFailed', { why: added.why })}</p>
          <Link href={`/finance/payments/${added.runId}`} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
            {t('openDraft')}
          </Link>
        </Notice>
      ) : null}
    </form>
  )
}
