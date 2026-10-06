'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { DelegationInputView } from '../../delegation/delegation-form'
import { delegationErrorKey, type DelegationOutcome } from '../../delegation/outcome'
import { LiffActionBar } from '../action-bar'
import { Button } from '../button'
import { LiffContent } from '../content'
import { LiffNotice } from '../notice'
import { FieldError, LiffField, LiffRadio, describedBy } from '../receiving/fields'
import { useSessionReady } from '../receiving/session-ready'
import { useLiffSubmissionKey } from '../submission-key'
import { formatDay } from './day'
import { DELEGATION_REVOKED_EVENT } from './revoke'

// Naming an acting approver in the LINE app (/liff/delegation, §9.4 "ตั้งรักษาการ", FR-DOA-006 AC2 LIFF part, BR-DLG-01
// to BR-DLG-03, demo scene 11): the same form, rules and words as the workspace's src/ui/delegation/delegation-form.tsx —
// who, from which day to which day (whole days in Thai time, from today on, repeated in words as they are chosen), for
// every kind of approval task or some, up to a cap or without one, and why — and the same service on the server
// (createDelegationForDays on channel LIFF), which checks every rule again. Built for a phone in LINE: 16 px text, 44 px
// fields, and the button that sets it in the bar at the bottom of the screen (§9.4, §9.9 "ปุ่มหลักติดล่างจอ"), with what
// happened beside it; the first field that needs fixing gets the focus once its error shows. Lean on purpose (no icon
// library, no uuid): its JavaScript counts in the page's 200 KB gzip with the LINE SDK (§9.4). The page's lists come in
// through `before` and `after`, rendered by the server.

export type LiffCreateDelegation = (input: DelegationInputView, idempotencyKey: string) => Promise<DelegationOutcome>

const DAY = /^\d{4}-\d{2}-\d{2}$/
const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/
/** Zero baht written any way; money stays text here (no floating point) */
const ZERO = /^0+(\.0{1,2})?$/
const REASON_MIN = 3
/** As long as the web form lets a reason be (src/ui/delegation/delegation-form.tsx); the service takes up to REASON_MAX_LENGTH */
const REASON_MAX = 500

type Field = 'delegate' | 'firstDay' | 'lastDay' | 'types' | 'maxAmount' | 'reason'
type Errors = Partial<Record<Field, string>>

export interface LiffDelegationFormProps {
  readonly candidates: ReadonlyArray<{ readonly id: string; readonly label: string; readonly name: string }>
  readonly documentTypes: ReadonlyArray<{ readonly value: string; readonly label: string }>
  /** Today in the organization's time zone (YYYY-MM-DD), the first day the form offers */
  readonly today: string
  /** Changes whenever the member's delegations change (one was set or cancelled) */
  readonly givenKey: string
  readonly create: LiffCreateDelegation
  /** Above the form: the introduction and the delegations the member set (rendered by the server) */
  readonly before: ReactNode
  /** Below the form: where the member acts for someone else */
  readonly after: ReactNode
}

export function LiffDelegationForm({ candidates, documentTypes, today, givenKey, create, before, after }: LiffDelegationFormProps) {
  const t = useTranslations('delegation')
  const tLiff = useTranslations('liffDelegation')
  const locale = useLocale()
  const id = useId()
  const formId = `${id}-form`
  const formRef = useRef<HTMLFormElement>(null)
  const submission = useLiffSubmissionKey()
  // Both days start at today, so the period always reads in words below the dates
  const [firstDay, setFirstDay] = useState(today)
  const [lastDay, setLastDay] = useState(today)
  const [coverage, setCoverage] = useState<'ALL' | 'SOME'>('ALL')
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<Errors>({})
  const [result, setResult] = useState<{ readonly tone: 'success' | 'danger'; readonly text: string } | null>(null)
  // A refusal such as "these days overlap…" was about the list as it was: once a delegation is set or cancelled it may
  // no longer hold, so it goes (a success message stays)
  const [seenGivenKey, setSeenGivenKey] = useState(givenKey)
  if (seenGivenKey !== givenKey) {
    setSeenGivenKey(givenKey)
    if (result?.tone === 'danger') setResult(null)
  }
  // A delegation cancelled in the list below: what the bar said about the last one set no longer holds
  useEffect(() => {
    const clear = () => setResult(null)
    window.addEventListener(DELEGATION_REVOKED_EVENT, clear)
    return () => window.removeEventListener(DELEGATION_REVOKED_EVENT, clear)
  }, [])
  const sessionEnded = useCallback(() => setResult({ tone: 'danger', text: tLiff('sessionEnded') }), [tLiff])
  const ready = useSessionReady(sessionEnded)
  /** The field that gets the focus once its error is on the screen */
  const focusNext = useRef<Field | null>(null)
  // The first field to fix gets the focus after its error rendered, so a screen reader reads it with the field
  // (aria-invalid and aria-describedby are in place by then)
  useEffect(() => {
    const first = focusNext.current
    if (!first) return
    focusNext.current = null
    const target = first === 'types' ? formRef.current?.querySelector<HTMLInputElement>('input[name="documentTypes"]') : document.getElementById(`${id}-${first}`)
    target?.focus()
  }, [errors, id])

  const from = formatDay(firstDay, locale)
  const to = formatDay(lastDay, locale)
  const period = from && to && lastDay >= firstDay ? t('period', { from, to }) : null

  /** Every kind or some: what was said about the kinds no longer holds */
  function chooseCoverage(next: 'ALL' | 'SOME') {
    setCoverage(next)
    setErrors((e) => ({ ...e, types: undefined }))
  }

  /** Shows the errors and moves to the first field that needs fixing */
  function showErrors(next: Errors) {
    setErrors(next)
    const first = (['delegate', 'firstDay', 'lastDay', 'types', 'maxAmount', 'reason'] as const).find((f) => next[f])
    if (!first) return
    setResult({ tone: 'danger', text: tLiff('fixAbove') })
    focusNext.current = first
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const form = new FormData(event.currentTarget)
    const delegateMemberId = String(form.get('delegateMemberId') ?? '')
    const types = coverage === 'ALL' ? [] : form.getAll('documentTypes').map(String)
    const maxAmount = String(form.get('maxAmount') ?? '').replace(/[\s,]/g, '')
    const reason = String(form.get('reason') ?? '').trim()
    const next: Errors = {}
    if (!delegateMemberId) next.delegate = t('errors.DELEGATE')
    if (!DAY.test(firstDay) || !from) next.firstDay = t('errors.FIRST_DAY')
    else if (firstDay < today) next.firstDay = t('errors.PAST_FIRST_DAY')
    if (!DAY.test(lastDay) || !to) next.lastDay = t('errors.LAST_DAY')
    else if (DAY.test(firstDay) && lastDay < firstDay) next.lastDay = t('errors.INVALID_PERIOD')
    if (coverage === 'SOME' && types.length === 0) next.types = t('errors.TYPES')
    if (maxAmount && !AMOUNT.test(maxAmount)) next.maxAmount = t('errors.AMOUNT')
    else if (maxAmount && ZERO.test(maxAmount)) next.maxAmount = t('errors.INVALID_AMOUNT')
    if (reason.length < REASON_MIN) next.reason = t('errors.REASON')
    setResult(null)
    if (Object.keys(next).length) return showErrors(next)
    setErrors({})
    // The button says the delegation is being set from the tap: renewing the session may take a moment
    setPending(true)
    if (!(await ready())) return setPending(false)
    let outcome: DelegationOutcome | null
    try {
      outcome = await create({ delegateMemberId, firstDay, lastDay, documentTypes: types, maxAmount, reason }, submission.key)
    } catch {
      // No answer: the same key goes with a retry, so the delegation is set at most once (spec §4.3)
      outcome = null
    }
    setPending(false)
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
    if (key === 'DELEGATE' || key === 'SELF_DELEGATION' || key === 'DELEGATE_NOT_ACTIVE') return showErrors({ delegate: text })
    if (key === 'FIRST_DAY' || key === 'PAST_FIRST_DAY') return showErrors({ firstDay: text })
    if (key === 'LAST_DAY' || key === 'INVALID_PERIOD') return showErrors({ lastDay: text })
    if (key === 'AMOUNT' || key === 'INVALID_AMOUNT') return showErrors({ maxAmount: text })
    if (key === 'REASON') return showErrors({ reason: text })
    if (key === 'UNAUTHENTICATED') return sessionEnded()
    setResult({ tone: 'danger', text })
  }

  const selectError = errors.delegate
  return (
    <>
      <LiffContent>
        {before}
        <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4 border-t border-line pt-5">
          <h2 id={`${id}-title`} className="text-lg font-semibold">
            {t('formTitle')}
          </h2>
          {/* A new entry starts: the bar's message was about the last one */}
          <form id={formId} ref={formRef} onSubmit={onSubmit} onChange={() => setResult(null)} noValidate className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-delegate`} className="font-medium text-ink">
                {t('delegate')}
              </label>
              <select
                id={`${id}-delegate`}
                name="delegateMemberId"
                defaultValue=""
                aria-invalid={selectError ? true : undefined}
                aria-describedby={describedBy(`${id}-delegate`, null, selectError)}
                onChange={() => setErrors((e) => ({ ...e, delegate: undefined }))}
                className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink aria-[invalid=true]:border-danger"
              >
                <option value="">{t('chooseDelegate')}</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <FieldError id={`${id}-delegate-error`} text={selectError} />
            </div>

            <LiffField
              id={`${id}-firstDay`}
              name="firstDay"
              type="date"
              min={today}
              value={firstDay}
              onChange={(event) => {
                setFirstDay(event.currentTarget.value)
                setErrors((e) => ({ ...e, firstDay: undefined, lastDay: undefined }))
              }}
              label={t('firstDay')}
              error={errors.firstDay}
            />
            <LiffField
              id={`${id}-lastDay`}
              name="lastDay"
              type="date"
              min={DAY.test(firstDay) ? firstDay : today}
              value={lastDay}
              onChange={(event) => {
                setLastDay(event.currentTarget.value)
                setErrors((e) => ({ ...e, lastDay: undefined }))
              }}
              label={t('lastDay')}
              error={errors.lastDay}
            />
            <div className="flex flex-col gap-0.5" aria-live="polite">
              <p className="text-ink-muted">{t('periodHint')}</p>
              {period ? <p className="font-medium">{t('periodPreview', { period })}</p> : null}
            </div>

            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1.5 font-medium text-ink">{t('coverage')}</legend>
              <label className="flex min-h-11 items-start gap-3">
                <input type="radio" name="coverage" value="ALL" checked={coverage === 'ALL'} onChange={() => chooseCoverage('ALL')} className="mt-1 size-5 shrink-0 accent-[var(--primary)]" />
                <span className="flex flex-col">
                  <span>{t('coverageAll')}</span>
                  <span className="text-ink-muted">{t('coverageAllHint')}</span>
                </span>
              </label>
              <LiffRadio name="coverage" value="SOME" checked={coverage === 'SOME'} onChange={() => chooseCoverage('SOME')} label={t('coverageSome')} />
              {coverage === 'SOME' ? (
                <div className="flex flex-col pl-8">
                  {documentTypes.map((d) => (
                    <label key={d.value} className="flex min-h-11 items-center gap-3">
                      {/* Each box carries the error: the first one gets the focus when none is ticked */}
                      <input
                        type="checkbox"
                        name="documentTypes"
                        value={d.value}
                        aria-describedby={errors.types ? `${id}-types-error` : undefined}
                        onChange={() => setErrors((e) => ({ ...e, types: undefined }))}
                        className="size-5 shrink-0 accent-[var(--primary)]"
                      />
                      <span>{d.label}</span>
                    </label>
                  ))}
                </div>
              ) : null}
              <FieldError id={`${id}-types-error`} text={errors.types} />
            </fieldset>

            <LiffField
              id={`${id}-maxAmount`}
              name="maxAmount"
              inputMode="decimal"
              autoComplete="off"
              label={t('maxAmount')}
              hint={t('maxAmountHint')}
              error={errors.maxAmount}
              onChange={() => setErrors((e) => ({ ...e, maxAmount: undefined }))}
              className="money"
            />
            <LiffField
              id={`${id}-reason`}
              name="reason"
              maxLength={REASON_MAX}
              autoComplete="off"
              label={t('reason')}
              error={errors.reason}
              onChange={() => setErrors((e) => ({ ...e, reason: undefined }))}
            />
          </form>
        </section>
        {after}
      </LiffContent>
      <LiffActionBar label={tLiff('barLabel')}>
        {result ? <LiffNotice tone={result.tone}>{result.text}</LiffNotice> : null}
        <Button type="submit" form={formId} className="w-full" disabled={pending}>
          {pending ? t('submitting') : t('submit')}
        </Button>
      </LiffActionBar>
    </>
  )
}
