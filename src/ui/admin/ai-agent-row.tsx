'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState, type FormEvent } from 'react'
import { Switch } from '../shadcn/switch'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import type { AdminFailure, AdminOutcome } from './outcome'

export type UpdateAgentAction = (input: { agent: string; enabled?: boolean; minConfidenceBp?: number; expectedVersion?: number }, idempotencyKey: string) => Promise<AdminOutcome>

const BP_PER_PERCENT = 100

// One AI agent at /admin/ai (docs/sub-specs/S13.md "หน้าจอ", BR-AI-24, OQ-147): a switch that takes effect for new
// calls at once, and the confidence below which a field is confirmed one by one, in whole percent. The service checks
// admin.ai.manage and the version shown; a refusal is explained in words.
export function AiAgentRow({
  agent,
  name,
  description,
  enabled,
  minConfidenceBp,
  version,
  update,
}: {
  agent: string
  name: string
  description: string
  enabled: boolean
  minConfidenceBp: number
  /** -1 when the agent has no setting yet */
  version: number
  update: UpdateAgentAction
}) {
  const t = useTranslations('admin.ai')
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)

  function explain(f: AdminFailure): string {
    if (f.code === 'CONFLICT_VERSION') return t('errors.CONFLICT_VERSION')
    if (f.code === 'FORBIDDEN') return t('errors.FORBIDDEN')
    if (f.code === 'UNAUTHENTICATED') return t('errors.UNAUTHENTICATED')
    if (f.code === 'VALIDATION_FAILED' && f.reason === 'NO_CHANGE') return t('errors.NO_CHANGE')
    if (f.code === 'INTERNAL') return t('errors.INTERNAL', { requestId: f.requestId ?? '-' })
    return t('errors.FAILED')
  }

  async function send(input: { enabled?: boolean; minConfidenceBp?: number }, message: string) {
    setPending(true)
    setFailure(null)
    setDone(null)
    const outcome = await update({ agent, ...input, ...(version >= 0 ? { expectedVersion: version } : {}) }, submission.key)
    setPending(false)
    submission.next()
    if (!outcome.ok) return setFailure(explain(outcome))
    setDone(message)
    router.refresh()
  }

  async function onConfidence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const raw = String(new FormData(event.currentTarget).get('confidence') ?? '').trim()
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > 100) return setFieldError(t('errors.CONFIDENCE'))
    setFieldError(null)
    await send({ minConfidenceBp: Number(raw) * BP_PER_PERCENT }, t('savedConfidence', { name }))
  }

  const switchId = `ai-${agent}-enabled`
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <label htmlFor={switchId} className="font-medium">
            {name}
          </label>
          <p className="text-base text-ink-muted md:text-sm">{description}</p>
        </div>
        <div className="flex min-h-11 items-center gap-2">
          <span className="text-base text-ink-muted md:text-sm" aria-hidden>
            {enabled ? t('on') : t('off')}
          </span>
          <Switch
            id={switchId}
            checked={enabled}
            disabled={pending}
            onCheckedChange={(next) => send({ enabled: next }, next ? t('switchedOn', { name }) : t('switchedOff', { name }))}
          />
        </div>
      </div>
      <form onSubmit={onConfidence} className="flex flex-col gap-2 sm:flex-row sm:items-end" noValidate>
        <div className="sm:w-96">
          <Field
            id={`ai-${agent}-confidence`}
            name="confidence"
            inputMode="numeric"
            defaultValue={String(minConfidenceBp / BP_PER_PERCENT)}
            label={t('confidence')}
            hint={t('confidenceHint')}
            error={fieldError}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={pending} className="self-start sm:self-end">
          {t('saveConfidence')}
        </Button>
      </form>
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      {done ? (
        <Notice tone="success" role="status">
          {done}
        </Notice>
      ) : null}
    </li>
  )
}
