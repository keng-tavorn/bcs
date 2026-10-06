'use client'

import { useTranslations } from 'next-intl'
import { useRef, useState, type FormEvent } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { memberErrorKey, memberErrorValues, type AdminOutcome } from './outcome'

export type InviteMemberAction = (input: { email: string; displayNameTh: string; roles: string[] }, idempotencyKey: string) => Promise<AdminOutcome>

type Result = { tone: 'success' | 'warning' | 'danger'; text: string }

/** What an invitation answer says about its e-mail (§9.9 rule 7: never claim a send that did not happen). */
export function invitationNotice(t: ReturnType<typeof useTranslations<'admin.members'>>, email: string, emailSent: boolean | null | undefined): Result {
  if (emailSent === false) return { tone: 'warning', text: t('invitedNotSent', { email }) }
  if (emailSent === null) return { tone: 'success', text: t('invitedAlready', { email }) }
  return { tone: 'success', text: t('invited', { email }) }
}

// Invite one member (FR-ADM-001 AC1 · FR-AUTH-001 AC1): e-mail, Thai display name and roles; no role = requester.
export function InviteMemberForm({ roles, invite }: { roles: ReadonlyArray<{ value: string; label: string }>; invite: InviteMemberAction }) {
  const t = useTranslations('admin.members')
  const formRef = useRef<HTMLFormElement>(null)
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; displayNameTh?: string }>({})

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '').trim()
    const displayNameTh = String(form.get('displayNameTh') ?? '').trim()
    const next: typeof fieldErrors = {}
    if (!email) next.email = t('errors.EMAIL')
    if (!displayNameTh) next.displayNameTh = t('errors.NAME')
    setFieldErrors(next)
    setResult(null)
    if (next.email || next.displayNameTh) return
    setPending(true)
    const outcome = await invite({ email, displayNameTh, roles: form.getAll('roles').map(String) }, submission.key)
    setPending(false)
    submission.next()
    if (outcome.ok) {
      setResult(invitationNotice(t, email, outcome.emailSent))
      formRef.current?.reset()
      return
    }
    const key = memberErrorKey(outcome)
    if (key === 'EMAIL' || key === 'ALREADY_MEMBER') setFieldErrors({ email: t(`errors.${key}`) })
    else if (key === 'NAME') setFieldErrors({ displayNameTh: t('errors.NAME') })
    else setResult({ tone: 'danger', text: t(`errors.${key}`, memberErrorValues(outcome)) })
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {result ? <Notice tone={result.tone}>{result.text}</Notice> : null}
      <Field id="invite-email" name="email" type="email" inputMode="email" autoComplete="off" required label={t('email')} error={fieldErrors.email} />
      <Field id="invite-name" name="displayNameTh" required label={t('displayNameTh')} error={fieldErrors.displayNameTh} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 font-medium text-ink">{t('rolesLabel')}</legend>
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {roles.map((role) => (
            <label key={role.value} className="flex min-h-11 items-center gap-3">
              <input type="checkbox" name="roles" value={role.value} className="size-5" />
              <span>{role.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? t('inviteSubmitting') : t('inviteSubmit')}
      </Button>
    </form>
  )
}
