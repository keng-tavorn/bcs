'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Button } from '../../form/button'
import { delegationErrorKey, type DelegationOutcome } from '../../delegation/outcome'
import { LiffNotice } from '../notice'
import { FieldError } from '../receiving/fields'
import { useSessionReady } from '../receiving/session-ready'
import { useLiffSubmissionKey } from '../submission-key'

// Cancelling one running or coming delegation in LIFF (/liff/delegation, FR-DOA-006 AC2): as on the web
// (src/ui/delegation/revoke-delegation.tsx), it cannot be undone, so the first button only opens a tick box that says
// what happens and the second, outlined in danger, cancels — 44 px each, kept apart so neither is pressed by mistake
// (§9.9). What happens is said as this build does it (NEW-35, the delegation-revoked job of §4.6): new approval tasks
// come to the delegator at once, and what the acting approver still holds for them comes back too — the words are the
// LIFF page's own (liffDelegation.revokeConfirm and revoked) while the workspace's still say otherwise. An ended or
// cancelled delegation offers nothing: the page passes revocable=false, and the service refuses a delegation that is no
// longer running anyway. The row stays after the cancellation, with its confirmation.

export type LiffRevokeDelegation = (delegationId: string, idempotencyKey: string) => Promise<DelegationOutcome>

/** Told to the page when a delegation was cancelled here, so the form's bar drops a message that no longer holds */
export const DELEGATION_REVOKED_EVENT = 'bcs:liff-delegation-revoked'
/** A full-width button whose words (a delegate's long name) may take two lines: it grows, never below 44 px */
const WRAPPING = 'h-auto min-h-11 w-full py-2 text-center'

export function LiffRevokeDelegationControl({
  delegationId,
  delegateName,
  revocable,
  revoke,
}: {
  readonly delegationId: string
  readonly delegateName: string
  /** Running or coming */
  readonly revocable: boolean
  readonly revoke: LiffRevokeDelegation
}) {
  const t = useTranslations('delegation')
  const tLiff = useTranslations('liffDelegation')
  const id = useId()
  const submission = useLiffSubmissionKey()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  /** Tries without the tick: each one takes the focus back to the box, the same error or not */
  const [unticked, setUnticked] = useState(0)
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const box = useRef<HTMLInputElement>(null)
  const sessionEnded = useCallback(() => setFailure(tLiff('sessionEnded')), [tLiff])
  const ready = useSessionReady(sessionEnded)
  // The tick box gets the focus once its error shows, so a screen reader reads both
  useEffect(() => {
    if (unticked > 0) box.current?.focus()
  }, [unticked])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    if (new FormData(event.currentTarget).get('confirm') !== 'yes') {
      setConfirmError(t('errors.CONFIRM'))
      setUnticked((n) => n + 1)
      return
    }
    setConfirmError(null)
    setFailure(null)
    // The button is busy from the tap: renewing the session may take a moment
    setPending(true)
    if (!(await ready())) return setPending(false)
    let outcome: DelegationOutcome | null
    try {
      outcome = await revoke(delegationId, submission.key)
    } catch {
      // No answer: the same key goes with a retry, so the cancellation runs at most once (spec §4.3)
      outcome = null
    }
    setPending(false)
    if (!outcome) return setFailure(t('errors.FAILED'))
    submission.next()
    if (outcome.ok) {
      setDone(true)
      setOpen(false)
      window.dispatchEvent(new Event(DELEGATION_REVOKED_EVENT))
      return
    }
    const key = delegationErrorKey(outcome)
    setFailure(key === 'UNAUTHENTICATED' ? tLiff('sessionEnded') : t(`errors.${key}`, { requestId: outcome.requestId ?? '-' }))
  }

  if (done) return <LiffNotice tone="success">{tLiff('revoked')}</LiffNotice>
  if (!revocable) return null
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} className={WRAPPING}>
        {t('revoke', { name: delegateName })}
      </Button>
    )
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
      {failure ? <LiffNotice tone="danger">{failure}</LiffNotice> : null}
      <div className="flex flex-col gap-1.5">
        <label className="flex min-h-11 items-start gap-3">
          <input
            ref={box}
            type="checkbox"
            name="confirm"
            value="yes"
            aria-invalid={confirmError ? true : undefined}
            aria-describedby={confirmError ? `${id}-error` : undefined}
            onChange={(event) => event.currentTarget.checked && setConfirmError(null)}
            className="mt-1 size-5 shrink-0 accent-[var(--danger)]"
          />
          <span>{tLiff('revokeConfirm')}</span>
        </label>
        <FieldError id={`${id}-error`} text={confirmError} />
      </div>
      <div className="flex flex-col gap-3">
        <Button type="submit" variant="danger" disabled={pending} className={WRAPPING}>
          {t('revokeSubmit')}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending} className={WRAPPING}>
          {t('keep')}
        </Button>
      </div>
    </form>
  )
}
