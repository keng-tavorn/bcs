'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { ConfirmBox } from '../request-view/text-area'
import { FileButton } from './file-button'
import { financeErrorKey, financeErrorValues, type ExportOutcome, type FinanceFailure } from './outcome'

// Making the Express file (FR-P2P-009 AC1, AC2, BR-EXP-02, BR-EXP-03): the invoices listed above go into one file in
// the organization's layout and are marked exported, which cannot be undone — so a tick first, and a button that says
// how many invoices it takes. The tick confirms that list exactly: its fingerprint goes with it, and when the list
// changed meanwhile (an invoice recorded, or exported by someone else) the server refuses, the page reloads the list and
// the person ticks again. The answer shows the file's rows, total and SHA-256 checksum, and the file downloads through
// a short-lived address. Kept in place whatever the list shows, so its answer stays after the page refreshes.

type Made = Extract<ExportOutcome, { ok: true }>

export function ExportPanel({
  count,
  total,
  fingerprint,
  blocked,
  make,
  open,
}: {
  /** Invoices the next file takes */
  count: number
  /** Their total with VAT, formatted */
  total: string
  /** The fingerprint of exactly those invoices, sent back with the tick */
  fingerprint: string
  /** The organization has no layout yet: nothing can be made */
  blocked: boolean
  make: (input: { confirmed: boolean; fingerprint: string }, idempotencyKey: string) => Promise<ExportOutcome>
  open: (fileId: string) => Promise<string | null>
}) {
  const t = useTranslations('finance.exports.panel')
  const tErrors = useTranslations('finance.errors')
  const router = useRouter()
  const id = useId()
  const submission = useSubmissionKey()
  const [confirmed, setConfirmed] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<FinanceFailure | null>(null)
  const [made, setMade] = useState<Made | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!confirmed) return setConfirmError(tErrors('CONFIRM'))
    setPending(true)
    setFailure(null)
    let outcome: ExportOutcome
    try {
      outcome = await make({ confirmed, fingerprint }, submission.key)
      submission.next()
    } catch {
      outcome = { ok: false, code: 'FAILED' }
    }
    setPending(false)
    if (!outcome.ok) {
      setFailure(outcome)
      // The list changed since it was ticked: show the new one, to be checked and ticked again
      if (financeErrorKey(outcome) === 'PENDING_CHANGED') {
        setConfirmed(false)
        router.refresh()
      }
      return
    }
    setFailure(null)
    setMade(outcome)
    setConfirmed(false)
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-4">
      {made ? (
        <section aria-labelledby={`${id}-made`} className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4">
          <h3 id={`${id}-made`} className="font-semibold text-ink">
            {t('madeTitle')}
          </h3>
          <dl className="flex max-w-xl flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-muted">{t('rows')}</dt>
              <dd className="money text-ink">{t('rowsValue', { count: made.rowCount })}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-muted">{t('total')}</dt>
              <dd className="money font-semibold text-ink">{t('baht', { amount: made.total })}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-ink-muted">{t('checksum')}</dt>
              <dd className="break-all text-ink">{made.checksum}</dd>
            </div>
          </dl>
          {made.excluded > 0 ? <p className="text-ink">{t('madeExcluded', { count: made.excluded })}</p> : null}
          <FileButton fileId={made.fileId} label={t('download')} busyLabel={t('downloading')} failedText={t('downloadFailed')} open={open} />
        </section>
      ) : null}

      {/* Outside the form: when the list emptied meanwhile, the form goes and the reason stays */}
      {failure ? (
        <Notice tone={financeErrorKey(failure) === 'PENDING_CHANGED' ? 'warning' : 'danger'}>{tErrors(financeErrorKey(failure), financeErrorValues(failure))}</Notice>
      ) : null}
      {count > 0 && !blocked ? (
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          <ConfirmBox
            id={`${id}-confirm`}
            label={t('confirmLabel', { count })}
            checked={confirmed}
            onChange={(checked) => {
              setConfirmed(checked)
              setConfirmError(null)
              setFailure(null)
            }}
            error={confirmError ?? undefined}
          />
          <Button type="submit" disabled={pending} className="self-start">
            {pending ? t('making') : t('make', { count, total })}
          </Button>
        </form>
      ) : null}
    </div>
  )
}
