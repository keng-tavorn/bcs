'use client'

import { CircleAlert } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { settle } from '../admin-settings/outcome'
import { Button } from '../form/button'
import { DateField } from '../form/date-field'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { Checkbox } from '../shadcn/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { Textarea } from '../shadcn/textarea'
import {
  CONFIG_SECTIONS,
  chosenSections,
  configErrorField,
  configErrorKey,
  createdLinks,
  sortedRows,
  type ConfigCreatedView,
  type ConfigErrorKey,
  type ConfigFailure,
  type ConfigRowView,
  type ConfigSection,
  type ExportOutcome,
  type ImportOutcome,
} from './present'

export type ExportConfigAction = (sections: string[], idempotencyKey: string) => Promise<ExportOutcome>
export type ImportConfigAction = (input: { file: string; effectiveDate: string; changeReason: string }, idempotencyKey: string) => Promise<ImportOutcome>

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'

function FieldError({ id, text }: { id: string; text: string | null }) {
  if (!text) return null
  return (
    <p id={id} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  )
}

/** The words of a refusal: what happened and how to fix it (§9.9 rule 7), with the §14.2 reference of an unexpected error */
function useErrorText() {
  const t = useTranslations('configPackages.errors')
  return (failure: ConfigFailure | null, key?: ConfigErrorKey) => (failure || key ? t(key ?? configErrorKey(failure!), { requestId: failure?.requestId ?? '-' }) : null)
}

// Export (FR-PLT-101 AC2 · BR-UAT-02): the sections ticked, as one JSON file with its schemaVersion and sha256. The file
// is saved by the browser as soon as the server answers, and stays a link away; the checksum shows so the person who
// imports it can tell it is the same file.
export function ExportConfigForm({ exportPackage }: { exportPackage: ExportConfigAction }) {
  const t = useTranslations('configPackages.export')
  const tSections = useTranslations('configPackages.sections')
  const errorText = useErrorText()
  const id = useId()
  const submission = useSubmissionKey()
  const [sections, setSections] = useState<ConfigSection[]>([...CONFIG_SECTIONS])
  const [pending, setPending] = useState(false)
  const [sectionsError, setSectionsError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<{ fileName: string; checksum: string; href: string } | null>(null)
  const anchor = useRef<HTMLAnchorElement>(null)
  const address = useRef<string | null>(null)

  // The file's address lives as long as the page shows its link
  const release = () => {
    if (address.current) URL.revokeObjectURL(address.current)
    address.current = null
  }
  useEffect(() => release, [])

  function toggle(section: ConfigSection, on: boolean) {
    setSections((now) => chosenSections(on ? [...now, section] : now.filter((s) => s !== section)))
    setSectionsError(null)
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    setDone(null)
    release()
    if (sections.length === 0) return setSectionsError(errorText(null, 'SECTIONS'))
    setPending(true)
    const outcome = await settle(exportPackage(sections, submission.key))
    setPending(false)
    // No answer: the same key goes with a retry, so the package is exported once
    if (!outcome) return setFailure(errorText(null, 'FAILED'))
    submission.next()
    if (!outcome.ok) {
      const key = configErrorKey(outcome)
      return key === 'SECTIONS' ? setSectionsError(errorText(outcome)) : setFailure(errorText(outcome))
    }
    const href = URL.createObjectURL(new Blob([outcome.file], { type: 'application/json' }))
    address.current = href
    // Drawn first, then saved at once: the download the person asked for by pressing the button
    flushSync(() => setDone({ fileName: outcome.fileName, checksum: outcome.checksum, href }))
    anchor.current?.click()
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      <fieldset className="flex flex-col gap-2" aria-describedby={sectionsError ? `${id}-sections-error` : undefined}>
        <legend className="mb-1 font-medium text-ink">{t('sections')}</legend>
        {CONFIG_SECTIONS.map((section) => (
          <div key={section} className="flex items-start gap-3">
            <Checkbox
              id={`${id}-${section}`}
              checked={sections.includes(section)}
              onCheckedChange={(v) => toggle(section, v === true)}
              aria-describedby={`${id}-${section}-hint`}
              aria-invalid={sectionsError ? true : undefined}
              className="mt-1.5"
            />
            <div className="flex min-w-0 flex-col">
              <label htmlFor={`${id}-${section}`} className="min-h-7 cursor-pointer font-medium text-ink">
                {tSections(`${section}.name`)}
              </label>
              <span id={`${id}-${section}-hint`} className="text-base text-ink-muted md:text-sm">
                {tSections(`${section}.exportHint`)}
              </span>
            </div>
          </div>
        ))}
        <FieldError id={`${id}-sections-error`} text={sectionsError} />
      </fieldset>
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? t('pending') : t('submit')}
      </Button>
      {done ? (
        <Notice tone="success">
          <p>{t('done', { fileName: done.fileName })}</p>
          <p className="break-all">{t('checksum', { checksum: done.checksum })}</p>
          <a ref={anchor} href={done.href} download={done.fileName} className={linkClass}>
            {t('downloadAgain', { fileName: done.fileName })}
          </a>
        </Notice>
      ) : null}
    </form>
  )
}

function RowsRefused({ rows }: { rows: readonly ConfigRowView[] }) {
  const t = useTranslations('configPackages.rows')
  const tSections = useTranslations('configPackages.sections')
  const sorted = sortedRows(rows)
  return (
    <div className="flex flex-col gap-3">
      {/* A phone reads the rows as a list; the table never makes the page scroll sideways (§9.9) */}
      <ul className="flex flex-col divide-y divide-line border-y border-line md:hidden">
        {sorted.map((row, i) => (
          <li key={`${row.section}-${row.ref}-${i}`} className="flex flex-col gap-0.5 py-3">
            <span className="font-medium break-all">{row.ref}</span>
            <span className="text-ink-muted">{tSections(`${row.section}.name`)}</span>
            <span>{t(`reasons.${row.reason}`)}</span>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t('section')}</TableHead>
              <TableHead scope="col">{t('ref')}</TableHead>
              <TableHead scope="col">{t('reason')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row, i) => (
              <TableRow key={`${row.section}-${row.ref}-${i}`}>
                <TableCell>{tSections(`${row.section}.name`)}</TableCell>
                <TableCell className="break-all whitespace-normal">{row.ref}</TableCell>
                <TableCell className="whitespace-normal">{t(`reasons.${row.reason}`)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function CreatedDrafts({ created }: { created: ConfigCreatedView }) {
  const t = useTranslations('configPackages.created')
  const links = createdLinks(created)
  if (links.length === 0) return <Notice tone="info">{t('none')}</Notice>
  return (
    <Notice tone="success">
      <p>{t('title', { count: created.forms.length + created.workflows.length + created.doa.length + created.catalog.length })}</p>
      <ul className="mt-1 flex flex-col">
        {links.map((link, i) => (
          <li key={`${link.section}-${i}`}>
            <Link href={link.href} className={linkClass}>
              {t(link.key, link.values)}
            </Link>
          </li>
        ))}
      </ul>
    </Notice>
  )
}

type Answer = { kind: 'created'; created: ConfigCreatedView } | { kind: 'rows'; rows: readonly ConfigRowView[] } | { kind: 'failed'; text: string }

// Import (FR-PLT-101 AC2 · BR-UAT-03): a package exported from another organization of the customer — its UAT sandbox —
// becomes drafts only: the DOA and the workflow start on the date chosen once approved, the forms wait in the form
// builder and the catalogue comes in inactive. A file that was changed or is not a package is refused under the file
// field; rows that do not fit this organization are listed with their reasons, and then nothing was created.
export function ImportConfigForm({ importPackage, defaultDate, maxChars }: { importPackage: ImportConfigAction; defaultDate: string; maxChars: number }) {
  const t = useTranslations('configPackages.import')
  const errorText = useErrorText()
  const id = useId()
  const form = useRef<HTMLFormElement>(null)
  const submission = useSubmissionKey()
  const [fileName, setFileName] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<{ file?: string | null; effectiveDate?: string | null; changeReason?: string | null }>({})
  const [answer, setAnswer] = useState<Answer | null>(null)

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFileName(event.currentTarget.files?.[0]?.name ?? null)
    setErrors((now) => ({ ...now, file: null }))
    setAnswer(null)
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAnswer(null)
    const data = new FormData(event.currentTarget)
    const chosen = data.get('file')
    const file = chosen instanceof File && chosen.size > 0 ? chosen : null
    const effectiveDate = String(data.get('effectiveDate') ?? '')
    const changeReason = String(data.get('changeReason') ?? '').trim()
    const next = {
      file: file ? null : errorText(null, 'FILE_MISSING'),
      effectiveDate: effectiveDate ? null : errorText(null, 'DATE'),
      changeReason: changeReason.length >= 3 ? null : errorText(null, 'REASON'),
    }
    setErrors(next)
    if (!file || next.effectiveDate || next.changeReason) return
    const text = await file.text()
    if (text.length > maxChars) return setErrors({ file: errorText(null, 'FILE_TOO_LARGE') })
    setPending(true)
    const outcome = await settle(importPackage({ file: text, effectiveDate, changeReason }, submission.key))
    setPending(false)
    // No answer: the same key goes with a retry, so the drafts are made once
    if (!outcome) return setAnswer({ kind: 'failed', text: errorText(null, 'FAILED')! })
    submission.next()
    if (outcome.ok) {
      form.current?.reset()
      setFileName(null)
      return setAnswer({ kind: 'created', created: outcome.created })
    }
    const key = configErrorKey(outcome)
    const field = configErrorField(key)
    if (field) return setErrors({ [field]: errorText(outcome) })
    if (key === 'ROWS' && outcome.rows?.length) return setAnswer({ kind: 'rows', rows: outcome.rows })
    setAnswer({ kind: 'failed', text: errorText(outcome)! })
  }

  const described = (field: 'file' | 'changeReason', base?: string) => [base, errors[field] ? `${id}-${field}-error` : null].filter(Boolean).join(' ') || undefined

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="info">{t('draftsOnly')}</Notice>
      <form ref={form} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
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
                accept=".json,application/json"
                aria-labelledby={`${id}-file-label`}
                aria-invalid={errors.file ? true : undefined}
                aria-describedby={described('file', `${id}-file-name`)}
                onChange={onFileChange}
                className="sr-only"
              />
            </label>
            <span id={`${id}-file-name`} className="min-w-0 break-all text-ink-muted">
              {fileName ?? t('noFileChosen')}
            </span>
          </div>
          <FieldError id={`${id}-file-error`} text={errors.file ?? null} />
        </div>
        <div className="flex flex-col gap-1.5">
          <DateField id={`${id}-date`} name="effectiveDate" label={t('effectiveDate')} hint={t('effectiveDateHint')} defaultValue={defaultDate} required {...(errors.effectiveDate ? { errorId: `${id}-date-error` } : {})} />
          <FieldError id={`${id}-date-error`} text={errors.effectiveDate ?? null} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-reason`} className="font-medium text-ink">
            {t('changeReason')}
          </label>
          <Textarea
            id={`${id}-reason`}
            name="changeReason"
            required
            maxLength={500}
            rows={3}
            aria-invalid={errors.changeReason ? true : undefined}
            aria-describedby={described('changeReason', `${id}-reason-hint`)}
          />
          <p id={`${id}-reason-hint`} className="text-base text-ink-muted md:text-sm">
            {t('changeReasonHint')}
          </p>
          <FieldError id={`${id}-changeReason-error`} text={errors.changeReason ?? null} />
        </div>
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? t('pending') : t('submit')}
        </Button>
      </form>
      {answer?.kind === 'created' ? <CreatedDrafts created={answer.created} /> : null}
      {answer?.kind === 'rows' ? (
        <div className="flex flex-col gap-3">
          <Notice tone="danger">{t('rowsRefused', { count: answer.rows.length })}</Notice>
          <RowsRefused rows={answer.rows} />
        </div>
      ) : null}
      {answer?.kind === 'failed' ? <Notice tone="danger">{answer.text}</Notice> : null}
    </div>
  )
}
