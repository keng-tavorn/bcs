'use client'

import { CircleAlert } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useRef, useState, type FormEvent } from 'react'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { settle } from '../admin-settings/outcome'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { delegationErrorKey, type DelegationOutcome } from './outcome'

export interface DelegationInputView {
  readonly delegateMemberId: string
  readonly firstDay: string
  readonly lastDay: string
  /** Empty = every kind of approval task */
  readonly documentTypes: string[]
  readonly maxAmount: string
  readonly reason: string
}

export type CreateDelegationAction = (input: DelegationInputView, idempotencyKey: string) => Promise<DelegationOutcome>

const DAY = /^\d{4}-\d{2}-\d{2}$/
const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/
/** Zero baht written any way; money stays text here (no floating point) */
const ZERO = /^0+(\.0{1,2})?$/

type Errors = Partial<Record<'delegate' | 'firstDay' | 'lastDay' | 'types' | 'maxAmount' | 'reason', string>>

function FieldError({ id, text }: { id: string; text?: string }) {
  if (!text) return null
  return (
    <p id={id} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  )
}

// Name an acting approver for whole days (NEW-06, FR-DOA-006 AC2 web, BR-DLG-01..03): who, from which day to which day
// (Thai time, from today on), for every kind of approval task or some, up to a cap or without one, and why. The period
// is repeated in words as the dates are chosen. The server checks every rule again (createDelegation).
export function DelegationForm({
  candidates,
  documentTypes,
  today,
  givenKey,
  create,
}: {
  candidates: ReadonlyArray<{ id: string; label: string; name: string }>
  documentTypes: ReadonlyArray<{ value: string; label: string }>
  today: string
  /** Changes whenever the list of delegations the member set changes (one was set or cancelled) */
  givenKey: string
  create: CreateDelegationAction
}) {
  const t = useTranslations('delegation')
  const locale = useLocale()
  const id = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const submission = useSubmissionKey()
  // Both days start at today, so the period always reads in words below the dates (never a bare date pattern)
  const [firstDay, setFirstDay] = useState(today)
  const [lastDay, setLastDay] = useState(today)
  const [coverage, setCoverage] = useState<'ALL' | 'SOME'>('ALL')
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<Errors>({})
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  // A refusal such as "these days overlap…" was about the list as it was: once a delegation is set or cancelled it may
  // no longer hold, so it goes (a success message stays)
  const [seenGivenKey, setSeenGivenKey] = useState(givenKey)
  if (seenGivenKey !== givenKey) {
    setSeenGivenKey(givenKey)
    if (result?.tone === 'danger') setResult(null)
  }
  const formatDate = (day: string) => (locale === 'en' ? formatEnglishBeDate(day) : formatThaiDate(day))
  const period = DAY.test(firstDay) && DAY.test(lastDay) && lastDay >= firstDay ? t('period', { from: formatDate(firstDay), to: formatDate(lastDay) }) : null

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const delegateMemberId = String(form.get('delegateMemberId') ?? '')
    const types = coverage === 'ALL' ? [] : form.getAll('documentTypes').map(String)
    const maxAmount = String(form.get('maxAmount') ?? '').replace(/[\s,]/g, '')
    const reason = String(form.get('reason') ?? '').trim()
    const next: Errors = {}
    if (!delegateMemberId) next.delegate = t('errors.DELEGATE')
    if (!DAY.test(firstDay)) next.firstDay = t('errors.FIRST_DAY')
    else if (firstDay < today) next.firstDay = t('errors.PAST_FIRST_DAY')
    if (!DAY.test(lastDay)) next.lastDay = t('errors.LAST_DAY')
    else if (DAY.test(firstDay) && lastDay < firstDay) next.lastDay = t('errors.INVALID_PERIOD')
    if (coverage === 'SOME' && types.length === 0) next.types = t('errors.TYPES')
    if (maxAmount && !AMOUNT.test(maxAmount)) next.maxAmount = t('errors.AMOUNT')
    else if (maxAmount && ZERO.test(maxAmount)) next.maxAmount = t('errors.INVALID_AMOUNT')
    if (reason.length < 3) next.reason = t('errors.REASON')
    setErrors(next)
    setResult(null)
    if (Object.keys(next).length) return
    setPending(true)
    const outcome = await settle(create({ delegateMemberId, firstDay, lastDay, documentTypes: types, maxAmount, reason }, submission.key))
    setPending(false)
    // No answer: the same key goes with a retry, so the delegation is set at most once
    if (!outcome) return setResult({ tone: 'danger', text: t('errors.FAILED') })
    submission.next()
    if (outcome.ok) {
      const name = candidates.find((c) => c.id === delegateMemberId)?.name ?? ''
      setResult({ tone: 'success', text: t('created', { name, period: period ?? '' }) })
      formRef.current?.reset()
      setFirstDay(today)
      setLastDay(today)
      setCoverage('ALL')
      return
    }
    const key = delegationErrorKey(outcome)
    const text = t(`errors.${key}`, { requestId: outcome.requestId ?? '-' })
    if (key === 'DELEGATE' || key === 'SELF_DELEGATION' || key === 'DELEGATE_NOT_ACTIVE') return setErrors({ delegate: text })
    if (key === 'FIRST_DAY' || key === 'PAST_FIRST_DAY') return setErrors({ firstDay: text })
    if (key === 'LAST_DAY' || key === 'INVALID_PERIOD') return setErrors({ lastDay: text })
    if (key === 'AMOUNT' || key === 'INVALID_AMOUNT') return setErrors({ maxAmount: text })
    if (key === 'REASON') return setErrors({ reason: text })
    setResult({ tone: 'danger', text })
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-delegate`} className="font-medium text-ink">
          {t('delegate')}
        </label>
        <select
          id={`${id}-delegate`}
          name="delegateMemberId"
          defaultValue=""
          aria-invalid={errors.delegate ? true : undefined}
          aria-describedby={errors.delegate ? `${id}-delegate-error` : undefined}
          className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink aria-[invalid=true]:border-danger"
        >
          <option value="">{t('chooseDelegate')}</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <FieldError id={`${id}-delegate-error`} text={errors.delegate} />
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field
          id={`${id}-first`}
          name="firstDay"
          type="date"
          min={today}
          value={firstDay}
          onChange={(event) => setFirstDay(event.currentTarget.value)}
          label={t('firstDay')}
          error={errors.firstDay}
        />
        <Field
          id={`${id}-last`}
          name="lastDay"
          type="date"
          min={DAY.test(firstDay) ? firstDay : today}
          value={lastDay}
          onChange={(event) => setLastDay(event.currentTarget.value)}
          label={t('lastDay')}
          error={errors.lastDay}
        />
      </div>
      <div className="flex flex-col gap-0.5 text-base md:text-sm" aria-live="polite">
        <p className="text-ink-muted">{t('periodHint')}</p>
        {period ? <p className="font-medium">{t('periodPreview', { period })}</p> : null}
      </div>

      <fieldset className="flex flex-col gap-2" aria-describedby={errors.types ? `${id}-types-error` : undefined}>
        <legend className="mb-1.5 font-medium text-ink">{t('coverage')}</legend>
        <label className="flex min-h-11 items-start gap-3">
          <input type="radio" name="coverage" value="ALL" checked={coverage === 'ALL'} onChange={() => setCoverage('ALL')} className="mt-1 size-5 shrink-0" />
          <span className="flex flex-col">
            <span>{t('coverageAll')}</span>
            <span className="text-base text-ink-muted md:text-sm">{t('coverageAllHint')}</span>
          </span>
        </label>
        <label className="flex min-h-11 items-center gap-3">
          <input type="radio" name="coverage" value="SOME" checked={coverage === 'SOME'} onChange={() => setCoverage('SOME')} className="size-5 shrink-0" />
          <span>{t('coverageSome')}</span>
        </label>
        {coverage === 'SOME' ? (
          <div className="grid grid-cols-1 gap-x-4 gap-y-1 pl-8 sm:grid-cols-2">
            {documentTypes.map((d) => (
              <label key={d.value} className="flex min-h-11 items-center gap-3">
                <input type="checkbox" name="documentTypes" value={d.value} className="size-5 shrink-0" />
                <span>{d.label}</span>
              </label>
            ))}
          </div>
        ) : null}
        <FieldError id={`${id}-types-error`} text={errors.types} />
      </fieldset>

      <Field id={`${id}-amount`} name="maxAmount" inputMode="decimal" autoComplete="off" label={t('maxAmount')} hint={t('maxAmountHint')} error={errors.maxAmount} className="money" />
      <Field id={`${id}-reason`} name="reason" maxLength={500} autoComplete="off" required label={t('reason')} error={errors.reason} />

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
