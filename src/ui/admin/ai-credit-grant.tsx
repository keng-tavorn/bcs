'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useRef, useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import type { AdminFailure, AdminOutcome } from './outcome'

export type GrantCreditsAction = (
  input: { organizationId: string; topUpCredits?: number; monthlyCredits?: number; contractRef: string; reason: string },
  idempotencyKey: string,
) => Promise<AdminOutcome>

const WHOLE = /^\d{1,9}$/

// The BCS team gives a customer AI credits (BR-AI-23, docs/sub-specs/S13.md "หน้าจอ"): credits for this month now,
// a new monthly amount from the next grant, or both — with a contract reference and a reason every time.
export function AiCreditGrant({ organizationId, grant }: { organizationId: string; grant: GrantCreditsAction }) {
  const t = useTranslations('platform.ai')
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<{ amounts?: string; contractRef?: string; reason?: string }>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  function explain(f: AdminFailure): string {
    if (f.code === 'FORBIDDEN') return t('errors.FORBIDDEN')
    if (f.code === 'UNAUTHENTICATED') return t('errors.UNAUTHENTICATED')
    if (f.code === 'VALIDATION_FAILED') return t('errors.INPUT')
    if (f.code === 'INTERNAL') return t('errors.INTERNAL', { requestId: f.requestId ?? '-' })
    return t('errors.FAILED')
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const text = (k: string) => String(form.get(k) ?? '').trim()
    const topUp = text('topUpCredits')
    const monthly = text('monthlyCredits')
    const contractRef = text('contractRef')
    const reason = text('reason')
    const next: typeof errors = {}
    if ((!topUp && !monthly) || (topUp && (!WHOLE.test(topUp) || Number(topUp) < 1)) || (monthly && (!WHOLE.test(monthly) || Number(monthly) < 1))) next.amounts = t('errors.AMOUNTS')
    if (!contractRef) next.contractRef = t('errors.CONTRACT_REF')
    if (reason.length < 3) next.reason = t('errors.REASON')
    setErrors(next)
    setFailure(null)
    setDone(null)
    if (Object.keys(next).length) return
    setPending(true)
    const outcome = await grant(
      { organizationId, ...(topUp ? { topUpCredits: Number(topUp) } : {}), ...(monthly ? { monthlyCredits: Number(monthly) } : {}), contractRef, reason },
      submission.key,
    )
    setPending(false)
    submission.next()
    if (!outcome.ok) return setFailure(explain(outcome))
    setDone(t('granted'))
    formRef.current?.reset()
    router.refresh()
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      {done ? <Notice tone="success">{done}</Notice> : null}
      <Field id="ai-topup" name="topUpCredits" inputMode="numeric" label={t('topUp')} hint={t('topUpHint')} error={errors.amounts} />
      <Field id="ai-monthly" name="monthlyCredits" inputMode="numeric" label={t('monthly')} hint={t('monthlyHint')} />
      <Field id="ai-contract" name="contractRef" required label={t('contractRef')} error={errors.contractRef} />
      <Field id="ai-reason" name="reason" required label={t('reason')} error={errors.reason} />
      <Button type="submit" disabled={pending} className="self-start">
        {t('submit')}
      </Button>
    </form>
  )
}
