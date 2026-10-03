'use client'

import { CircleAlert } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import { MEMBER_IMPORT_MAX_BYTES } from '@/lib/constants'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import type { CheckHolidaysAction, HolidayCheckView, ImportHolidaysAction } from './holidays'
import { commonErrorKey, settle, type HolidayRowErrorView, type SettingsFailure } from './outcome'

/** The file goes through a server action like the member import, so it has the same size limit */
const MAX_BYTES = MEMBER_IMPORT_MAX_BYTES

/** Refusals of step 2 that mean the dates changed since step 1 (another import, a new year): check the file again */
const RECHECK_REASONS = ['INVALID_DATE', 'DATE_OUT_OF_RANGE', 'DUPLICATE_IN_FILE']

// Holidays from the Excel template (FR-ADM-003 AC2) in two steps, because an added holiday cannot be removed or renamed
// and it moves the due time of tasks assigned later (§9.9: nothing irreversible without a confirmation). Step 1 checks
// the file: every wrong row is listed with the column and what to fix, and nothing is saved; otherwise the dates it
// would add and the dates the calendar has (skipped, names kept) are listed. Step 2 adds exactly those dates once the
// admin ticks the confirmation. Choosing another file starts over.
export function HolidayImportForm({
  templateHref,
  years,
  check,
  importRows,
}: {
  templateHref: string
  /** Buddhist-era years a holiday may fall in, for the message of a date out of range */
  years: { from: number; to: number }
  check: CheckHolidaysAction
  importRows: ImportHolidaysAction
}) {
  const t = useTranslations('adminSettings.calendar')
  const tCommon = useTranslations('adminSettings')
  const locale = useLocale()
  const id = useId()
  const fileForm = useRef<HTMLFormElement>(null)
  const submission = useSubmissionKey()
  const [pending, setPending] = useState<'check' | 'import' | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [rows, setRows] = useState<readonly HolidayRowErrorView[]>([])
  const [checked, setChecked] = useState<HolidayCheckView | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'info' | 'danger'; text: string } | null>(null)
  const formatDate = (date: string) => (locale === 'en' ? formatEnglishBeDate(date) : formatThaiDate(date))
  const failed = (failure: SettingsFailure) => tCommon(`errors.${commonErrorKey(failure)}`, { requestId: failure.requestId ?? '-' })

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFileName(event.currentTarget.files?.[0]?.name ?? null)
    setChecked(null)
    setRows([])
    setNotice(null)
    setFileError(null)
    setConfirmError(null)
  }

  async function onCheck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const file = form.get('file')
    setNotice(null)
    setRows([])
    setChecked(null)
    setConfirmError(null)
    if (!(file instanceof File) || file.size === 0) return setFileError(t('errors.FILE_MISSING'))
    if (file.size > MAX_BYTES) return setFileError(t('errors.FILE_TOO_LARGE'))
    setFileError(null)
    setPending('check')
    const answer = await settle(check(form))
    setPending(null)
    if (!answer) return setNotice({ tone: 'danger', text: tCommon('errors.FAILED') })
    if (answer.ok) return setChecked(answer.check)
    if (answer.rows?.length) return setRows(answer.rows)
    if (answer.reason === 'FILE_MISSING' || answer.reason === 'FILE_TOO_LARGE') return setFileError(t(`errors.${answer.reason}`))
    setNotice({ tone: 'danger', text: failed(answer) })
  }

  async function onImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!checked?.add.length) return
    if (new FormData(event.currentTarget).get('confirm') !== 'yes') return setConfirmError(t('errors.CONFIRM'))
    setConfirmError(null)
    setNotice(null)
    setPending('import')
    // The rows of the checked file: the dates shown as added, and the dates shown as skipped, which the server skips again
    const rows = [...checked.add, ...checked.skip].map((h) => ({ date: h.date, nameTh: h.nameTh }))
    const outcome = await settle(importRows({ rows }, submission.key))
    setPending(null)
    // No answer: the same key goes with a retry, so the dates are never added twice
    if (!outcome) return setNotice({ tone: 'danger', text: tCommon('errors.FAILED') })
    submission.next()
    if (outcome.ok) {
      const added = outcome.added ?? 0
      const skipped = outcome.skipped ?? 0
      setNotice(
        added === 0
          ? { tone: 'info', text: t('importedNothing', { skipped }) }
          : { tone: 'success', text: skipped ? t('importedSkipped', { added, skipped }) : t('imported', { added }) },
      )
      setChecked(null)
      fileForm.current?.reset()
      setFileName(null)
      return
    }
    if (outcome.code === 'VALIDATION_FAILED' && RECHECK_REASONS.includes(outcome.reason ?? '')) {
      setChecked(null)
      return setNotice({ tone: 'danger', text: t('errors.RECHECK') })
    }
    setNotice({ tone: 'danger', text: failed(outcome) })
  }

  // A row problem names the row and the column; a whole-file problem is said once, a header problem names row 1
  const where = (r: HolidayRowErrorView) => {
    if (r.field !== 'file') return `${t('rowLabel', { row: r.row })} · ${t(`fields.${r.field}`)}`
    return r.row > 0 ? t('rowLabel', { row: r.row }) : t('fileLevel')
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-ink-muted">{t('importIntro')}</p>
      <a href={templateHref} download className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {t('downloadTemplate')}
      </a>
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      {rows.length ? (
        <Notice tone="danger">
          <p className="font-medium">{t('importErrors')}</p>
          <ul className="mt-2 flex flex-col gap-1">
            {rows.map((r) => (
              <li key={`${r.row}-${r.field}-${r.reason}`}>
                {where(r)} · {t(`importReasons.${r.reason}`, { from: years.from, to: years.to })}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <form ref={fileForm} onSubmit={onCheck} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <span id={`${id}-file-label`} className="font-medium text-ink">
            {t('importFile')}
          </span>
          {/* Our own button and file-name text instead of the browser's, which follows the browser language (§9.9) */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex h-11 cursor-pointer items-center rounded-md border border-input bg-bg px-4 font-medium text-ink hover:bg-surface has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary">
              {t('chooseFile')}
              <input
                name="file"
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                aria-labelledby={`${id}-file-label`}
                aria-invalid={fileError ? true : undefined}
                aria-describedby={fileError ? `${id}-file-error` : `${id}-file-name`}
                onChange={onFileChange}
                className="sr-only"
              />
            </label>
            <span id={`${id}-file-name`} className="min-w-0 break-all text-ink-muted">
              {fileName ?? t('noFileChosen')}
            </span>
          </div>
          {fileError ? (
            <p id={`${id}-file-error`} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{fileError}</span>
            </p>
          ) : null}
        </div>
        <Button type="submit" variant="secondary" disabled={pending !== null} className="self-start">
          {pending === 'check' ? t('checking') : t('checkSubmit')}
        </Button>
      </form>

      {checked && checked.add.length === 0 ? <Notice tone="info">{t('importedNothing', { skipped: checked.skip.length })}</Notice> : null}

      {checked && checked.add.length > 0 ? (
        <form onSubmit={onImport} className="flex flex-col gap-4 border-t border-line pt-4" noValidate>
          <section aria-labelledby={`${id}-add`} className="flex flex-col gap-2">
            <h3 id={`${id}-add`} className="font-semibold">
              {t('checkAdd', { count: checked.add.length })}
            </h3>
            <ul className="flex flex-col divide-y divide-line border-y border-line">
              {checked.add.map((h) => (
                <li key={h.date} className="flex flex-col gap-0.5 py-2">
                  <span className="tabular font-medium">
                    {formatDate(h.date)} <span className="font-normal text-ink-muted">· {t('holidayDay', { weekday: t(`weekdays.${h.weekday}`) })}</span>
                  </span>
                  <span className="break-words">{h.nameTh}</span>
                </li>
              ))}
            </ul>
          </section>
          {checked.skip.length ? (
            <section aria-labelledby={`${id}-skip`} className="flex flex-col gap-2">
              <h3 id={`${id}-skip`} className="font-semibold">
                {t('checkSkip', { count: checked.skip.length })}
              </h3>
              <ul className="flex flex-col divide-y divide-line border-y border-line">
                {checked.skip.map((h) => (
                  <li key={h.date} className="flex flex-col gap-0.5 py-2">
                    <span className="tabular font-medium">{formatDate(h.date)}</span>
                    <span className="break-words text-ink-muted">{t('checkSkipName', { name: h.calendarNameTh })}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <label className="flex min-h-11 items-start gap-3">
              <input
                type="checkbox"
                name="confirm"
                value="yes"
                aria-invalid={confirmError ? true : undefined}
                aria-describedby={confirmError ? `${id}-confirm-error` : undefined}
                onChange={(event) => event.currentTarget.checked && setConfirmError(null)}
                className="mt-1 size-5 shrink-0 accent-[var(--primary)]"
              />
              <span>{t('confirm', { count: checked.add.length })}</span>
            </label>
            {confirmError ? (
              <p id={`${id}-confirm-error`} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{confirmError}</span>
              </p>
            ) : null}
          </div>
          <Button type="submit" disabled={pending !== null} className="self-start">
            {pending === 'import' ? t('importing') : t('importSubmit', { count: checked.add.length })}
          </Button>
        </form>
      ) : null}
    </div>
  )
}
