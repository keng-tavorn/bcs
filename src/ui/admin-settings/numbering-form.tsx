'use client'

import { CircleAlert, CircleCheck, Info } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { cn } from '../cn'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import {
  DEPT_TOKEN,
  NUMBER_RESETS,
  SEQ_EXAMPLE,
  type NumberDocument,
  type NumberPreviewView,
  type NumberReset,
  type PreviewNumberingAction,
  type SaveNumberingAction,
} from './numbering'
import { commonErrorKey, settle, type NumberingRefusalView } from './outcome'

/** Wait this long after the last keystroke before asking for a new example */
const PREVIEW_DELAY_MS = 300

/** The message of a refusal in the reader's language; `documentName` names the other document of an overlap. */
function useRefusalText(): (refusal: NumberingRefusalView, documentName: (code: string) => string) => string {
  const t = useTranslations('adminSettings.numbering.refusals')
  return (refusal, documentName) => {
    switch (refusal.reason) {
      case 'UNKNOWN_TOKEN':
        return t('UNKNOWN_TOKEN', { tokens: (refusal.tokens ?? []).join(' ') })
      case 'SEQ_MISSING':
        return t('SEQ_MISSING', { example: SEQ_EXAMPLE })
      case 'SEQ_WIDTH':
        return t('SEQ_WIDTH', { example: SEQ_EXAMPLE })
      case 'NUMBER_COLLISION':
        return t('NUMBER_COLLISION', { example: refusal.example ?? '' })
      case 'OVERLAPS_OTHER_DOCUMENT':
        return t('OVERLAPS_OTHER_DOCUMENT', { other: documentName(refusal.other ?? ''), example: refusal.example ?? '' })
      default:
        return t(refusal.reason)
    }
  }
}

// The rule of one numbered document (FR-ADM-004): pattern and reset period, with the next number it would issue shown
// while the admin types, before anything is saved (AC1). A pattern the server refuses (AC2–AC3) is explained under the
// field, the same way the save is refused.
export function NumberingForm({
  document,
  initial,
  departments,
  documentNames,
  preview,
  save,
}: {
  document: NumberDocument
  initial: { pattern: string; reset: NumberReset; department: string | null } & NumberPreviewView
  departments: readonly string[]
  documentNames: Readonly<Record<string, string>>
  preview: PreviewNumberingAction
  save: SaveNumberingAction
}) {
  const t = useTranslations('adminSettings.numbering')
  const tCommon = useTranslations('adminSettings')
  const refusalText = useRefusalText()
  const id = useId()
  const submission = useSubmissionKey()
  const [pattern, setPattern] = useState(initial.pattern)
  const [reset, setReset] = useState<NumberReset>(initial.reset)
  const [department, setDepartment] = useState(initial.department ?? departments[0] ?? '')
  const [answered, setAnswered] = useState<{ key: string; preview: NumberPreviewView | null } | null>(null)
  const [pending, setPending] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const latest = useRef(0)
  const documentName = (code: string) => documentNames[code] ?? code
  const hasDept = pattern.includes(DEPT_TOKEN)
  // The stored rule needs no question: the page already knows its next number
  const unchanged = pattern === initial.pattern && reset === initial.reset && (!hasDept || department === (initial.department ?? department))
  const askedFor = `${pattern}\u0000${reset}\u0000${hasDept ? department : ''}`

  // AC1: a new example shortly after each change; only the answer to the latest change counts. No answer (the network
  // dropped) says the example is not available rather than checking forever
  useEffect(() => {
    if (unchanged) return
    const ticket = ++latest.current
    const timer = setTimeout(async () => {
      const answer = await settle(preview({ document, pattern: pattern.trim() || pattern, reset, ...(hasDept && department ? { department } : {}) }))
      if (ticket === latest.current) setAnswered({ key: askedFor, preview: answer?.ok ? answer.preview : null })
    }, PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [unchanged, askedFor, pattern, reset, department, hasDept, document, preview])

  const checking = !unchanged && answered?.key !== askedFor
  const example: NumberPreviewView | null = unchanged ? initial : answered?.key === askedFor ? answered.preview : null

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setResult(null)
    setFieldError(null)
    const trimmed = pattern.trim()
    if (!trimmed) return setFieldError(t('refusals.SEQ_MISSING', { example: SEQ_EXAMPLE }))
    setPending(true)
    const outcome = await settle(save({ document, pattern: trimmed, reset }, submission.key))
    setPending(false)
    // No answer: the same key goes with a retry (the save runs at most once)
    if (!outcome) return setResult({ tone: 'danger', text: tCommon('errors.FAILED') })
    submission.next()
    if (outcome.ok) return setResult({ tone: 'success', text: t('saved', { document }) })
    if (outcome.refusal) return setFieldError(refusalText(outcome.refusal, documentName))
    setResult({ tone: 'danger', text: tCommon(`errors.${commonErrorKey(outcome)}`, { requestId: outcome.requestId ?? '-' }) })
  }

  const refusal = checking ? null : (example?.refusal ?? null)
  // Why a rule cannot be saved is said once, under the field: the save's answer, else the check made while typing
  const shownError = fieldError ?? (refusal ? refusalText(refusal, documentName) : null)
  // The stored rule's next number is already on the page; the box appears once the admin edits (or to explain a refusal)
  const showPreview = !unchanged || initial.refusal !== null
  // Saving is the main action only for a change the last check did not refuse; while a new check runs the button keeps
  // the look of the last answer, so it does not flicker with every keystroke
  const refusedSoFar = fieldError !== null || (checking ? Boolean(answered?.preview?.refusal) : refusal !== null)
  const saveLooksMain = !unchanged && !refusedSoFar

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <Field
          id={`${id}-pattern`}
          name="pattern"
          label={t('pattern')}
          value={pattern}
          maxLength={100}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(event) => {
            setPattern(event.currentTarget.value)
            setFieldError(null)
          }}
          hint={t('patternHint', { example: initial.pattern })}
          error={shownError ?? undefined}
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-reset`} className="font-medium text-ink">
            {t('reset')}
          </label>
          <select
            id={`${id}-reset`}
            name="reset"
            value={reset}
            onChange={(event) => {
              setReset(event.currentTarget.value as NumberReset)
              setFieldError(null)
            }}
            className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink"
          >
            {NUMBER_RESETS.map((r) => (
              <option key={r} value={r}>
                {t(`resets.${r}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {hasDept && departments.length ? (
        <div className="flex flex-col gap-1.5 sm:max-w-xs">
          <label htmlFor={`${id}-department`} className="font-medium text-ink">
            {t('department')}
          </label>
          <select
            id={`${id}-department`}
            name="department"
            value={department}
            onChange={(event) => setDepartment(event.currentTarget.value)}
            className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink"
          >
            {departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {/* The live region stays in the page so what it says after an edit is announced */}
      <div
        id={`${id}-preview`}
        role="status"
        aria-live="polite"
        className={showPreview ? cn('flex flex-col gap-1 border-l-4 bg-surface px-3 py-2.5', shownError ? 'border-danger' : 'border-info') : 'sr-only'}
      >
        {!showPreview ? null : checking ? (
          <p>{t('previewChecking')}</p>
        ) : shownError ? (
          <p className="flex items-start gap-1.5">
            <CircleAlert className="mt-1 size-4 shrink-0 text-danger" aria-hidden="true" />
            <span>{t('previewRefused')}</span>
          </p>
        ) : example?.nextNumber ? (
          <>
            <p className="text-base text-ink-muted md:text-sm">{t('previewTitle')}</p>
            <p className="tabular text-lg font-semibold break-all">{example.nextNumber}</p>
            <p className="flex items-start gap-1.5 text-base md:text-sm">
              {example.continues ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /> : <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />}
              <span>
                {example.continues ? t('previewContinues') : t('previewNew')}
                {example.department ? ` · ${t('nextFor', { department: example.department })}` : ''}
              </span>
            </p>
          </>
        ) : (
          <p>{t('previewUnavailable')}</p>
        )}
      </div>

      {/* The look changes at once (no fade in between); the server refuses a refused pattern again either way */}
      <Button type="submit" variant={saveLooksMain ? 'primary' : 'secondary'} disabled={pending} className="self-start transition-none">
        {pending ? t('saving') : t('save', { document })}
      </Button>
    </form>
  )
}
