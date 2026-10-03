'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { failureKey, type ActionFailure, type IssueView } from '../admin-org/outcome'
import { nameIn, type Named } from '../admin-org/names'
import { errorValues, useAction } from '../admin-org/use-action'
import { WarningText } from '../admin-org/warning-text'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { BoundaryConfirm } from './boundary-confirm'
import { boundaryRefusalAt, boundaryTickMissing, boundaryTickValue } from './boundary-tick'
import { DOA_REASONS } from './import-form'
import { LintIssueText } from './lint-issue'

// Sending a draft for publishing (FR-DOA-002 AC1–AC2, FR-DOA-009 AC3): every lint warning is ticked on its own, and
// the boundary table — when the page shows one — is ticked as checked, before sending; the service runs the full lint
// again and answers with what it still finds (DOA_LINT_FAILED, WARNINGS_NOT_ACKNOWLEDGED, BOUNDARY_NOT_CONFIRMED), which
// this form shows. The approver of the DOA_CHANGE rule decides, with a step-up, never the submitter.

export type SubmitDoaResult = { readonly ok: true; readonly assigneeMemberId: string } | ActionFailure
/** boundaryTableConfirmed: the drafter's tick, or null when the page showed no boundary table */
export type SubmitDoaAction = (versionId: string, acknowledged: readonly string[], boundaryTableConfirmed: boolean | null, idempotencyKey: string) => Promise<SubmitDoaResult>

export interface SubmitDoaPanelProps {
  readonly versionId: string
  readonly warnings: readonly string[]
  /** Who the page expects to approve, to name them once it is sent */
  readonly approvers: ReadonlyArray<Named & { readonly id: string }>
  /** The page shows a boundary table the drafter must tick as checked (FR-DOA-009 AC3); its section id to link to */
  readonly boundaryTableId: string | null
  readonly submit: SubmitDoaAction
}

export function SubmitDoaPanel({ versionId, warnings: initialWarnings, approvers, boundaryTableId, submit }: SubmitDoaPanelProps) {
  const t = useTranslations('adminDoa.detail')
  const tErrors = useTranslations('adminDoa')
  const locale = useLocale()
  const action = useAction()
  const [warnings, setWarnings] = useState<readonly string[]>(initialWarnings)
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [boundaryTicked, setBoundaryTicked] = useState(false)
  const [boundaryError, setBoundaryError] = useState<string | undefined>()
  const [errors, setErrors] = useState<readonly IssueView[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    setErrors([])
    const missingBoundary = boundaryTickMissing(boundaryTableId, boundaryTicked)
    setBoundaryError(missingBoundary ? tErrors('errors.BOUNDARY_NOT_CONFIRMED') : undefined)
    if (warnings.some((w) => !ticked.has(w))) return setFailure(tErrors('errors.WARNINGS_NOT_ACKNOWLEDGED'))
    if (missingBoundary) return
    const outcome = await action.run((key) => submit(versionId, [...ticked], boundaryTickValue(boundaryTableId, boundaryTicked), key))
    if (outcome.ok) {
      const approver = approvers.find((a) => a.id === outcome.assigneeMemberId)
      setSent(approver ? t('submitted', { name: nameIn(locale, approver) }) : t('submittedNoName'))
      action.done()
      return
    }
    if (outcome.code === 'DOA_LINT_FAILED' && outcome.errors?.length) {
      setErrors(outcome.errors)
      return setFailure(t('errorsTitle'))
    }
    if (outcome.reason === 'WARNINGS_NOT_ACKNOWLEDGED' && outcome.warnings?.length) {
      setWarnings(outcome.warnings)
      setTicked(new Set([...ticked].filter((w) => outcome.warnings!.includes(w))))
    }
    if (outcome.reason === 'BOUNDARY_NOT_CONFIRMED') {
      // No table on this page to tick: the version has one now (a version was approved since the page was opened)
      if (boundaryRefusalAt(boundaryTableId) === 'FORM') return setFailure(tErrors('errors.BOUNDARY_TABLE_CHANGED'))
      return setBoundaryError(tErrors('errors.BOUNDARY_NOT_CONFIRMED'))
    }
    setFailure(tErrors(`errors.${failureKey(outcome, DOA_REASONS)}`, errorValues(outcome)))
  }

  if (sent) return <Notice tone="success">{sent}</Notice>

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {failure ? (
        <Notice tone="danger">
          <p>{failure}</p>
          {errors.length ? (
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
              {errors.map((e, i) => (
                <li key={`${e.code}-${i}`}>
                  <LintIssueText issue={e} />
                </li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      {warnings.length ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-semibold">{t('warningsTitle')}</legend>
          <p className="text-base text-ink-muted md:text-sm">{t('warningsHint')}</p>
          {warnings.map((w) => (
            <label key={w} className="flex min-h-11 items-start gap-3 py-1">
              <input
                type="checkbox"
                checked={ticked.has(w)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked
                  setTicked((s) => {
                    const next = new Set(s)
                    if (checked) next.add(w)
                    else next.delete(w)
                    return next
                  })
                }}
                className="mt-1 size-5 shrink-0 accent-[var(--warn)]"
              />
              <WarningText warningKey={w} />
            </label>
          ))}
        </fieldset>
      ) : null}
      {boundaryTableId !== null ? (
        <BoundaryConfirm
          tableId={boundaryTableId}
          checked={boundaryTicked}
          onChange={(checked) => {
            setBoundaryTicked(checked)
            if (checked) setBoundaryError(undefined)
          }}
          error={boundaryError}
        />
      ) : null}
      <Button type="submit" disabled={action.pending} className="self-start">
        {action.pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
