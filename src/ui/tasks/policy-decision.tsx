'use client'

import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { BoundaryConfirm } from '../admin-doa/boundary-confirm'
import { boundaryRefusalAt, boundaryTickMissing, boundaryTickValue } from '../admin-doa/boundary-tick'
import { Button } from '../form/button'
import { useHydrated } from '../form/hydrated'
import { Notice } from '../form/notice'
import { ConfirmBox, TextArea } from '../request-view/text-area'
import { StateLine } from '../request-view/status'
import { useAction } from '../request-view/use-action'
import { useBarSpace } from './bar-space'
import { PIN_FIELD_KEYS, TaskFailure, taskClosed, useClosedTask, useFocusPinAfterRefusal, useOneTry, useTaskFailureText } from './decision-panel'
import { taskErrorKey, type ActionOutcome } from './outcome'
import { PinField, pinIsComplete } from './pin-field'

// Deciding a DOA version or an authority change (BR-DOA-15, FR-DOA-010 AC2, FR-DOA-002 AC2): approve or reject only,
// and both need the member's 6-digit transaction PIN (FR-AUTH-005 AC2) — the step-up is granted for this one document
// and used once by the decision. A DOA version whose page shows a boundary table is approved only once the approver
// ticks it as checked, above the PIN (FR-DOA-009 AC3): the form refuses to send without the tick, and sends it with the
// version the table compared with, so the service approves only the table that was ticked; it asks for the tick again.
// A refusal the page cannot point at its tick for — the table appeared, or changed, after the page was opened — is said
// in the form, with what to do. Rejecting needs no tick. Approve sticks to the bottom on phones; reject is a separate
// form with a reason and a tick, outlined in danger. The PIN is masked, checked for six digits here and again on the
// server, cleared after every try, and a form sends one try at a time (a double tap never counts two wrong PINs). A
// wrong PIN is said at its field with the tries left; a lock says until when; a member without a PIN is shown where to
// set one. On phones the page keeps room at its end as tall as the approve bar is, whatever it says (useBarSpace).
// Nothing is sent before the page's script runs (src/ui/form/hydrated.ts): the approve bar holds a PIN field from the
// first paint, so both forms say method="post" and their submit buttons wait for the script, as the PIN fields do
// (pin-field.tsx) — a PIN never goes with a native submission into the page's address, the browser's history or a
// request log (NFR-SEC-09).

const REASON_MIN = 3

/**
 * What the forms send. Approving a DOA version: the approver's tick of the boundary table, or null when the page showed
 * none, and the version that table compared it with (null: the version's own table, an organization's first).
 */
export interface PolicyDecisionInput {
  readonly taskId: string
  readonly decision: 'APPROVE' | 'REJECT'
  readonly reason?: string
  /** The member's transaction PIN, six digits (FR-AUTH-005) */
  readonly pin: string
  readonly boundaryTableConfirmed?: boolean | null
  readonly boundaryBaselineId?: string | null
}

/** The boundary table on the decision page of a DOA version (FR-DOA-009 AC3) */
export interface BoundaryTick {
  /** The id of the section that holds the table, which the tick links to */
  readonly tableId: string
  /** The version the table compares this one with; null when it is the version's own table */
  readonly baselineId: string | null
}

export interface PolicyDecisionProps {
  readonly taskId: string
  readonly open: boolean
  readonly locale: string
  /** A DOA version whose page shows a boundary table: the table the approver ticks; null otherwise */
  readonly boundary?: BoundaryTick | null
  readonly decide: (input: PolicyDecisionInput, idempotencyKey: string) => Promise<ActionOutcome>
}

/**
 * The service refused an approval for the boundary table (FR-DOA-009 AC3): MISSING without the tick, CHANGED when the
 * table ticked is no longer the one the version is compared with
 */
function boundaryRefusal(outcome: ActionOutcome | null): 'MISSING' | 'CHANGED' | null {
  if (!outcome || outcome.ok || outcome.code !== 'VALIDATION_FAILED') return null
  return outcome.reason === 'BOUNDARY_NOT_CONFIRMED' ? 'MISSING' : outcome.reason === 'BOUNDARY_TABLE_CHANGED' ? 'CHANGED' : null
}

export function PolicyDecision({ taskId, open, locale, boundary = null, decide }: PolicyDecisionProps) {
  const boundaryTableId = boundary?.tableId ?? null
  const t = useTranslations('tasks.policy')
  const tErrors = useTranslations('tasks.errors')
  const failureText = useTaskFailureText(locale)
  const stale = useClosedTask(locale)
  const id = useId()
  const approving = useAction()
  const rejecting = useAction()
  const oneTry = useOneTry()
  const hydrated = useHydrated()
  const barRef = useBarSpace<HTMLFormElement>()
  const [done, setDone] = useState<string | null>(null)
  const [approvePin, setApprovePin] = useState('')
  const [approveError, setApproveError] = useState<string>()
  const [boundaryTicked, setBoundaryTicked] = useState(false)
  const [boundaryError, setBoundaryError] = useState<string>()
  const [reason, setReason] = useState('')
  const [rejectPin, setRejectPin] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<{ reason?: string; pin?: string; confirm?: string }>({})
  useFocusPinAfterRefusal(approving.outcome, `${id}-approve-pin`)
  useFocusPinAfterRefusal(rejecting.outcome, `${id}-reject-pin`)

  const finished = (text: string) => {
    setDone(text)
    window.scrollTo({ top: 0 })
  }

  async function onApprove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const pin = approvePin
    const pinError = pinIsComplete(pin) ? undefined : tErrors('PIN')
    const tickMissing = boundaryTickMissing(boundaryTableId, boundaryTicked)
    setApproveError(pinError)
    setBoundaryError(tickMissing ? tErrors('BOUNDARY_NOT_CONFIRMED') : undefined)
    if (pinError || tickMissing) return
    const tick = { boundaryTableConfirmed: boundaryTickValue(boundaryTableId, boundaryTicked), ...(boundary ? { boundaryBaselineId: boundary.baselineId } : {}) }
    await oneTry(async () => {
      const outcome = await approving.run((key) => decide({ taskId, decision: 'APPROVE', pin, ...tick }, key))
      setApprovePin('')
      const refused = boundaryRefusal(outcome)
      if (outcome.ok) finished(t('approved'))
      // A missing tick is said at the tick, or in the form when the page shows no table; a table that changed since the
      // page was opened is said in the form (approveFailure), and its tick is taken back: it was for the table before
      else if (refused === 'MISSING') setBoundaryError(boundaryRefusalAt(boundaryTableId) === 'TICK' ? tErrors('BOUNDARY_NOT_CONFIRMED') : undefined)
      else if (refused === 'CHANGED') setBoundaryTicked(false)
      else stale.check(outcome)
    })
  }

  async function onReject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const pin = rejectPin
    const next: typeof errors = {}
    if (reason.trim().length < REASON_MIN) next.reason = tErrors('REASON')
    if (!pinIsComplete(pin)) next.pin = tErrors('PIN')
    if (!confirmed) next.confirm = tErrors('CONFIRM')
    setErrors(next)
    if (next.reason || next.pin || next.confirm) return
    await oneTry(async () => {
      const outcome = await rejecting.run((key) => decide({ taskId, decision: 'REJECT', reason: reason.trim(), pin }, key))
      setRejectPin('')
      if (outcome.ok) finished(t('rejected'))
      else stale.check(outcome)
    })
  }

  /** A wrong or malformed PIN is said at the PIN field */
  const atPin = (outcome: ActionOutcome | null) => (outcome && !outcome.ok && PIN_FIELD_KEYS.includes(taskErrorKey(outcome)) ? failureText(outcome) : undefined)
  /** A failure that belongs next to its form; a closed task is told once, above, and a wrong PIN at its field */
  const failureOf = (outcome: ActionOutcome | null) => (outcome && !outcome.ok && !taskClosed(outcome) && !atPin(outcome) ? <TaskFailure failure={outcome} text={failureText(outcome)} /> : null)
  const refusal = boundaryRefusal(approving.outcome)
  const approveFailure =
    refusal === 'CHANGED' || (refusal === 'MISSING' && boundaryRefusalAt(boundaryTableId) === 'FORM') ? (
      <Notice tone="danger">{tErrors('BOUNDARY_TABLE_CHANGED')}</Notice>
    ) : refusal === 'MISSING' ? null : (
      failureOf(approving.outcome)
    )

  if (!open && !done && !stale.closed) return null
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4">
      <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">
        {t('title')}
      </h2>
      {done ? <Notice tone="success">{done}</Notice> : null}
      {stale.closed ? <Notice tone="danger">{stale.closed}</Notice> : null}
      {open && !stale.closed ? (
        <>
          <StateLine kind="key">{t('stepUpHint')}</StateLine>
          <form
            ref={barRef}
            data-decision-bar=""
            method="post"
            onSubmit={onApprove}
            noValidate
            className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2 border-t border-line bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:static lg:z-auto lg:border-0 lg:bg-transparent lg:p-0"
          >
            {approveFailure}
            {boundaryTableId !== null ? (
              <BoundaryConfirm
                tableId={boundaryTableId}
                checked={boundaryTicked}
                onChange={(checked) => {
                  setBoundaryTicked(checked)
                  if (checked) setBoundaryError(undefined)
                }}
                error={boundaryError}
                texts={{ title: t('boundaryTitle'), link: t('boundaryLink'), label: t('boundaryConfirm') }}
                compact
              />
            ) : null}
            {/* The PIN, then the approve button under it: a message at the PIN never pushes the button out of line */}
            <PinField
              id={`${id}-approve-pin`}
              label={t('pin')}
              value={approvePin}
              onChange={(value) => {
                setApprovePin(value)
                setApproveError(undefined)
                approving.clear()
              }}
              error={approveError ?? atPin(approving.outcome)}
              disabled={approving.pending}
            />
            <Button type="submit" disabled={approving.pending || !hydrated} aria-busy={approving.pending || undefined} className="w-full">
              {t('approve')}
            </Button>
            <a href="#reject-policy" className="inline-flex min-h-11 items-center justify-center font-medium text-danger underline underline-offset-4 hover:no-underline lg:hidden">
              {t('rejectTitle')}
            </a>
          </form>

          <form
            id="reject-policy"
            method="post"
            onSubmit={onReject}
            noValidate
            className="flex scroll-mt-4 flex-col gap-4 border-t border-line pt-4"
            aria-labelledby={`${id}-reject`}
          >
            <h3 id={`${id}-reject`} className="font-semibold text-ink">
              {t('rejectTitle')}
            </h3>
            <p className="text-base text-ink-muted md:text-sm">{t('rejectHint')}</p>
            {failureOf(rejecting.outcome)}
            <TextArea
              id={`${id}-reason`}
              name="reason"
              label={t('reason')}
              value={reason}
              onChange={(event) => {
                setReason(event.currentTarget.value)
                setErrors((e) => ({ ...e, reason: undefined }))
              }}
              error={errors.reason}
              maxLength={REASON_MAX_LENGTH}
              required
            />
            <PinField
              id={`${id}-reject-pin`}
              label={t('pin')}
              value={rejectPin}
              onChange={(value) => {
                setRejectPin(value)
                setErrors((e) => ({ ...e, pin: undefined }))
                rejecting.clear()
              }}
              error={errors.pin ?? atPin(rejecting.outcome)}
              disabled={rejecting.pending}
            />
            <ConfirmBox
              id={`${id}-reject-confirm`}
              label={t('confirm')}
              checked={confirmed}
              onChange={(checked) => {
                setConfirmed(checked)
                setErrors((e) => ({ ...e, confirm: undefined }))
              }}
              error={errors.confirm}
            />
            <Button type="submit" variant="danger" disabled={rejecting.pending || !hydrated} aria-busy={rejecting.pending || undefined} className="self-start">
              {t('reject')}
            </Button>
          </form>
        </>
      ) : null}
    </section>
  )
}
