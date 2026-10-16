'use client'

import { CircleCheck, CircleX } from 'lucide-react'
import { useId, useState } from 'react'
import { nameIn, type Named } from '../admin-org/names'
import { failureKey } from '../admin-org/outcome'
import { errorValues, useAction } from '../admin-org/use-action'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../shadcn/alert-dialog'
import { WORKFLOW_REASONS, type WorkflowFailure, type WorkflowIssue } from './outcome'
import type { WorkflowWords } from './words'

// The lint and the send of a draft (FR-WF-103 AC2 AC3, BR-WF-11 BR-WF-12): the lint's errors, which stop the send; its
// warnings, each ticked on its own; the test cases that do not pass; whether the dry-run ran on the latest save. The
// send is pressed only when all of that holds — otherwise the panel says what is missing — and is confirmed in an
// Alert Dialog naming who will approve it. The service checks everything again and its refusal is said in words with
// what to do (§9.9 rule 7). The approver decides with a step-up, on the web, never the sender.

export type SubmitWorkflowResult = { readonly ok: true; readonly assigneeMemberId: string } | WorkflowFailure
export type SubmitWorkflowAction = (versionId: string, acknowledgedWarnings: readonly string[], idempotencyKey: string) => Promise<SubmitWorkflowResult>

export interface SubmitPanelProps {
  readonly versionId: string
  readonly draftName: string
  readonly errors: readonly WorkflowIssue[]
  readonly warnings: ReadonlyArray<WorkflowIssue & { readonly key: string }>
  readonly testCasesFailing: readonly string[]
  readonly dryRunDone: boolean
  /** Unsaved changes: save first */
  readonly unsaved: boolean
  readonly effectiveInPast: boolean
  readonly laterVersionScheduled: number | null
  /** admin.workflow.submitForPublish */
  readonly allowed: boolean
  readonly approver: { readonly ref: string; readonly approvers: ReadonlyArray<Named & { readonly id: string }> } | { readonly error: string }
  readonly words: WorkflowWords
  readonly submit: SubmitWorkflowAction
}

/** One lint issue as a sentence with its code (BR-WF-11) */
export function issueText(words: WorkflowWords, issue: WorkflowIssue): string {
  const { t } = words
  const known = ['WF_LINT_UNKNOWN_REQUEST_TYPE', 'WF_LINT_UNKNOWN_FIELD', 'WF_LINT_DUPLICATE_CODE', 'WF_LINT_QUORUM_INVALID', 'WF_LINT_VACANT_REVIEWER', 'WF_LINT_NO_FALLBACK', 'WF_LINT_MEMBER_REVIEWER'] as const
  const code = (known as readonly string[]).includes(issue.code) ? (issue.code as (typeof known)[number]) : null
  const sentence = code ? t(`lint.${code}`, { rule: issue.rule, type: issue.requestType ?? '', field: issue.field ? words.field(issue.field) : '' }) : t('lint.OTHER', { rule: issue.rule })
  return t('lint.withCode', { sentence, code: issue.code })
}

export function SubmitPanel(props: SubmitPanelProps) {
  const { words, warnings: initialWarnings } = props
  const { t, locale } = words
  const id = useId()
  const action = useAction()
  const [warnings, setWarnings] = useState(initialWarnings)
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<{ readonly message: string; readonly issues?: readonly WorkflowIssue[]; readonly cases?: readonly string[] } | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  const requirements = [
    { key: 'saved', met: !props.unsaved, text: props.unsaved ? t('submit.needSave') : t('submit.saved') },
    { key: 'dryRun', met: props.dryRunDone && !props.unsaved, text: props.dryRunDone && !props.unsaved ? t('submit.dryRunDone') : t('submit.needDryRun') },
    { key: 'lint', met: props.errors.length === 0, text: props.errors.length ? t('submit.lintErrors', { count: props.errors.length }) : t('submit.lintClean') },
    { key: 'tests', met: props.testCasesFailing.length === 0, text: props.testCasesFailing.length ? t('submit.testsFailing', { names: props.testCasesFailing.join(', ') }) : t('submit.testsPass') },
    ...(props.effectiveInPast ? [{ key: 'date', met: false, text: t('submit.effectiveInPast') }] : []),
    ...(props.laterVersionScheduled !== null ? [{ key: 'later', met: false, text: t('submit.laterScheduled', { version: props.laterVersionScheduled }) }] : []),
    ...(props.allowed ? [] : [{ key: 'allowed', met: false, text: t('submit.notAllowed') }]),
  ]
  const ready = requirements.every((r) => r.met)
  const approverNames = 'error' in props.approver ? '' : props.approver.approvers.map((a) => nameIn(locale, a)).join(', ')

  function open() {
    setFailure(null)
    const missing = warnings.filter((w) => !ticked.has(w.key))
    if (missing.length) return setFailure({ message: t('errors.WARNINGS_NOT_ACKNOWLEDGED') })
    setConfirming(true)
  }

  async function send() {
    const outcome = await action.run((key) => props.submit(props.versionId, [...ticked], key))
    setConfirming(false)
    if (outcome.ok) {
      const approver = 'error' in props.approver ? undefined : props.approver.approvers.find((a) => a.id === outcome.assigneeMemberId)
      setSent(approver ? t('submit.sent', { name: nameIn(locale, approver) }) : t('submit.sentNoName'))
      action.done()
      return
    }
    if (outcome.reason === 'WARNINGS_NOT_ACKNOWLEDGED' && outcome.warnings?.length) {
      // The lint found other warnings than the page showed: list those to tick
      const keys = outcome.warnings
      setWarnings(keys.map((key) => warnings.find((w) => w.key === key) ?? { key, code: key.split(':')[0] ?? key, rule: key.split(':').slice(1).join(':') }))
      setTicked(new Set([...ticked].filter((k) => keys.includes(k))))
    }
    const refusal: WorkflowFailure = outcome
    const key = failureKey(refusal, WORKFLOW_REASONS)
    setFailure({ message: t(`errors.${key}`, errorValues(refusal)), ...(refusal.lintErrors ? { issues: refusal.lintErrors } : {}), ...(refusal.testCases ? { cases: refusal.testCases } : {}) })
  }

  if (sent) return <Notice tone="success">{sent}</Notice>

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby={`${id}-errors`} className="flex flex-col gap-2">
        <h4 id={`${id}-errors`} className="font-semibold">
          {t('submit.errorsTitle')}
        </h4>
        {props.errors.length ? (
          <Notice tone="danger" role="status">
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {props.errors.map((e, i) => (
                <li key={`${e.code}-${e.rule}-${i}`}>{issueText(words, e)}</li>
              ))}
            </ul>
          </Notice>
        ) : (
          <p className="flex items-center gap-2">
            <CircleCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
            {t('submit.noErrors')}
          </p>
        )}
      </section>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-semibold">{t('submit.warningsTitle')}</legend>
        {warnings.length ? (
          <>
            <p className="text-base text-ink-muted md:text-sm">{t('submit.warningsHint')}</p>
            {warnings.map((w) => (
              <label key={w.key} className="flex min-h-11 items-start gap-3 py-1">
                <input
                  type="checkbox"
                  checked={ticked.has(w.key)}
                  disabled={!props.allowed}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked
                    setTicked((s) => {
                      const next = new Set(s)
                      if (checked) next.add(w.key)
                      else next.delete(w.key)
                      return next
                    })
                  }}
                  className="mt-1 size-5 shrink-0"
                />
                <span>{issueText(words, w)}</span>
              </label>
            ))}
          </>
        ) : (
          <p className="text-ink-muted">{t('submit.noWarnings')}</p>
        )}
      </fieldset>

      <section aria-labelledby={`${id}-ready`} className="flex flex-col gap-2">
        <h4 id={`${id}-ready`} className="font-semibold">
          {t('submit.readyTitle')}
        </h4>
        <ul className="flex flex-col gap-1">
          {requirements.map((r) => (
            <li key={r.key} className="flex items-start gap-2">
              {r.met ? <CircleCheck className="mt-1 size-4 shrink-0 text-primary" aria-hidden="true" /> : <CircleX className="mt-1 size-4 shrink-0 text-danger" aria-hidden="true" />}
              <span>
                <span className="sr-only">{r.met ? t('submit.met') : t('submit.notMet')} </span>
                {r.text}
              </span>
            </li>
          ))}
        </ul>
        {'error' in props.approver ? (
          <Notice tone="warning">{t('submit.approverError')}</Notice>
        ) : (
          <p>{t('submit.approverLine', { names: approverNames, ref: props.approver.ref })}</p>
        )}
      </section>

      {failure ? (
        <Notice tone="danger">
          <p>{failure.message}</p>
          {failure.issues?.length ? (
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
              {failure.issues.map((e, i) => (
                <li key={`${e.code}-${i}`}>{issueText(words, e)}</li>
              ))}
            </ul>
          ) : null}
          {failure.cases?.length ? <p className="mt-2">{t('submit.casesNamed', { names: failure.cases.join(', ') })}</p> : null}
        </Notice>
      ) : null}

      <Button onClick={open} disabled={!ready || action.pending} className="self-start">
        {t('submit.button')}
      </Button>

      <AlertDialog open={confirming} onOpenChange={(next) => (next ? null : setConfirming(false))}>
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold text-ink">{t('submit.confirmTitle', { name: props.draftName })}</AlertDialogTitle>
            <AlertDialogDescription className="text-base text-ink-muted">
              {'error' in props.approver ? t('submit.confirmTextNoName') : t('submit.confirmText', { names: approverNames, ref: props.approver.ref })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-3">
            <AlertDialogCancel className="h-11 px-4 text-base" disabled={action.pending}>
              {t('submit.cancel')}
            </AlertDialogCancel>
            <Button onClick={() => void send()} disabled={action.pending} aria-busy={action.pending || undefined}>
              {action.pending ? t('submit.sending') : t('submit.button')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
