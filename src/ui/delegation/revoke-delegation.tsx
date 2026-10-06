'use client'

import { CircleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { settle } from '../admin-settings/outcome'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { delegationErrorKey, type DelegationOutcome } from './outcome'

export type RevokeDelegationAction = (delegationId: string, idempotencyKey: string) => Promise<DelegationOutcome>

// Cancel one running or coming delegation (NEW-06). It cannot be undone (a new one must be set), so the first button
// only opens a tick box that says what happens; the second, outlined in danger, cancels.
export function RevokeDelegation({
  delegationId,
  delegateName,
  revocable,
  revoke,
}: {
  delegationId: string
  delegateName: string
  /** Running or coming; the row stays mounted after a cancellation so its confirmation stays on screen */
  revocable: boolean
  revoke: RevokeDelegationAction
}) {
  const t = useTranslations('delegation')
  const id = useId()
  const submission = useSubmissionKey()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (new FormData(event.currentTarget).get('confirm') !== 'yes') return setConfirmError(t('errors.CONFIRM'))
    setConfirmError(null)
    setFailure(null)
    setPending(true)
    const outcome = await settle(revoke(delegationId, submission.key))
    setPending(false)
    // No answer: the same key goes with a retry, so the cancellation runs at most once
    if (!outcome) return setFailure(t('errors.FAILED'))
    submission.next()
    if (outcome.ok) {
      setDone(true)
      setOpen(false)
      return
    }
    setFailure(t(`errors.${delegationErrorKey(outcome)}`, { requestId: outcome.requestId ?? '-' }))
  }

  if (done) return <Notice tone="success">{t('revoked')}</Notice>
  if (!revocable) return null
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} className="self-start">
        {t('revoke', { name: delegateName })}
      </Button>
    )
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      <div className="flex flex-col gap-1.5">
        <label className="flex min-h-11 items-start gap-3">
          <input
            type="checkbox"
            name="confirm"
            value="yes"
            aria-invalid={confirmError ? true : undefined}
            aria-describedby={confirmError ? `${id}-error` : undefined}
            onChange={(event) => event.currentTarget.checked && setConfirmError(null)}
            className="mt-1 size-5 shrink-0"
          />
          <span>{t('revokeConfirm')}</span>
        </label>
        {confirmError ? (
          <p id={`${id}-error`} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{confirmError}</span>
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="danger" disabled={pending}>
          {t('revokeSubmit')}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          {t('keep')}
        </Button>
      </div>
    </form>
  )
}
