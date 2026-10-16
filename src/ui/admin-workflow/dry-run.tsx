'use client'

import { CircleCheck, PenLine } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { departmentOption } from '../admin-org/names'
import { failureKey, type ActionFailure } from '../admin-org/outcome'
import { SelectField } from '../admin-org/select-field'
import { errorValues, useAction } from '../admin-org/use-action'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { DocumentFields } from './document-fields'
import { canonical, documentDraftOf, documentOf, type DocumentDraft, type DocumentField, type DocumentValue } from './model'
import { WORKFLOW_REASONS } from './outcome'
import type { WorkflowContext, WorkflowWords } from './words'

// The dry-run (FR-WF-103 AC2): one document — type, amount, categories, budget lines, form answers, requester and the
// department charged — through the real engine, the whole route (reviewers, then the DOA) of the version in effect
// beside the draft's, and what differs marked in words and an icon, never colour alone. Running it on a draft records
// that the dry-run ran on the latest save, which the send needs; it changes nothing else.

export interface DryRunSideView {
  readonly ok: boolean
  readonly review: ReadonlyArray<{ readonly ruleCodes: readonly string[]; readonly memberIds: readonly string[] }> | null
  readonly approval: { readonly ruleCode: string; readonly memberIds: readonly string[] } | null
  readonly error: { readonly code: string; readonly details?: Readonly<Record<string, unknown>> } | null
}

export interface DryRunRowView {
  readonly current: DryRunSideView
  readonly draft: DryRunSideView
  readonly changed: boolean
}

export type DryRunResult = { readonly ok: true; readonly rows: readonly DryRunRowView[] } | ActionFailure
export type DryRunAction = (input: { versionId: string; documents: ReadonlyArray<DocumentValue & { requesterMemberId: string; chargedDepartmentId: string }> }, idempotencyKey: string) => Promise<DryRunResult>

export interface DryRunProps {
  readonly versionId: string
  /** "WF-SIMEC ฉบับ 2" */
  readonly draftName: string
  /** The version in effect it is read beside, or null when none is */
  readonly currentName: string | null
  /** Why it cannot run now (unsaved changes), or null */
  readonly blocked: string | null
  readonly defaults: { readonly requesterMemberId: string | null; readonly chargedDepartmentId: string | null }
  readonly context: WorkflowContext
  readonly words: WorkflowWords
  readonly categoryCodes: readonly string[]
  readonly accountCodes: readonly string[]
  readonly run: DryRunAction
}

const SIDE_ERRORS = ['REVIEWER_NOT_FOUND', 'NO_HIGHER_AUTHORITY', 'APPROVER_NOT_FOUND', 'DOA_NOT_CONFIGURED', 'DOA_AMBIGUOUS'] as const

export function DryRun({ versionId, draftName, currentName, blocked, defaults, context, words, categoryCodes, accountCodes, run }: DryRunProps) {
  const { t, locale } = words
  const id = useId()
  const action = useAction()
  const [document, setDocument] = useState<DocumentDraft>(() => documentDraftOf(null, context.requestTypes[0]?.code ?? ''))
  const [requester, setRequester] = useState(defaults.requesterMemberId ?? '')
  const [department, setDepartment] = useState(defaults.chargedDepartmentId ?? '')
  const [errors, setErrors] = useState<{ document: Partial<Record<DocumentField, 'REQUIRED' | 'MONEY' | 'NET_ABOVE_GROSS'>>; requester?: string; department?: string }>({ document: {} })
  const [failure, setFailure] = useState<string | null>(null)
  const [result, setResult] = useState<DryRunRowView | null>(null)

  async function onRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    const doc = documentOf(document)
    const next = { document: doc.ok ? {} : doc.errors, requester: requester ? undefined : t('dryRun.requesterRequired'), department: department ? undefined : t('dryRun.departmentRequired') }
    setErrors(next)
    if (!doc.ok || next.requester || next.department) return
    const outcome = await action.run((key) => run({ versionId, documents: [{ ...doc.value, requesterMemberId: requester, chargedDepartmentId: department }] }, key))
    if (outcome.ok) {
      setResult(outcome.rows[0] ?? null)
      // The page learns that the dry-run ran on the latest draft (the send needs it)
      action.done()
      return
    }
    setFailure(t(`errors.${failureKey(outcome, WORKFLOW_REASONS)}`, errorValues(outcome)))
  }

  const sideError = (e: NonNullable<DryRunSideView['error']>) => ((SIDE_ERRORS as readonly string[]).includes(e.code) ? t(`dryRun.sideErrors.${e.code as (typeof SIDE_ERRORS)[number]}`) : t('dryRun.sideErrors.OTHER', { code: e.code }))
  const names = (ids: readonly string[]) => ids.map((m) => words.member(m)).join(', ')

  const side = (title: string, s: DryRunSideView, other: DryRunSideView | null) => {
    const reviewDiffers = other !== null && canonical(s.review) !== canonical(other.review)
    const approvalDiffers = other !== null && canonical(s.approval) !== canonical(other.approval)
    const differs = (yes: boolean) =>
      yes ? (
        <span className="inline-flex items-center gap-1 text-base font-normal text-ink md:text-sm">
          <PenLine className="size-3.5 shrink-0" aria-hidden="true" />
          {t('dryRun.differs')}
        </span>
      ) : null
    return (
      <section aria-label={title} className="flex min-w-0 flex-col gap-3 rounded-md border border-line p-3">
        <h4 className="font-semibold">{title}</h4>
        {s.error ? (
          <Notice tone="warning" role="status">
            {sideError(s.error)}
          </Notice>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <p className="flex flex-wrap items-center gap-x-2 font-medium">
                <span>{t('dryRun.review')}</span>
                {differs(reviewDiffers)}
              </p>
              {s.review && s.review.length ? (
                <ol className="flex list-decimal flex-col gap-1 pl-5">
                  {s.review.map((slot, i) => (
                    <li key={i}>{t('dryRun.slot', { rules: slot.ruleCodes.join(', '), names: names(slot.memberIds) })}</li>
                  ))}
                </ol>
              ) : (
                <p className="text-ink-muted">{t('dryRun.noReview')}</p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <p className="flex flex-wrap items-center gap-x-2 font-medium">
                <span>{t('dryRun.approval')}</span>
                {differs(approvalDiffers)}
              </p>
              {s.approval ? <p>{t('dryRun.approvalLine', { rule: s.approval.ruleCode, names: names(s.approval.memberIds) })}</p> : <p className="text-ink-muted">{t('dryRun.noApproval')}</p>}
            </div>
          </>
        )}
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-ink-muted">{t('dryRun.intro', { name: draftName })}</p>
      {blocked ? <Notice tone="warning">{blocked}</Notice> : null}
      <form onSubmit={onRun} className="flex flex-col gap-4" noValidate>
        <DocumentFields id={`${id}-doc`} draft={document} onChange={setDocument} errors={errors.document} context={context} words={words} categoryCodes={categoryCodes} accountCodes={accountCodes} />
        <div className="grid gap-4 md:grid-cols-2">
          <SelectField
            id={`${id}-requester`}
            label={t('dryRun.requester')}
            placeholder={t('choose')}
            value={requester}
            onChange={(ev) => {
              const memberId = ev.currentTarget.value
              setRequester(memberId)
              // The requester's own department is the usual one charged
              const home = context.members.find((m) => m.id === memberId)?.primaryDepartmentId
              const homeDepartment = home ? context.departments.find((d) => d.id === home) : undefined
              if (homeDepartment) setDepartment(homeDepartment.id)
            }}
            options={context.members.filter((m) => m.active).map((m) => ({ value: m.id, label: words.member(m.id) }))}
            error={errors.requester}
          />
          <SelectField
            id={`${id}-department`}
            label={t('dryRun.department')}
            placeholder={t('choose')}
            value={department}
            onChange={(ev) => setDepartment(ev.currentTarget.value)}
            options={context.departments.map((d) => ({ value: d.id, label: departmentOption(locale, d) }))}
            error={errors.department}
          />
        </div>
        {failure ? <Notice tone="danger">{failure}</Notice> : null}
        <Button type="submit" disabled={action.pending || blocked !== null} className="self-start">
          {action.pending ? t('dryRun.running') : t('dryRun.run')}
        </Button>
      </form>
      <div aria-live="polite" className="flex flex-col gap-3">
        {result ? (
          <>
            <p className="flex items-center gap-2 font-medium">
              {result.changed ? <PenLine className="size-4 shrink-0" aria-hidden="true" /> : <CircleCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />}
              {result.changed ? t('dryRun.changed') : t('dryRun.same')}
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {side(currentName ? t('dryRun.currentTitle', { name: currentName }) : t('dryRun.currentNone'), result.current, null)}
              {side(t('dryRun.draftTitle', { name: draftName }), result.draft, result.current)}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
