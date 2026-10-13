'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useRef, useState, type FormEvent } from 'react'
import { DOC_TYPES, type DocType } from '../admin-doa/editor-model'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import type { AdminFailure, AdminOutcome } from './outcome'

export type SetModuleAction = (
  input: { organizationId: string; module: string; enabled: boolean; contractRef: string; reason: string },
  idempotencyKey: string,
) => Promise<AdminOutcome>

// Switch one module on or off for a customer (FR-ADM-006 AC1, §4.11): a contract reference and a reason every time.
// The form sits in a disclosure so the page stays a calm list; refusals explain which modules or documents block it.
// After a change the form closes and clears, and the confirmation stays outside it: the same form now does the
// opposite action, so it must never be left open with the old reference and reason.

const isDocType = (d: string): d is DocType => (DOC_TYPES as readonly string[]).includes(d)
export function ModuleSwitch({
  organizationId,
  module,
  enabled,
  names,
  setModule,
}: {
  organizationId: string
  module: string
  enabled: boolean
  names: Readonly<Record<string, string>>
  setModule: SetModuleAction
}) {
  const t = useTranslations('platform.modules')
  const tDoa = useTranslations('adminDoa')
  const router = useRouter()
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<{ contractRef?: string; reason?: string }>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const name = names[module] ?? module
  const target = !enabled

  function explain(f: AdminFailure): string {
    const listed = (f.modules ?? []).map((m) => names[m] ?? m).join(', ')
    if (f.code === 'MODULE_DISABLED') return t('errors.REQUIRES', { modules: listed })
    if (f.code === 'DOA_NOT_CONFIGURED' && f.reason === 'MODULE_RULES_MISSING') {
      const types = (f.documentTypes ?? []).map((d) => (isDocType(d) ? tDoa(`documentTypes.${d}`) : d)).join(', ')
      return t('errors.MODULE_RULES_MISSING', { documentTypes: types })
    }
    if (f.code === 'MODULE_IN_USE' && f.reason === 'OPEN_DOCUMENTS') return t('errors.OPEN_DOCUMENTS', { documents: (f.documents ?? []).join(', ') })
    if (f.code === 'MODULE_IN_USE') return t('errors.REQUIRED_BY', { modules: listed })
    if (f.code === 'VALIDATION_FAILED' && f.reason === 'NO_CHANGE') return t('errors.NO_CHANGE')
    if (f.code === 'VALIDATION_FAILED' && f.reason === 'CORE_ALWAYS_ON') return t('errors.CORE_ALWAYS_ON')
    if (f.code === 'VALIDATION_FAILED') return t('errors.INPUT')
    if (f.code === 'UNAUTHENTICATED') return t('errors.UNAUTHENTICATED')
    if (f.code === 'FORBIDDEN') return t('errors.FORBIDDEN')
    if (f.code === 'NOT_FOUND') return t('errors.NOT_FOUND')
    if (f.code === 'INTERNAL') return t('errors.INTERNAL', { requestId: f.requestId ?? '-' })
    return t('errors.FAILED')
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const contractRef = String(form.get('contractRef') ?? '').trim()
    const reason = String(form.get('reason') ?? '').trim()
    const next: typeof errors = {}
    if (!contractRef) next.contractRef = t('errors.CONTRACT_REF')
    if (reason.length < 3) next.reason = t('errors.REASON')
    setErrors(next)
    setFailure(null)
    setDone(null)
    if (next.contractRef || next.reason) return
    setPending(true)
    const outcome = await setModule({ organizationId, module, enabled: target, contractRef, reason }, submission.key)
    setPending(false)
    submission.next()
    if (!outcome.ok) {
      if (outcome.code === 'VALIDATION_FAILED' && outcome.field === 'contractRef') return setErrors({ contractRef: t('errors.CONTRACT_REF') })
      if (outcome.code === 'VALIDATION_FAILED' && outcome.field === 'reason') return setErrors({ reason: t('errors.REASON') })
      return setFailure(explain(outcome))
    }
    setDone(target ? t('enabled', { name }) : t('disabled', { name }))
    formRef.current?.reset()
    detailsRef.current?.removeAttribute('open')
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-3">
      {done ? <Notice tone="success">{done}</Notice> : null}
      <details ref={detailsRef} className="group" onToggle={(event) => event.currentTarget.open && setDone(null)}>
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center font-medium text-primary underline underline-offset-4 hover:no-underline [&::-webkit-details-marker]:hidden">
          {enabled ? t('openDisable', { name }) : t('openEnable', { name })}
        </summary>
        <form ref={formRef} onSubmit={onSubmit} className="mt-3 flex flex-col gap-4" noValidate>
          {failure ? <Notice tone="danger">{failure}</Notice> : null}
          <p className="text-ink-muted">{enabled ? t('disableHint') : t('enableHint')}</p>
          <Field id={`${module}-contract`} name="contractRef" required label={t('contractRef')} error={errors.contractRef} />
          <Field id={`${module}-reason`} name="reason" required label={t('reason')} error={errors.reason} />
          <Button type="submit" variant={enabled ? 'danger' : 'primary'} disabled={pending} className="self-start">
            {enabled ? t('disableSubmit', { name }) : t('enableSubmit', { name })}
          </Button>
        </form>
      </details>
    </div>
  )
}
