'use client'

import { CircleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useRef, useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { MEMBER_IMPORT_MAX_BYTES } from '@/lib/constants'
import { memberErrorKey, memberErrorValues, type AdminOutcome, type ImportField, type ImportRowErrorView } from './outcome'

export type ImportMembersAction = (formData: FormData) => Promise<AdminOutcome>

const FILE_REASONS = ['FILE_MISSING', 'FILE_TOO_LARGE'] as const

// Import members from the Excel template (FR-ADM-001 AC3): all rows or none; every wrong row is listed with the
// column and what to fix, so the admin can correct the file and import it again.
export function ImportMembersForm({ templateHref, importFile }: { templateHref: string; importFile: ImportMembersAction }) {
  const t = useTranslations('admin.members')
  const formRef = useRef<HTMLFormElement>(null)
  const [pending, setPending] = useState(false)
  const [imported, setImported] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [rows, setRows] = useState<readonly ImportRowErrorView[]>([])
  const [fileName, setFileName] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const file = form.get('file')
    setImported(null)
    setFailure(null)
    setRows([])
    if (!(file instanceof File) || file.size === 0) return setFileError(t('errors.FILE_MISSING'))
    if (file.size > MEMBER_IMPORT_MAX_BYTES) return setFileError(t('errors.FILE_TOO_LARGE'))
    setFileError(null)
    setPending(true)
    const outcome = await importFile(form)
    setPending(false)
    if (outcome.ok) {
      const count = outcome.count ?? 0
      const notSent = outcome.notSent ?? []
      // Say what really happened to the e-mails (§9.9 rule 7): all sent, some not sent (and to whom), or nothing new
      if (outcome.emailsSent === null) setImported({ tone: 'success', text: t('importedAlready', { count }) })
      else if (notSent.length) setImported({ tone: 'warning', text: t('importedNotSent', { count, sent: count - notSent.length, emails: notSent.join(', ') }) })
      else setImported({ tone: 'success', text: t('imported', { count }) })
      formRef.current?.reset()
      setFileName(null)
      return
    }
    if (outcome.rows?.length) return setRows(outcome.rows)
    const reason = FILE_REASONS.find((r) => r === outcome.reason)
    if (reason) return setFileError(t(`errors.${reason}`))
    setFailure(t(`errors.${memberErrorKey(outcome)}`, memberErrorValues(outcome)))
  }

  const fieldLabel = (field: Exclude<ImportField, 'file'>) => t(`fields.${field}`)
  // A row problem names the row and the column; a whole-file problem is said once (ทั้งไฟล์), a header problem names row 1
  const where = (r: ImportRowErrorView) => {
    if (r.field !== 'file') return `${t('rowLabel', { row: r.row })} · ${fieldLabel(r.field)}`
    return r.row > 0 ? t('rowLabel', { row: r.row }) : t('fileLevel')
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <p className="text-ink-muted">{t('importIntro')}</p>
      <a href={templateHref} download className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {t('downloadTemplate')}
      </a>
      {imported !== null ? <Notice tone={imported.tone}>{imported.text}</Notice> : null}
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      {rows.length ? (
        <Notice tone="danger">
          <p className="font-medium">{t('importErrors')}</p>
          <ul className="mt-2 flex flex-col gap-1">
            {rows.map((r) => (
              <li key={`${r.row}-${r.field}-${r.reason}`}>
                {where(r)} · {t(`importReasons.${r.reason}`)}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <span id="import-file-label" className="font-medium text-ink">
          {t('importFile')}
        </span>
        {/* Our own button and file-name text instead of the browser's, which follows the browser language (§9.9) */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex h-11 cursor-pointer items-center rounded-md border border-input bg-bg px-4 font-medium text-ink hover:bg-surface has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary">
            {t('chooseFile')}
            <input
              id="import-file"
              name="file"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-labelledby="import-file-label"
              aria-invalid={fileError ? true : undefined}
              aria-describedby={fileError ? 'import-file-error' : 'import-file-name'}
              onChange={(event) => setFileName(event.currentTarget.files?.[0]?.name ?? null)}
              className="sr-only"
            />
          </label>
          <span id="import-file-name" className="min-w-0 break-all text-ink-muted">
            {fileName ?? t('noFileChosen')}
          </span>
        </div>
        {fileError ? (
          <p id="import-file-error" className="flex items-start gap-1.5 text-base text-danger md:text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{fileError}</span>
          </p>
        ) : null}
      </div>
      <Button type="submit" variant="secondary" disabled={pending} className="self-start">
        {pending ? t('importSubmitting') : t('importSubmit')}
      </Button>
    </form>
  )
}
