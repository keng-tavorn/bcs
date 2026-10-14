'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useRef, useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import type { AdminFailure } from './outcome'

export type CreateSandboxOutcome = { readonly ok: true; readonly sandboxOrganizationId: string; readonly code: string } | AdminFailure
export type CreateSandboxAction = (input: { organizationId: string; code: string; contractRef: string; reason: string }, idempotencyKey: string) => Promise<CreateSandboxOutcome>

/** The code a sandbox may take (src/server/services/platform/sandbox.ts SandboxInput), checked here only to say so early */
export const SANDBOX_CODE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/

type SandboxField = 'code' | 'contractRef' | 'reason'
type ErrorKey = 'CODE' | 'CODE_TAKEN' | 'NOT_PRODUCTION' | 'CONTRACT_REF' | 'REASON' | 'INPUT' | 'FORBIDDEN' | 'NOT_FOUND' | 'UNAUTHENTICATED' | 'INTERNAL' | 'FAILED'

/** Where a refusal of the sandbox command shows and with which words (§9.9 rule 7: what happened and how to fix it) */
export function sandboxErrorOf(f: AdminFailure): { field: SandboxField | null; key: ErrorKey } {
  if (f.code === 'VALIDATION_FAILED' && f.reason === 'CODE_TAKEN') return { field: 'code', key: 'CODE_TAKEN' }
  if (f.code === 'VALIDATION_FAILED' && f.reason === 'NOT_PRODUCTION') return { field: null, key: 'NOT_PRODUCTION' }
  if (f.code === 'VALIDATION_FAILED' && f.field === 'code') return { field: 'code', key: 'CODE' }
  if (f.code === 'VALIDATION_FAILED' && f.field === 'contractRef') return { field: 'contractRef', key: 'CONTRACT_REF' }
  if (f.code === 'VALIDATION_FAILED' && f.field === 'reason') return { field: 'reason', key: 'REASON' }
  if (f.code === 'VALIDATION_FAILED') return { field: null, key: 'INPUT' }
  if (f.code === 'FORBIDDEN') return { field: null, key: 'FORBIDDEN' }
  if (f.code === 'NOT_FOUND') return { field: null, key: 'NOT_FOUND' }
  if (f.code === 'UNAUTHENTICATED') return { field: null, key: 'UNAUTHENTICATED' }
  if (f.code === 'INTERNAL') return { field: null, key: 'INTERNAL' }
  return { field: null, key: 'FAILED' }
}

// "สร้างระบบทดลอง (UAT sandbox)" on the BCS team's page of a production customer (FR-PLT-101 AC1, BR-UAT-01 BR-UAT-04):
// the sandbox's code, the contract it is made under and a reason, every time. The form has no way to ask for a copy of
// anything (NG-12): the page says so above it. After it is made the confirmation names the sandbox and links its page.
export function SandboxForm({ organizationId, example, createSandbox }: { organizationId: string; example: string; createSandbox: CreateSandboxAction }) {
  const t = useTranslations('platform.tenant.sandbox')
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<SandboxField, string>>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<{ id: string; code: string } | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const code = String(form.get('code') ?? '').trim()
    const contractRef = String(form.get('contractRef') ?? '').trim()
    const reason = String(form.get('reason') ?? '').trim()
    const next: Partial<Record<SandboxField, string>> = {}
    if (!SANDBOX_CODE.test(code)) next.code = t('errors.CODE')
    if (!contractRef) next.contractRef = t('errors.CONTRACT_REF')
    if (reason.length < 3) next.reason = t('errors.REASON')
    setErrors(next)
    setFailure(null)
    setDone(null)
    if (Object.keys(next).length) return
    setPending(true)
    let outcome: CreateSandboxOutcome | null = null
    try {
      outcome = await createSandbox({ organizationId, code, contractRef, reason }, submission.key)
    } catch {
      outcome = null
    }
    setPending(false)
    // No answer: the same key goes with a retry, so one sandbox is made
    if (!outcome) return setFailure(t('errors.FAILED'))
    submission.next()
    if (!outcome.ok) {
      const { field, key } = sandboxErrorOf(outcome)
      const text = t(`errors.${key}`, { requestId: outcome.requestId ?? '-' })
      return field ? setErrors({ [field]: text }) : setFailure(text)
    }
    setDone({ id: outcome.sandboxOrganizationId, code: outcome.code })
    formRef.current?.reset()
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-4">
      {done ? (
        <Notice tone="success">
          <p>{t('created', { code: done.code })}</p>
          <Link href={`/platform/tenants/${done.id}`} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
            {t('openCreated', { code: done.code })}
          </Link>
        </Notice>
      ) : null}
      <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {failure ? <Notice tone="danger">{failure}</Notice> : null}
        <Field id="sandbox-code" name="code" required autoCapitalize="characters" spellCheck={false} label={t('code')} hint={t('codeHint', { example })} error={errors.code} />
        <Field id="sandbox-contract" name="contractRef" required label={t('contractRef')} error={errors.contractRef} />
        <Field id="sandbox-reason" name="reason" required label={t('reason')} error={errors.reason} />
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? t('pending') : t('submit')}
        </Button>
      </form>
    </div>
  )
}
