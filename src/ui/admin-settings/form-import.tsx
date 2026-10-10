'use client'

import { CircleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState, type ChangeEvent, type FormEvent } from 'react'
import { BYTES_PER_KIB } from '@/lib/constants'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import type { CheckFormAction, FormChangesView, FormCheckView, PublishFormAction } from './forms'
import { commonErrorKey, settle, type FormProblemView } from './outcome'

/** The same limit as the server's FORM_JSON_MAX_CHARS */
const MAX_FILE_BYTES = 200 * BYTES_PER_KIB

/** One problem of an imported form in the reader's language, with where it is in the JSON. */
function useProblemText(): (p: FormProblemView) => string {
  const t = useTranslations('adminSettings.forms.problems')
  return (p) => {
    switch (p.reason) {
      case 'EMPTY':
      case 'TOO_LARGE':
      case 'JSON_SYNTAX':
      case 'TOO_DEEP':
        return t(p.reason)
      case 'SCHEMA':
        return p.issue === 'UNKNOWN_KEY' ? t('schema.UNKNOWN_KEY', { path: p.path, keys: (p.keys ?? []).join(', ') }) : t(`schema.${p.issue}`, { path: p.path })
      case 'DUPLICATE_FIELD':
        return t('DUPLICATE_FIELD', { path: p.path, field: p.field })
      case 'DUPLICATE_RULE':
        return t('DUPLICATE_RULE', { path: p.path, rule: p.rule })
      case 'UNKNOWN_FIELD':
        return t('UNKNOWN_FIELD', { path: p.path, field: p.field })
      case 'UNKNOWN_ATTACHMENT':
        return t('UNKNOWN_ATTACHMENT', { path: p.path, attachment: p.attachment })
      case 'DUPLICATE_STEP':
        return t('DUPLICATE_STEP', { path: p.path, step: p.step })
      case 'RESERVED_STEP':
        return t('RESERVED_STEP', { path: p.path, step: p.step })
      case 'FIELD_IN_TWO_STEPS':
        return t('FIELD_IN_TWO_STEPS', { path: p.path, field: p.field })
    }
  }
}

function ChangeList({ changes }: { changes: FormChangesView }) {
  const t = useTranslations('adminSettings.forms.changes')
  const lines = [
    changes.addedFields.length ? t('addedFields', { list: changes.addedFields.join(', ') }) : null,
    changes.removedFields.length ? t('removedFields', { list: changes.removedFields.join(', ') }) : null,
    changes.changedFields.length ? t('changedFields', { list: changes.changedFields.join(', ') }) : null,
    changes.addedRules.length ? t('addedRules', { list: changes.addedRules.join(', ') }) : null,
    changes.removedRules.length ? t('removedRules', { list: changes.removedRules.join(', ') }) : null,
    changes.changedRules.length ? t('changedRules', { list: changes.changedRules.join(', ') }) : null,
    changes.visibilityChanged ? t('visibility') : null,
    changes.linesChanged ? t('lines') : null,
  ].filter((line): line is string => line !== null)
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5">
      {lines.map((line) => (
        <li key={line} className="break-words">
          {line}
        </li>
      ))}
    </ul>
  )
}

// Import a new version of a request type's form from JSON (FR-ADM-005 AC1). Two real steps: check (the server reads the
// JSON with the form schema and says each problem with its place, or what would change) and publish (a tick box first:
// a published version cannot be undone, and new requests use it at once). Editing the JSON after a check asks for a new
// check, so only checked text is ever published.
export function FormImport({ code, check, publish }: { code: string; check: CheckFormAction; publish: PublishFormAction }) {
  const t = useTranslations('adminSettings.forms')
  const tCommon = useTranslations('adminSettings')
  const problemText = useProblemText()
  const id = useId()
  const submission = useSubmissionKey()
  const [json, setJson] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [checked, setChecked] = useState<{ json: string; result: FormCheckView } | null>(null)
  const [pending, setPending] = useState<'check' | 'publish' | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const current = checked && checked.json === json ? checked.result : null

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    setNotice(null)
    if (!file) return
    if (file.size > MAX_FILE_BYTES) return setNotice({ tone: 'danger', text: t('errors.FILE_TOO_LARGE') })
    setFileName(file.name)
    setJson(await file.text())
  }

  async function onCheck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setNotice(null)
    setConfirmError(null)
    setPending('check')
    const answer = await settle(check(code, json))
    setPending(null)
    if (answer?.ok) return setChecked({ json, result: answer.check })
    setChecked(null)
    setNotice({ tone: 'danger', text: answer ? tCommon(`errors.${commonErrorKey(answer)}`, { requestId: answer.requestId ?? '-' }) : tCommon('errors.FAILED') })
  }

  async function onPublish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!current?.valid) return
    if (new FormData(event.currentTarget).get('confirm') !== 'yes') return setConfirmError(t('errors.CONFIRM'))
    setConfirmError(null)
    setNotice(null)
    setPending('publish')
    const outcome = await settle(publish({ code, json, basedOnVersionNo: current.basedOnVersionNo }, submission.key))
    setPending(null)
    // No answer: the same key goes with a retry, so the version is published at most once
    if (!outcome) return setNotice({ tone: 'danger', text: tCommon('errors.FAILED') })
    submission.next()
    if (outcome.ok) {
      setNotice({ tone: 'success', text: t('published', { version: outcome.versionNo ?? current.nextVersionNo }) })
      setJson('')
      setFileName(null)
      setChecked(null)
      return
    }
    if (outcome.code === 'CONFLICT_VERSION') return setNotice({ tone: 'danger', text: t('errors.CONFLICT_VERSION') })
    if (outcome.reason === 'NO_CHANGE') return setNotice({ tone: 'danger', text: t('errors.NO_CHANGE') })
    if (outcome.problems?.length) return setChecked({ json, result: { valid: false, problems: outcome.problems } })
    setNotice({ tone: 'danger', text: tCommon(`errors.${commonErrorKey(outcome)}`, { requestId: outcome.requestId ?? '-' }) })
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-ink-muted">{t('importIntro')}</p>
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      <form onSubmit={onCheck} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-json`} className="font-medium text-ink">
            {t('jsonLabel')}
          </label>
          <textarea
            id={`${id}-json`}
            name="json"
            rows={10}
            value={json}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setJson(event.currentTarget.value)}
            className="w-full rounded-md border border-input bg-bg px-3 py-2 text-base text-ink"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span id={`${id}-file-label`} className="font-medium text-ink">
            {t('jsonFile')}
          </span>
          {/* Our own button and file-name text instead of the browser's, which follows the browser language (§9.9) */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex h-11 cursor-pointer items-center rounded-md border border-input bg-bg px-4 font-medium text-ink hover:bg-surface has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary">
              {t('chooseFile')}
              <input
                type="file"
                accept=".json,application/json"
                aria-labelledby={`${id}-file-label`}
                aria-describedby={`${id}-file-name`}
                onChange={onFile}
                className="sr-only"
              />
            </label>
            <span id={`${id}-file-name`} className="min-w-0 break-all text-ink-muted">
              {fileName ?? t('noFileChosen')}
            </span>
          </div>
        </div>
        <Button type="submit" variant="secondary" disabled={pending !== null} className="self-start">
          {pending === 'check' ? t('checking') : t('check')}
        </Button>
      </form>

      {current && !current.valid ? (
        <Notice tone="danger">
          <p className="font-medium">{t('problemsTitle')}</p>
          <ul className="mt-2 flex flex-col gap-1">
            {current.problems.map((p, i) => (
              <li key={i} className="break-words">
                {problemText(p)}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {current?.valid && current.noChange ? <Notice tone="info">{t('noChange')}</Notice> : null}

      {current?.valid && !current.noChange ? (
        <form onSubmit={onPublish} className="flex flex-col gap-4 border-t border-line pt-4" noValidate>
          <Notice tone="success">
            <p className="font-medium">{t('checkOk', { version: current.nextVersionNo })}</p>
            <p>{t('summary', { fields: current.fields, rules: current.rules })}</p>
          </Notice>
          <div className="flex flex-col gap-2">
            <p className="font-medium">{t('changesTitle')}</p>
            <ChangeList changes={current.changes} />
          </div>
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
              <span>{t('confirm', { version: current.nextVersionNo })}</span>
            </label>
            {confirmError ? (
              <p id={`${id}-confirm-error`} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{confirmError}</span>
              </p>
            ) : null}
          </div>
          <Button type="submit" disabled={pending !== null} className="self-start">
            {pending === 'publish' ? t('publishing') : t('publish', { version: current.nextVersionNo })}
          </Button>
        </form>
      ) : null}
    </div>
  )
}
