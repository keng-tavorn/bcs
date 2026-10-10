'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '../form/button'
import { Field } from '../form/field'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { invitationNotice } from './invite-member-form'
import { memberErrorKey, memberErrorValues, type AdminOutcome } from './outcome'

// Actions on one member at /admin/members/[memberId] (FR-ADM-001 AC1–AC2 · FR-AUTH-002 AC3 · FR-AUTH-003 AC2).
// Each section is its own small form with its own result line. Nothing that cannot be undone from this page happens
// without an explicit confirmation (§9.9): deactivation, a 2FA reset (signs the member out everywhere) and revoking a
// role of your own (only another admin can give it back). The services enforce every rule again.

export interface MemberManageActions {
  readonly grant: (memberId: string, role: string, idempotencyKey: string) => Promise<AdminOutcome>
  readonly revoke: (memberId: string, role: string, idempotencyKey: string) => Promise<AdminOutcome>
  readonly deactivate: (memberId: string, reason: string, idempotencyKey: string) => Promise<AdminOutcome>
  readonly resetTwoFactor: (memberId: string, reason: string, idempotencyKey: string) => Promise<AdminOutcome>
  readonly resendInvitation: (input: { email: string; displayNameTh: string; roles: string[] }, idempotencyKey: string) => Promise<AdminOutcome>
}

export interface MemberManageProps {
  readonly member: { id: string; email: string; displayNameTh: string; status: 'INVITED' | 'ACTIVE' | 'DEACTIVATED'; isSelf: boolean }
  readonly held: ReadonlyArray<{ value: string; label: string }>
  readonly grantable: ReadonlyArray<{ value: string; label: string }>
  readonly actions: MemberManageActions
}

type Status = { tone: 'success' | 'warning' | 'danger'; text: string } | null

/** Runs one action with this section's submission key; a new key once the answer is in (useSubmissionKey). */
function useRun() {
  const t = useTranslations('admin.members')
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  async function run(call: (idempotencyKey: string) => Promise<AdminOutcome>, success: string | ((outcome: Extract<AdminOutcome, { ok: true }>) => Status)): Promise<boolean> {
    setPending(true)
    setStatus(null)
    const outcome = await call(submission.key)
    setPending(false)
    submission.next()
    if (outcome.ok) {
      setStatus(typeof success === 'string' ? { tone: 'success', text: success } : success(outcome))
      router.refresh()
      return true
    }
    setStatus({ tone: 'danger', text: t(`errors.${memberErrorKey(outcome)}`, memberErrorValues(outcome)) })
    return false
  }
  return { pending, status, run }
}

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 border-t border-line pt-6 first:border-t-0 first:pt-0">
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      {hint ? <p className="text-ink-muted">{hint}</p> : null}
      {children}
    </section>
  )
}

/** A required tick box that says what the admin is agreeing to. */
function ConfirmBox({ id, label, error }: { id: string; label: string; error?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          name="confirm"
          value="yes"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-confirm-error` : undefined}
          className="size-5 shrink-0"
        />
        <span>{label}</span>
      </label>
      {error ? (
        <p id={`${id}-confirm-error`} className="text-base text-danger md:text-sm">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Revoking a role of your own: one tick box first, because only another admin can give it back. */
function SelfRevoke({ role, pending, onConfirm }: { role: { value: string; label: string }; pending: boolean; onConfirm: () => void }) {
  const t = useTranslations('admin.members')
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const id = useId()
  if (!open) {
    return (
      <Button variant="secondary" disabled={pending} onClick={() => setOpen(true)}>
        {t('revoke', { role: role.label })}
      </Button>
    )
  }
  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (new FormData(event.currentTarget).get('confirm') !== 'yes') return setError(t('errors.CONFIRM'))
        setError(undefined)
        onConfirm()
      }}
    >
      <ConfirmBox id={id} label={t('revokeSelfConfirm', { role: role.label })} error={error} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="danger" disabled={pending}>
          {t('revoke', { role: role.label })}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  )
}

function Roles({ member, held, grantable, actions }: MemberManageProps) {
  const t = useTranslations('admin.members')
  const { pending, status, run } = useRun()
  const selectId = useId()

  async function onGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const role = String(new FormData(event.currentTarget).get('role') ?? '')
    if (role) await run((key) => actions.grant(member.id, role, key), t('granted'))
  }

  return (
    <Section id="roles" title={t('rolesTitle')} hint={t('rolesHint')}>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {held.length ? (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {held.map((role) => (
            <li key={role.value} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="font-medium">{role.label}</span>
              {member.isSelf ? (
                <SelfRevoke role={role} pending={pending} onConfirm={() => void run((key) => actions.revoke(member.id, role.value, key), t('revoked'))} />
              ) : (
                <Button variant="secondary" disabled={pending} onClick={() => run((key) => actions.revoke(member.id, role.value, key), t('revoked'))}>
                  {t('revoke', { role: role.label })}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>{t('noRolesHeld')}</p>
      )}
      {member.isSelf ? (
        <Notice tone="info">{t('errors.SELF_GRANT')}</Notice>
      ) : member.status !== 'DEACTIVATED' && grantable.length ? (
        <form onSubmit={onGrant} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1.5">
            <label htmlFor={selectId} className="font-medium text-ink">
              {t('grantTitle')}
            </label>
            <select id={selectId} name="role" required className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink">
              {grantable.map((role) => (
                <option key={role.value} value={role.value}>
                  {role.label}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={pending}>
            {t('grantSubmit')}
          </Button>
        </form>
      ) : null}
    </Section>
  )
}

function ReasonForm({
  id,
  submitLabel,
  confirmLabel,
  success,
  call,
}: {
  id: string
  submitLabel: string
  confirmLabel: string
  success: string
  call: (reason: string, idempotencyKey: string) => Promise<AdminOutcome>
}) {
  const t = useTranslations('admin.members')
  const formRef = useRef<HTMLFormElement>(null)
  const { pending, status, run } = useRun()
  const [errors, setErrors] = useState<{ reason?: string; confirm?: string }>({})

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const reason = String(form.get('reason') ?? '').trim()
    const next: typeof errors = {}
    if (reason.length < 3) next.reason = t('errors.REASON')
    if (form.get('confirm') !== 'yes') next.confirm = t('errors.CONFIRM')
    setErrors(next)
    if (next.reason || next.confirm) return
    // Done: empty the form, so the same irreversible action is not one click away again
    if (await run((key) => call(reason, key), success)) formRef.current?.reset()
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      <Field id={`${id}-reason`} name="reason" required label={t('reason')} error={errors.reason} />
      <ConfirmBox id={id} label={confirmLabel} error={errors.confirm} />
      <Button type="submit" variant="danger" disabled={pending} className="self-start">
        {submitLabel}
      </Button>
    </form>
  )
}

export function MemberManage(props: MemberManageProps) {
  const t = useTranslations('admin.members')
  const { member, actions } = props
  const resend = useRun()

  return (
    <div className="flex flex-col gap-8">
      <Roles {...props} />

      {member.status === 'INVITED' ? (
        <Section id="resend" title={t('resendTitle')} hint={t('resendHint')}>
          {resend.status ? <Notice tone={resend.status.tone}>{resend.status.text}</Notice> : null}
          <Button
            variant="secondary"
            disabled={resend.pending}
            className="self-start"
            onClick={() =>
              resend.run(
                (key) => actions.resendInvitation({ email: member.email, displayNameTh: member.displayNameTh, roles: [] }, key),
                (outcome) => invitationNotice(t, member.email, outcome.emailSent),
              )
            }
          >
            {t('resendSubmit')}
          </Button>
        </Section>
      ) : null}

      {member.status === 'ACTIVE' && !member.isSelf ? (
        <Section id="reset-2fa" title={t('resetTitle')} hint={t('resetHint')}>
          <ReasonForm
            id="reset"
            submitLabel={t('resetSubmit')}
            confirmLabel={t('resetConfirm')}
            success={t('resetDone')}
            call={(reason, key) => actions.resetTwoFactor(member.id, reason, key)}
          />
        </Section>
      ) : null}

      {member.status !== 'DEACTIVATED' && !member.isSelf ? (
        <Section id="deactivate" title={t('deactivateTitle')} hint={t('deactivateHint')}>
          <ReasonForm
            id="deactivate"
            submitLabel={t('deactivateSubmit')}
            confirmLabel={t('deactivateConfirm')}
            success={t('deactivated')}
            call={(reason, key) => actions.deactivate(member.id, reason, key)}
          />
        </Section>
      ) : null}
    </div>
  )
}
