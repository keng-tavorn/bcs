'use client'

import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { BYTES_PER_KIB } from '@/lib/constants'
import { settle } from '../admin-settings/outcome'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { formatDateTime } from '../format'
import { moneyText } from './format'
import { commonBudgetErrorKey, needsRecheck, type ImportCheckOutcome, type ImportCheckRowView, type ImportCheckView, type ImportOutcome } from './outcome'

export type CheckBudgetFileAction = (formData: FormData) => Promise<ImportCheckOutcome>
export type ImportBudgetFileAction = (formData: FormData) => Promise<ImportOutcome>

function FieldError({ id, text }: { id: string; text: string | null }) {
  if (!text) return null
  return (
    <p id={id} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  )
}

// Budget import from the Excel template (FR-BUD-001) in two steps, because imported budget is written to the ledger and
// cannot be taken out again (§9.9: nothing irreversible without a confirmation). Step 1 checks the file and saves
// nothing: each row says what it will do — make a new budget line or add to one — or which column to fix and how (AC1),
// and a file imported before is named with when and by whom (AC3). Step 2, only when every row is right: the total, a
// tick that confirms, and for the same file again a second tick (AC3). The import checks everything again on the server.
export function ImportBudgetForm({
  templateHref,
  dashboardHref,
  maxBytes,
  maxRows,
  check,
  importFile,
}: {
  templateHref: string
  dashboardHref: string
  maxBytes: number
  maxRows: number
  check: CheckBudgetFileAction
  importFile: ImportBudgetFileAction
}) {
  const t = useTranslations('budgets.import')
  const locale = useLocale()
  const id = useId()
  const fileForm = useRef<HTMLFormElement>(null)
  const submission = useSubmissionKey()
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [pending, setPending] = useState<'check' | 'import' | null>(null)
  const [checked, setChecked] = useState<ImportCheckView | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [duplicateError, setDuplicateError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string; toDashboard?: boolean } | null>(null)
  const maxKb = Math.floor(maxBytes / BYTES_PER_KIB)
  const nameOf = (n: { th: string; en: string | null }) => (locale === 'en' && n.en ? n.en : n.th)
  const failed = (failure: Parameters<typeof commonBudgetErrorKey>[0]) => t(`errors.${commonBudgetErrorKey(failure)}`, { requestId: failure.requestId ?? '-' })

  function reset() {
    setChecked(null)
    setNotice(null)
    setFileError(null)
    setConfirmError(null)
    setDuplicateError(null)
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFileName(event.currentTarget.files?.[0]?.name ?? null)
    reset()
  }

  /** The chosen file is still in the file form: it goes with both steps */
  function chosenFile(): File | null {
    const file = fileForm.current ? new FormData(fileForm.current).get('file') : null
    return file instanceof File && file.size > 0 ? file : null
  }

  async function onCheck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    reset()
    const file = chosenFile()
    if (!file) return setFileError(t('errors.FILE_MISSING'))
    if (file.size > maxBytes) return setFileError(t('errors.FILE_TOO_LARGE', { max: maxKb }))
    setPending('check')
    const answer = await settle(check(new FormData(event.currentTarget)))
    setPending(null)
    if (!answer) return setNotice({ tone: 'danger', text: t('errors.FAILED') })
    if (answer.ok) return setChecked(answer.check)
    if (answer.reason === 'FILE_MISSING') return setFileError(t('errors.FILE_MISSING'))
    if (answer.reason === 'FILE_TOO_LARGE') return setFileError(t('errors.FILE_TOO_LARGE', { max: maxKb }))
    setNotice({ tone: 'danger', text: failed(answer) })
  }

  async function onImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!checked?.ready) return
    const confirm = new FormData(event.currentTarget)
    const confirmed = confirm.get('confirm') === 'yes'
    const again = confirm.get('again') === 'yes'
    setConfirmError(confirmed ? null : t('errors.CONFIRM'))
    setDuplicateError(checked.duplicate && !again ? t('errors.DUPLICATE_CONFIRM') : null)
    if (!confirmed || (checked.duplicate && !again)) return
    const file = chosenFile()
    if (!file) return setFileError(t('errors.FILE_MISSING'))
    const form = new FormData()
    form.set('file', file)
    form.set('idempotencyKey', submission.key)
    form.set('confirmDuplicate', checked.duplicate ? 'yes' : 'no')
    // The import refuses any other file than the one checked and confirmed here (RECHECK)
    form.set('checksum', checked.checksum)
    setNotice(null)
    setPending('import')
    const outcome = await settle(importFile(form))
    setPending(null)
    // No answer: the same key goes with a retry, so the budget is never added twice
    if (!outcome) return setNotice({ tone: 'danger', text: t('errors.FAILED') })
    submission.next()
    if (outcome.ok) {
      setChecked(null)
      fileForm.current?.reset()
      setFileName(null)
      return setNotice({ tone: 'success', text: t('imported', { count: outcome.rows, total: moneyText(outcome.total), created: outcome.linesCreated }), toDashboard: true })
    }
    if (needsRecheck(outcome)) {
      setChecked(null)
      return setNotice({ tone: 'danger', text: outcome.reason === 'RECHECK' ? t('errors.RECHECK_FILE') : t('errors.RECHECK') })
    }
    setNotice({ tone: 'danger', text: failed(outcome) })
  }

  const wrongRows = checked ? checked.rows.filter((r) => r.action === null).length : 0
  const warnedRows = checked ? checked.rows.filter((r) => r.warnings.length > 0).length : 0
  const fieldLabel = (field: ImportCheckRowView['errors'][number]['field']) => t(`fields.${field}`)

  return (
    <div className="flex flex-col gap-6">
      {notice ? (
        <Notice tone={notice.tone}>
          <p>{notice.text}</p>
          {notice.toDashboard ? (
            <Link href={dashboardHref} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
              {t('toDashboard')}
            </Link>
          ) : null}
        </Notice>
      ) : null}

      <section aria-labelledby={`${id}-check`} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id={`${id}-check`} className="text-xl font-semibold">
            {t('checkTitle')}
          </h2>
          <p className="text-ink-muted">{t('checkIntro')}</p>
        </div>
        <a href={templateHref} download className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('downloadTemplate')}
        </a>
        <form ref={fileForm} onSubmit={onCheck} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1.5">
            <span id={`${id}-file-label`} className="font-medium text-ink">
              {t('file')}
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
            <FieldError id={`${id}-file-error`} text={fileError} />
          </div>
          <Button type="submit" variant="secondary" disabled={pending !== null} className="self-start">
            {pending === 'check' ? t('checking') : t('check')}
          </Button>
        </form>
      </section>

      {checked ? (
        <section aria-labelledby={`${id}-result`} className="flex flex-col gap-3 border-t border-line pt-4">
          <h3 id={`${id}-result`} className="text-lg font-semibold">
            {t('resultTitle', { count: checked.rows.length })}
          </h3>
          {checked.fileErrors.length ? (
            <Notice tone="danger">
              <p className="font-medium">{t('resultFileErrors')}</p>
              <ul className="mt-2 flex flex-col gap-1">
                {checked.fileErrors.map((e) => (
                  <li key={`${e.row}-${e.reason}`}>
                    {e.row > 0 ? t('rowLabel', { row: e.row }) : t('fileLevel')} · {t(`reasons.${e.reason}`, { max: maxRows })}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {wrongRows > 0 ? <Notice tone="danger">{t('resultErrors', { count: wrongRows })}</Notice> : null}
          {checked.rows.length ? (
            <ul aria-labelledby={`${id}-result`} className="flex flex-col divide-y divide-line border-y border-line">
              {checked.rows.map((r) => (
                <li key={r.row} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="flex items-start gap-1.5 font-medium">
                      {r.action ? <CircleCheck className="mt-[0.3em] size-4 shrink-0 text-primary" aria-hidden="true" /> : <CircleAlert className="mt-[0.3em] size-4 shrink-0 text-danger" aria-hidden="true" />}
                      <span className="break-words">
                        {t('rowLabel', { row: r.row })} · {r.action ? t('rowOk') : t('rowWrong')} · {r.values.code || t('noCode')}
                      </span>
                    </p>
                    {r.values.nameTh ? <p className="break-words pl-6">{r.values.nameTh}</p> : null}
                    {r.action ? (
                      <>
                        <p className="pl-6 text-base text-ink-muted md:text-sm">{r.action === 'ADD' ? t('actionAdd', { current: moneyText(r.currentPlanned ?? { amount: '0' }) }) : t('actionCreate')}</p>
                        {r.warnings.length ? (
                          <ul className="flex flex-col gap-0.5 pl-6 text-base md:text-sm">
                            {r.warnings.map((w) => (
                              <li key={w.field} className="flex items-start gap-1.5">
                                <TriangleAlert className="mt-[0.3em] size-4 shrink-0 text-warn" aria-hidden="true" />
                                <span>{t(`warnings.${w.field}`, { current: w.current ?? t('warnings.none') })}</span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </>
                    ) : (
                      <ul className="flex flex-col gap-0.5 pl-6 text-base text-danger md:text-sm">
                        {r.errors.map((e) => (
                          <li key={`${e.field}-${e.reason}`}>
                            {fieldLabel(e.field)} · {t(`reasons.${e.reason}`, { max: maxRows })}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {r.amount ? <p className="money shrink-0 pl-6 font-semibold sm:pl-0">{t('amount', { amount: moneyText(r.amount) })}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}

          {checked.ready ? (
            <form onSubmit={onImport} className="flex flex-col gap-4 pt-2" noValidate>
              <p className="font-medium">{t('summary', { count: checked.rows.length, total: moneyText(checked.total), creates: checked.creates, adds: checked.adds })}</p>
              {warnedRows ? <Notice tone="warning">{t('warnings.notice', { count: warnedRows })}</Notice> : null}
              {checked.duplicate ? (
                <div className="flex flex-col gap-2">
                  <Notice tone="warning">
                    {checked.duplicate.importedBy
                      ? t('duplicateBy', { time: formatDateTime(locale, checked.duplicate.importedAt), fileName: checked.duplicate.fileName, name: nameOf(checked.duplicate.importedBy) })
                      : t('duplicate', { time: formatDateTime(locale, checked.duplicate.importedAt), fileName: checked.duplicate.fileName })}
                  </Notice>
                  <label className="flex min-h-11 items-start gap-3">
                    <input
                      type="checkbox"
                      name="again"
                      value="yes"
                      aria-invalid={duplicateError ? true : undefined}
                      aria-describedby={duplicateError ? `${id}-again-error` : undefined}
                      onChange={(event) => event.currentTarget.checked && setDuplicateError(null)}
                      className="mt-1 size-5 shrink-0 accent-[var(--warn)]"
                    />
                    <span>{t('duplicateConfirm')}</span>
                  </label>
                  <FieldError id={`${id}-again-error`} text={duplicateError} />
                </div>
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
                    className="mt-1 size-5 shrink-0"
                  />
                  <span>{t('confirm')}</span>
                </label>
                <FieldError id={`${id}-confirm-error`} text={confirmError} />
              </div>
              <Button type="submit" disabled={pending !== null} className="self-start">
                {pending === 'import' ? t('importing') : t('submit', { count: checked.rows.length })}
              </Button>
            </form>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
