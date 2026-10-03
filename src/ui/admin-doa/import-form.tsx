'use client'

import { CircleAlert } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useRef, useState, type FormEvent } from 'react'
import { BYTES_PER_KIB, REASON_MAX_LENGTH } from '@/lib/constants'
import type { ActionFailure, ProblemView } from '../admin-org/outcome'
import { failureKey } from '../admin-org/outcome'
import { errorValues, useAction } from '../admin-org/use-action'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'

// Import DOA versions from YAML (FR-DOA-001 AC2): the same shape as the file each version downloads as. Imported
// versions are drafts; nothing takes effect until a draft is submitted and approved. A file with problems imports
// nothing, and every problem is listed with where it is and what to fix. The size limit arrives from the page — the
// same number the server action checks — and the messages quote it.

export type ImportDoaResult = { readonly ok: true; readonly versions: ReadonlyArray<{ readonly id: string; readonly code: string; readonly versionNo: number }> } | ActionFailure
export type ImportDoaAction = (formData: FormData) => Promise<ImportDoaResult>

export const DOA_REASONS = [
  'VERSION_EXISTS',
  'EFFECTIVE_IN_PAST',
  'LATER_VERSION_SCHEDULED',
  'WARNINGS_NOT_ACKNOWLEDGED',
  'DOA_LINT_FAILED',
  'NOT_INITIAL',
  'SIGNATORY_NOT_VERIFIED',
  'POSITION_NOT_IN_DOA',
  'UNLISTED_HOLDER',
  'DUPLICATE_SLOT',
  'ORG_POSITION',
  'POSITION',
  'DEPARTMENT',
  'MEMBER',
  'NO_DEPARTMENT',
  'SOD_VIOLATION',
  'FILE_MISSING',
  'FILE_TOO_LARGE',
] as const

const MONEY_KEYS = new Set(['gt', 'gte', 'lte', 'stepUpThreshold'])

/** The message key of one YAML problem under adminDoa.import.issues */
function issueKey(p: ProblemView): 'NOT_YAML' | 'UNKNOWN_MEMBER' | 'DUPLICATE_RULE' | 'MONEY' | 'INSTANT' | 'EXTRA_KEY' | 'REQUIRED' | 'VALUE' | 'SHAPE' {
  if (p.issue === 'NOT_YAML' || p.issue === 'UNKNOWN_MEMBER' || p.issue === 'DUPLICATE_RULE') return p.issue
  if (p.issue === 'unrecognized_keys') return 'EXTRA_KEY'
  if (p.issue === 'MISSING') return 'REQUIRED'
  const last = p.path.split('.').at(-1) ?? ''
  if (MONEY_KEYS.has(last)) return 'MONEY'
  if (last === 'effectiveFrom') return 'INSTANT'
  if (p.issue === 'invalid_value') return 'VALUE'
  return 'SHAPE'
}

export function ImportDoaForm({ importFile, maxBytes }: { importFile: ImportDoaAction; maxBytes: number }) {
  const t = useTranslations('adminDoa')
  const formRef = useRef<HTMLFormElement>(null)
  const action = useAction()
  const [fileName, setFileName] = useState<string | null>(null)
  const [errors, setErrors] = useState<{ file?: string; reason?: string }>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [problems, setProblems] = useState<readonly ProblemView[]>([])
  const [imported, setImported] = useState<Extract<ImportDoaResult, { ok: true }>['versions']>([])
  const tooLarge = () => t('errors.FILE_TOO_LARGE', { size: Math.floor(maxBytes / BYTES_PER_KIB) })
  const reasonError = (reason: string) => (reason.length > REASON_MAX_LENGTH ? t('errors.REASON_TOO_LONG', { max: REASON_MAX_LENGTH }) : t('errors.REASON'))

  /** "versions.1.rules.2.when.amount.lte" → "ฉบับที่ 2 ในไฟล์ ข้อที่ 3 · when.amount.lte" */
  const where = (path: string) => {
    const m = /^versions\.(\d+)(?:\.rules\.(\d+))?(?:\.(.+))?$/.exec(path)
    if (!m) return path ? `${t('import.where.file')} · ${path}` : t('import.where.file')
    const place = m[2] !== undefined ? t('import.where.rule', { n: Number(m[1]) + 1, m: Number(m[2]) + 1 }) : t('import.where.version', { n: Number(m[1]) + 1 })
    return m[3] ? `${place} · ${m[3]}` : place
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const file = form.get('file')
    const reason = String(form.get('reason') ?? '').trim()
    const next: typeof errors = {}
    if (!(file instanceof File) || file.size === 0) next.file = t('errors.FILE_MISSING')
    else if (file.size > maxBytes) next.file = tooLarge()
    if (reason.length < 3 || reason.length > REASON_MAX_LENGTH) next.reason = reasonError(reason)
    setErrors(next)
    setFailure(null)
    setProblems([])
    setImported([])
    if (next.file || next.reason) return
    const outcome = await action.run((key) => {
      form.set('idempotencyKey', key)
      return importFile(form)
    })
    if (outcome.ok) {
      setImported(outcome.versions)
      formRef.current?.reset()
      setFileName(null)
      action.done()
      return
    }
    if (outcome.problems?.length) return setProblems(outcome.problems)
    if (outcome.reason === 'FILE_MISSING') return setErrors({ file: t('errors.FILE_MISSING') })
    if (outcome.reason === 'FILE_TOO_LARGE') return setErrors({ file: tooLarge() })
    if (outcome.field === 'changeReason') return setErrors({ reason: reasonError(reason) })
    setFailure(t(`errors.${failureKey(outcome, DOA_REASONS)}`, errorValues(outcome)))
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      <p className="text-ink-muted">{t('import.intro')}</p>
      {imported.length ? (
        <Notice tone="success">
          <p>{t('import.done', { names: imported.map((v) => t('versionName', { code: v.code, version: v.versionNo })).join(', ') })}</p>
          <ul className="mt-1 flex flex-col">
            {imported.map((v) => (
              <li key={v.id}>
                <Link href={`/admin/doa/${v.id}`} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
                  {t('import.openDraft', { name: t('versionName', { code: v.code, version: v.versionNo }) })}
                </Link>
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      {problems.length ? (
        <Notice tone="danger">
          <p className="font-medium">{t('import.problemsTitle')}</p>
          <ul className="mt-2 flex flex-col gap-1">
            {problems.map((p, i) => (
              <li key={`${p.path}-${i}`}>
                {where(p.path)} · {t(`import.issues.${issueKey(p)}`, { keys: (p.keys ?? []).join(', ') })}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <span id="doa-file-label" className="font-medium text-ink">
          {t('import.file')}
        </span>
        {/* Our own button and file-name text instead of the browser's, which follows the browser language (§9.9) */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex h-11 cursor-pointer items-center rounded-md border border-input bg-bg px-4 font-medium text-ink hover:bg-surface has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary">
            {t('import.chooseFile')}
            <input
              id="doa-file"
              name="file"
              type="file"
              accept=".yaml,.yml,application/yaml,text/yaml"
              aria-labelledby="doa-file-label"
              aria-invalid={errors.file ? true : undefined}
              aria-describedby={errors.file ? 'doa-file-error' : 'doa-file-name'}
              onChange={(event) => setFileName(event.currentTarget.files?.[0]?.name ?? null)}
              className="sr-only"
            />
          </label>
          <span id="doa-file-name" className="min-w-0 break-all text-ink-muted">
            {fileName ?? t('import.noFileChosen')}
          </span>
        </div>
        {errors.file ? (
          <p id="doa-file-error" className="flex items-start gap-1.5 text-base text-danger md:text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{errors.file}</span>
          </p>
        ) : null}
      </div>
      <Field id="doa-reason" name="reason" required maxLength={REASON_MAX_LENGTH} label={t('import.reason')} hint={t('import.reasonHint')} error={errors.reason} />
      <Button type="submit" disabled={action.pending} className="self-start">
        {action.pending ? t('import.submitting') : t('import.submit')}
      </Button>
    </form>
  )
}
