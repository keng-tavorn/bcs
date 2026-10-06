'use client'

import { CircleAlert } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { settle } from '../admin-settings/outcome'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { grantErrorKey, type GrantErrorKey, type GrantOutcome } from './outcome'

export interface GrantInputView {
  readonly budgetLineId: string
  readonly granteeKind: 'DEPARTMENT' | 'MEMBER'
  readonly granteeDepartmentId?: string
  readonly granteeMemberId?: string
  readonly firstDay: string
  readonly lastDay: string
}

export type CreateGrantAction = (input: GrantInputView, idempotencyKey: string) => Promise<GrantOutcome>

const DAY = /^\d{4}-\d{2}-\d{2}$/

type Errors = Partial<Record<'line' | 'department' | 'member' | 'firstDay' | 'lastDay', string>>

function FieldError({ id, text }: { id: string; text?: string }) {
  if (!text) return null
  return (
    <p id={id} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  )
}

const selectClass = 'h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink aria-[invalid=true]:border-danger'

// Grant the use of a budget line to another department or to one member, for whole days (FR-BUD-004 AC1, BR-BUD-04):
// which line, to whom, from which day to which day (Thai time). The owning department is never offered. The last day
// starts at the end of the line's fiscal year and the period is repeated in words as it is chosen. A grant can be
// taken back from the list, so it needs no second confirmation; the server checks every rule again.
export function GrantForm({
  lines,
  departments,
  members,
  today,
  create,
}: {
  lines: ReadonlyArray<{ id: string; code: string; label: string; departmentId: string; fiscalYearEnds: string }>
  departments: ReadonlyArray<{ id: string; label: string; name: string }>
  members: ReadonlyArray<{ id: string; label: string; name: string }>
  today: string
  create: CreateGrantAction
}) {
  const t = useTranslations('budgets.grants')
  const locale = useLocale()
  const id = useId()
  const submission = useSubmissionKey()
  const [lineId, setLineId] = useState('')
  const [kind, setKind] = useState<'DEPARTMENT' | 'MEMBER'>('DEPARTMENT')
  const [departmentId, setDepartmentId] = useState('')
  const [memberId, setMemberId] = useState('')
  const [firstDay, setFirstDay] = useState(today)
  const [lastDay, setLastDay] = useState(today)
  const [lastDayChosen, setLastDayChosen] = useState(false)
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<Errors>({})
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const line = lines.find((l) => l.id === lineId)
  const formatDate = (day: string) => (locale === 'en' ? formatEnglishBeDate(day) : formatThaiDate(day))
  const period = DAY.test(firstDay) && DAY.test(lastDay) && lastDay >= firstDay ? t('period', { from: formatDate(firstDay), to: formatDate(lastDay) }) : null
  // The department that owns the line already uses it (OWN_DEPARTMENT)
  const offered = departments.filter((d) => d.id !== line?.departmentId)

  function chooseLine(next: string) {
    setLineId(next)
    const chosen = lines.find((l) => l.id === next)
    if (chosen && !lastDayChosen) setLastDay(chosen.fiscalYearEnds)
    if (chosen && departmentId === chosen.departmentId) setDepartmentId('')
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: Errors = {}
    if (!line) next.line = t('errors.LINE')
    if (kind === 'DEPARTMENT' && !departmentId) next.department = t('errors.DEPARTMENT')
    if (kind === 'MEMBER' && !memberId) next.member = t('errors.MEMBER')
    if (!DAY.test(firstDay)) next.firstDay = t('errors.FIRST_DAY')
    if (!DAY.test(lastDay)) next.lastDay = t('errors.LAST_DAY')
    else if (DAY.test(firstDay) && lastDay < firstDay) next.lastDay = t('errors.PERIOD')
    else if (lastDay < today) next.lastDay = t('errors.PAST_PERIOD')
    setErrors(next)
    setResult(null)
    if (Object.keys(next).length || !line) return
    setPending(true)
    const input: GrantInputView = { budgetLineId: line.id, granteeKind: kind, ...(kind === 'DEPARTMENT' ? { granteeDepartmentId: departmentId } : { granteeMemberId: memberId }), firstDay, lastDay }
    const outcome = await settle(create(input, submission.key))
    setPending(false)
    // No answer: the same key goes with a retry, so the grant is made at most once
    if (!outcome) return setResult({ tone: 'danger', text: t('errors.FAILED') })
    submission.next()
    if (outcome.ok) {
      const grantee = kind === 'DEPARTMENT' ? (departments.find((d) => d.id === departmentId)?.name ?? '') : (members.find((m) => m.id === memberId)?.name ?? '')
      setResult({ tone: 'success', text: t('created', { line: line.code, grantee, period: period ?? '' }) })
      setLineId('')
      setDepartmentId('')
      setMemberId('')
      setFirstDay(today)
      setLastDay(today)
      setLastDayChosen(false)
      return
    }
    const key: GrantErrorKey = grantErrorKey(outcome)
    const text = t(`errors.${key}`, { requestId: outcome.requestId ?? '-' })
    if (key === 'LINE' || key === 'LINE_CLOSED') return setErrors({ line: text })
    if (key === 'DEPARTMENT' || key === 'OWN_DEPARTMENT') return setErrors(kind === 'DEPARTMENT' ? { department: text } : { member: t('errors.MEMBER') })
    if (key === 'MEMBER') return setErrors({ member: text })
    if (key === 'FIRST_DAY') return setErrors({ firstDay: text })
    if (key === 'LAST_DAY' || key === 'PERIOD' || key === 'PAST_PERIOD') return setErrors({ lastDay: text })
    setResult({ tone: 'danger', text })
  }

  if (lines.length === 0) return <Notice tone="info">{t('noLines')}</Notice>

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-line`} className="font-medium text-ink">
          {t('line')}
        </label>
        <select
          id={`${id}-line`}
          value={lineId}
          onChange={(event) => chooseLine(event.currentTarget.value)}
          aria-invalid={errors.line ? true : undefined}
          aria-describedby={errors.line ? `${id}-line-error` : undefined}
          className={selectClass}
        >
          <option value="">{t('chooseLine')}</option>
          {lines.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <FieldError id={`${id}-line-error`} text={errors.line} />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 font-medium text-ink">{t('granteeKind')}</legend>
        <label className="flex min-h-11 items-start gap-3">
          <input type="radio" name="kind" value="DEPARTMENT" checked={kind === 'DEPARTMENT'} onChange={() => setKind('DEPARTMENT')} className="mt-1 size-5 shrink-0" />
          <span className="flex flex-col">
            <span>{t('kindDepartment')}</span>
            <span className="text-base text-ink-muted md:text-sm">{t('kindDepartmentHint')}</span>
          </span>
        </label>
        <label className="flex min-h-11 items-center gap-3">
          <input type="radio" name="kind" value="MEMBER" checked={kind === 'MEMBER'} onChange={() => setKind('MEMBER')} className="size-5 shrink-0" />
          <span>{t('kindMember')}</span>
        </label>
      </fieldset>

      {kind === 'DEPARTMENT' ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-department`} className="font-medium text-ink">
            {t('department')}
          </label>
          <select
            id={`${id}-department`}
            value={departmentId}
            onChange={(event) => setDepartmentId(event.currentTarget.value)}
            aria-invalid={errors.department ? true : undefined}
            aria-describedby={errors.department ? `${id}-department-error` : undefined}
            className={selectClass}
          >
            <option value="">{t('chooseDepartment')}</option>
            {offered.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <FieldError id={`${id}-department-error`} text={errors.department} />
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-member`} className="font-medium text-ink">
            {t('member')}
          </label>
          <select
            id={`${id}-member`}
            value={memberId}
            onChange={(event) => setMemberId(event.currentTarget.value)}
            aria-invalid={errors.member ? true : undefined}
            aria-describedby={errors.member ? `${id}-member-error` : undefined}
            className={selectClass}
          >
            <option value="">{t('chooseMember')}</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <FieldError id={`${id}-member-error`} text={errors.member} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field id={`${id}-first`} type="date" value={firstDay} onChange={(event) => setFirstDay(event.currentTarget.value)} label={t('firstDay')} error={errors.firstDay} />
        <Field
          id={`${id}-last`}
          type="date"
          min={DAY.test(firstDay) ? firstDay : today}
          value={lastDay}
          onChange={(event) => {
            setLastDay(event.currentTarget.value)
            setLastDayChosen(true)
          }}
          label={t('lastDay')}
          error={errors.lastDay}
        />
      </div>
      <div className="flex flex-col gap-0.5 text-base md:text-sm" aria-live="polite">
        <p className="text-ink-muted">{t('lastDayHint')}</p>
        {period ? <p className="font-medium">{t('periodPreview', { period })}</p> : null}
      </div>

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
