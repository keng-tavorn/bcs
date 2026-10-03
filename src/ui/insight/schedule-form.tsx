'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { scheduleErrorKey, type ScheduleOutcome } from './outcome'

// Setting a report to be e-mailed on a schedule (FR-VIS-002 AC1, report.schedule for FINANCE and EXECUTIVE): which
// report, how often (the cadences the screen offers, at 08:00 in the organization's time zone), the file's format and
// who receives it — members who may read the whole organization's reports themselves. Four questions, one form; the
// answer says in the button's words what was set. The service checks the capability, the report, the cadence and the
// recipients again; the key makes a double press one schedule (§4.3).

export type Cadence = 'WEEKLY' | 'MONTHLY'

export interface ScheduleFormProps {
  readonly reports: ReadonlyArray<{ readonly code: string; readonly name: string }>
  readonly recipients: ReadonlyArray<{ readonly id: string; readonly name: string; readonly self: boolean }>
  readonly schedule: (input: { reportCode: string; cadence: Cadence; format: 'xlsx' | 'csv'; recipientMemberIds: string[] }, idempotencyKey: string) => Promise<ScheduleOutcome>
}

const CADENCES: readonly Cadence[] = ['WEEKLY', 'MONTHLY']
const FORMATS = ['xlsx', 'csv'] as const

export function ScheduleForm({ reports, recipients, schedule }: ScheduleFormProps) {
  const t = useTranslations('reports.schedule')
  const router = useRouter()
  const submission = useSubmissionKey()
  const [reportCode, setReportCode] = useState(reports[0]?.code ?? '')
  const [cadence, setCadence] = useState<Cadence>('WEEKLY')
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx')
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(recipients.filter((r) => r.self).map((r) => r.id)))
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<ScheduleOutcome | null>(null)
  const [done, setDone] = useState<{ cadence: Cadence; count: number } | null>(null)
  // an answer about the recipients goes away once the choice of recipients changes
  const noRecipient = outcome && !outcome.ok && (scheduleErrorKey(outcome) === 'RECIPIENTS' || scheduleErrorKey(outcome) === 'RECIPIENT_SCOPE')

  function toggle(id: string, on: boolean) {
    const next = new Set(chosen)
    if (on) next.add(id)
    else next.delete(id)
    setChosen(next)
    if (noRecipient) setOutcome(null)
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (chosen.size === 0) {
      setOutcome({ ok: false, code: 'VALIDATION_FAILED', field: 'recipientMemberIds' })
      return
    }
    setPending(true)
    setOutcome(null)
    setDone(null)
    let result: ScheduleOutcome
    try {
      result = await schedule({ reportCode, cadence, format, recipientMemberIds: [...chosen] }, submission.key)
      submission.next()
    } catch {
      result = { ok: false, code: 'FAILED' }
    }
    setPending(false)
    setOutcome(result)
    if (result.ok) {
      setDone({ cadence, count: chosen.size })
      router.refresh()
    }
  }

  const radio = 'size-5 accent-[var(--primary)]'
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex max-w-2xl flex-col gap-5" noValidate>
      {reports.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="schedule-report" className="font-medium text-ink">
            {t('report')}
          </label>
          <select id="schedule-report" value={reportCode} onChange={(e) => setReportCode(e.target.value)} className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink">
            {reports.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="text-ink">{t('reportOnly', { name: reports[0]?.name ?? '-' })}</p>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium text-ink">{t('cadence')}</legend>
        {CADENCES.map((c) => (
          <label key={c} className="inline-flex min-h-11 items-center gap-3">
            <input type="radio" name="cadence" value={c} checked={cadence === c} onChange={() => setCadence(c)} className={radio} />
            <span>{t(`cadences.${c}`)}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium text-ink">{t('format')}</legend>
        {FORMATS.map((f) => (
          <label key={f} className="inline-flex min-h-11 items-center gap-3">
            <input type="radio" name="format" value={f} checked={format === f} onChange={() => setFormat(f)} className={radio} />
            <span>{t(`formats.${f}`)}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-2" aria-describedby="schedule-recipients-hint">
        <legend className="mb-1 font-medium text-ink">{t('recipients')}</legend>
        <p id="schedule-recipients-hint" className="text-base text-ink-muted md:text-sm">
          {t('recipientsHint')}
        </p>
        {recipients.map((r) => (
          <label key={r.id} className="inline-flex min-h-11 items-center gap-3">
            <input type="checkbox" checked={chosen.has(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} className="size-5 accent-[var(--primary)]" />
            <span>{r.self ? t('you', { name: r.name }) : r.name}</span>
          </label>
        ))}
      </fieldset>

      <p className="text-base text-ink-muted md:text-sm">{t('period')}</p>

      {outcome && !outcome.ok ? <Notice tone="danger">{t(`errors.${scheduleErrorKey(outcome)}`, { requestId: outcome.requestId ?? '-' })}</Notice> : null}
      {outcome?.ok && done ? <Notice tone="success">{t('done', { cadence: t(`cadences.${done.cadence}`), count: done.count })}</Notice> : null}

      <Button type="submit" disabled={pending} aria-busy={pending || undefined} className="self-start">
        {pending ? t('working') : t('submit')}
      </Button>
    </form>
  )
}
