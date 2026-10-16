'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { failureKey, type ActionFailure } from '../admin-org/outcome'
import { errorValues, useAction } from '../admin-org/use-action'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { WORKFLOW_REASONS } from './outcome'

// "สร้างร่าง" (FR-WF-103 AC1): a draft copied from the latest version of a code — or, for an organization's first
// workflow, an empty draft under a code it names — then the editor of the new draft. The press says what it makes;
// the service checks admin.workflow.draft and numbers the draft.

export type DraftWorkflowResult = { readonly ok: true; readonly versionId: string; readonly code: string; readonly versionNo: number } | ActionFailure
export type DraftWorkflowAction = (input: { sourceVersionId?: string; code?: string }, idempotencyKey: string) => Promise<DraftWorkflowResult>

export function CreateDraftButton({ sourceVersionId, label, draft }: { sourceVersionId: string; label: string; draft: DraftWorkflowAction }) {
  const t = useTranslations('adminWorkflow')
  const router = useRouter()
  const action = useAction()
  const [failure, setFailure] = useState<string | null>(null)
  async function onClick() {
    setFailure(null)
    const outcome = await action.run((key) => draft({ sourceVersionId }, key))
    if (outcome.ok) return router.push(`/admin/workflows/${outcome.versionId}`)
    setFailure(t(`errors.${failureKey(outcome, WORKFLOW_REASONS)}`, errorValues(outcome)))
  }
  return (
    <div className="flex flex-col gap-2">
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      <Button onClick={() => void onClick()} disabled={action.pending} className="self-start">
        {action.pending ? t('list.creating') : label}
      </Button>
    </div>
  )
}

const CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/

/** The organization's first workflow: an empty draft under the code it names */
export function CreateFirstDraft({ suggestedCode, draft }: { suggestedCode: string; draft: DraftWorkflowAction }) {
  const t = useTranslations('adminWorkflow')
  const id = useId()
  const router = useRouter()
  const action = useAction()
  const [code, setCode] = useState(suggestedCode)
  const [error, setError] = useState<string | undefined>()
  const [failure, setFailure] = useState<string | null>(null)
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFailure(null)
    const value = code.trim().toUpperCase()
    if (!CODE.test(value)) return setError(t('ruleErrors.CODE'))
    setError(undefined)
    const outcome = await action.run((key) => draft({ code: value }, key))
    if (outcome.ok) return router.push(`/admin/workflows/${outcome.versionId}`)
    setFailure(t(`errors.${failureKey(outcome, WORKFLOW_REASONS)}`, errorValues(outcome)))
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
      <Field id={`${id}-code`} label={t('list.firstCode')} hint={t('list.firstCodeHint')} value={code} maxLength={40} onChange={(ev) => setCode(ev.currentTarget.value.toUpperCase())} error={error} className="max-w-xs" />
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      <Button type="submit" disabled={action.pending} className="self-start">
        {action.pending ? t('list.creating') : t('list.createFirst', { code: code.trim().toUpperCase() || '-' })}
      </Button>
    </form>
  )
}
