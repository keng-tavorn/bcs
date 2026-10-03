'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { StateLine } from '../request-view/status'
import { TextArea } from '../request-view/text-area'
import { FileButton } from './file-button'
import { financeErrorKey, financeErrorValues, type ExportOutcome, type FinanceFailure } from './outcome'

// The Express files made, last first (FR-P2P-009 AC2, BR-EXP-02, BR-EXP-03): when and by whom, its rows, its total with
// VAT right-aligned, its SHA-256 checksum (wrapped, never in a monospace font), why it was made again when it was, and
// the file to download. Exporting the same invoices again sits behind a disclosure, apart from downloading, and needs a
// reason; it makes a new file and leaves the earlier one as it was. Strings arrive translated and formatted.

export interface ExportJobView {
  readonly id: string
  readonly title: string
  readonly meta: readonly string[]
  readonly rows: string
  readonly total: string
  readonly checksum: string | null
  /** "ส่งออกซ้ำ เหตุผล: …" for a file made again */
  readonly reason: string | null
  readonly invoiceCount: number
  readonly file: { readonly fileId: string; readonly label: string } | null
}

const REASON_MIN = 3

export function ExportJobs({
  jobs,
  again,
  open,
}: {
  jobs: readonly ExportJobView[]
  again: (input: { exportJobId: string; reason: string }, idempotencyKey: string) => Promise<ExportOutcome>
  open: (fileId: string) => Promise<string | null>
}) {
  const t = useTranslations('finance.exports.jobs')
  return (
    <ul aria-label={t('list')} className="flex flex-col divide-y divide-line border-y border-line">
      {jobs.map((job) => (
        <li key={job.id} className="flex flex-col gap-2 py-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <span className="font-semibold break-words text-ink">{job.title}</span>
            <span className="flex shrink-0 items-baseline justify-between gap-3 sm:flex-col sm:items-end sm:gap-0">
              <span className="text-base text-ink-muted md:text-sm">{t('total')}</span>
              <span className="money font-semibold text-ink">
                {job.total}
                <span className="sr-only"> {t('unit')}</span>
              </span>
            </span>
          </div>
          {job.meta.map((m) => (
            <span key={m} className="text-base break-words text-ink-muted md:text-sm">
              {m}
            </span>
          ))}
          <span className="text-ink">{job.rows}</span>
          {job.checksum ? (
            <span className="flex flex-col">
              <span className="text-base text-ink-muted md:text-sm">{t('checksum')}</span>
              <span className="break-all text-ink">{job.checksum}</span>
            </span>
          ) : null}
          {job.reason ? (
            <StateLine kind="returned" className="break-words">
              {job.reason}
            </StateLine>
          ) : null}
          {job.file ? <FileButton fileId={job.file.fileId} label={job.file.label} busyLabel={t('downloading')} failedText={t('downloadFailed')} open={open} /> : null}
          {job.invoiceCount > 0 ? <AgainForm job={job} again={again} /> : null}
        </li>
      ))}
    </ul>
  )
}

function AgainForm({ job, again }: { job: ExportJobView; again: (input: { exportJobId: string; reason: string }, idempotencyKey: string) => Promise<ExportOutcome> }) {
  const t = useTranslations('finance.exports.jobs')
  const tErrors = useTranslations('finance.errors')
  const router = useRouter()
  const id = useId()
  const submission = useSubmissionKey()
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<FinanceFailure | null>(null)
  const [made, setMade] = useState<Extract<ExportOutcome, { ok: true }> | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (reason.trim().length < REASON_MIN) return setReasonError(tErrors('REASON'))
    setPending(true)
    setFailure(null)
    let outcome: ExportOutcome
    try {
      outcome = await again({ exportJobId: job.id, reason: reason.trim() }, submission.key)
      submission.next()
    } catch {
      outcome = { ok: false, code: 'FAILED' }
    }
    setPending(false)
    if (!outcome.ok) {
      if (outcome.field === 'reason') return setReasonError(tErrors('REASON'))
      return setFailure(outcome)
    }
    setMade(outcome)
    setReason('')
    router.refresh()
  }

  if (made) return <Notice tone="success">{t('againDone', { count: made.rowCount, total: made.total })}</Notice>
  return (
    <details className="border-t border-line pt-2">
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-primary underline underline-offset-4 hover:no-underline">{t('againTitle', { count: job.invoiceCount })}</summary>
      <form onSubmit={onSubmit} noValidate className="mt-3 flex max-w-2xl flex-col gap-3">
        <p className="text-ink-muted">{t('againHint')}</p>
        <TextArea
          id={`${id}-reason`}
          label={t('reasonLabel')}
          hint={t('reasonHint')}
          value={reason}
          maxLength={REASON_MAX_LENGTH}
          onChange={(event) => {
            setReason(event.currentTarget.value)
            setReasonError(null)
          }}
          error={reasonError ?? undefined}
          required
        />
        {failure ? <Notice tone="danger">{tErrors(financeErrorKey(failure), financeErrorValues(failure))}</Notice> : null}
        <Button type="submit" variant="secondary" disabled={pending} className="self-start">
          {pending ? t('againWorking') : t('againSubmit', { count: job.invoiceCount })}
        </Button>
      </form>
    </details>
  )
}
