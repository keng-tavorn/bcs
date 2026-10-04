'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { BoundaryConfirm } from '../../admin-doa/boundary-confirm'
import { boundaryTickMissing, boundaryTickValue } from '../../admin-doa/boundary-tick'
import { Button } from '../../form/button'
import { useHydrated } from '../../form/hydrated'
import type { BoundaryTick, PolicyDecisionInput } from '../../tasks/policy-decision'
import { LiffActionBar } from '../action-bar'
import { LiffContent, LiffSection } from '../content'
import { LiffNotice } from '../notice'
import { PinInput } from '../pin-input'
import { LiffTextArea, LiffTick } from './fields'
import { placePolicyRefusal } from './policy-refusal'
import type { LiffTaskFailure, LiffTaskResult } from './result'
import { TaskRefusal, useClosedTask, useLiffSend } from './send'
import { focusField, pinComplete, REASON_MIN, type LiffTaskAction } from './shared'

// Deciding a DOA version or an authority change on its LIFF page (BR-DOA-15, FR-DOA-010 AC2, FR-DOA-002 AC2, NEW-41): the
// same choices and words as the web decision page (src/ui/tasks/policy-decision.tsx), laid out for a phone in LINE.
// Approve or reject only, and both need the member's transaction PIN every time (FR-AUTH-005 AC2). A DOA version whose
// page shows a boundary table is approved only once the approver ticks it as checked, in the bar above the PIN
// (FR-DOA-009 AC3): the form refuses to send without the tick, and sends it with the version the table compared with,
// so the service approves only the table that was ticked — it asks for the tick again and refuses without it. A refusal
// the page cannot point at its tick for — the table changed after the page was opened — is said in the bar, and the
// tick is taken back. Rejecting needs no tick of the table: a reason, the PIN and a tick of the decision, in a section
// of its own at the end of the page, outlined in danger. Approve is in the bar at the bottom of the screen (§9.4).
// ?action=reject from a LINE card opens the page at the reason of rejecting; nothing is ever decided by itself.
// Nothing is sent before the page's script runs (src/ui/form/hydrated.ts): both forms post, and their buttons and PIN
// fields wait for the script — a PIN never goes into an address (NFR-SEC-09). One try at a time (./send.tsx).

/** The section of rejecting, which the bar links to */
export const REJECT_POLICY_ID = 'reject-policy'

export interface LiffPolicyDecisionProps {
  readonly taskId: string
  readonly open: boolean
  /** A DOA version whose page shows a boundary table: the table the approver ticks; null otherwise */
  readonly boundary: BoundaryTick | null
  readonly pinLength: number
  readonly initial: LiffTaskAction | null
  readonly pinSettingsHref: string
  readonly helpHref: string
  readonly decide: (input: PolicyDecisionInput, idempotencyKey: string) => Promise<LiffTaskResult>
  readonly children: ReactNode
}

export function LiffPolicyDecision({ taskId, open, boundary, pinLength, initial, pinSettingsHref, helpHref, decide, children }: LiffPolicyDecisionProps) {
  const boundaryTableId = boundary?.tableId ?? null
  const t = useTranslations('tasks.policy')
  const tErrors = useTranslations('tasks.errors')
  const id = useId()
  const hydrated = useHydrated()
  const stale = useClosedTask()
  const approving = useLiffSend()
  const rejecting = useLiffSend()
  const [done, setDone] = useState<string | null>(null)
  const [approvePin, setApprovePin] = useState('')
  const [approvePinError, setApprovePinError] = useState<string>()
  const [approveFailure, setApproveFailure] = useState<LiffTaskFailure | null>(null)
  const [boundaryTicked, setBoundaryTicked] = useState(false)
  const [boundaryError, setBoundaryError] = useState<string>()
  const [reason, setReason] = useState('')
  const [rejectPin, setRejectPin] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<{ reason?: string; pin?: string; confirm?: string }>({})
  const [rejectFailure, setRejectFailure] = useState<LiffTaskFailure | null>(null)
  const approvePinId = `${id}-approve-pin`
  const rejectPinId = `${id}-reject-pin`

  // A LINE card's "ไม่อนุมัติ" opens the page at the reason of rejecting (§9.3); nothing is sent
  useEffect(() => {
    if (initial !== 'reject' || !open) return
    document.getElementById(REJECT_POLICY_ID)?.scrollIntoView({ block: 'start' })
    document.getElementById(`${id}-reason`)?.focus({ preventScroll: true })
  }, [initial, open, id])

  const finished = (text: string) => {
    setDone(text)
    window.scrollTo({ top: 0 })
  }

  async function onApprove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const pin = approvePin
    const pinError = pinComplete(pin, pinLength) ? undefined : tErrors('PIN')
    const tickMissing = boundaryTickMissing(boundaryTableId, boundaryTicked)
    setApprovePinError(pinError)
    setBoundaryError(tickMissing ? tErrors('BOUNDARY_NOT_CONFIRMED') : undefined)
    if (pinError || tickMissing) return
    setApproveFailure(null)
    const tick = { boundaryTableConfirmed: boundaryTickValue(boundaryTableId, boundaryTicked), ...(boundary ? { boundaryBaselineId: boundary.baselineId } : {}) }
    const result = await approving.send((key) => decide({ taskId, decision: 'APPROVE', pin, ...tick }, key))
    if (!result) return
    setApprovePin('')
    if (result.ok) {
      finished(t('approved'))
      return
    }
    if (stale.check(result)) return
    if (result.at === 'pin') {
      setApprovePinError(result.text)
      focusField(approvePinId)
      return
    }
    // The tick the service asked for: at the tick when the page shows the table; in the bar, as a table that appeared
    // after the page was opened, when it shows none (./policy-refusal.ts)
    const placed = placePolicyRefusal(result, boundaryTableId, tErrors('BOUNDARY_TABLE_CHANGED'))
    if (placed.at === 'tick') {
      setBoundaryError(placed.text)
      return
    }
    // A table that changed since the page was opened: its tick was for the table before
    if (result.untick) setBoundaryTicked(false)
    setApproveFailure(placed.failure)
  }

  async function onReject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const pin = rejectPin
    const next: typeof errors = {}
    if (reason.trim().length < REASON_MIN) next.reason = tErrors('REASON')
    if (!pinComplete(pin, pinLength)) next.pin = tErrors('PIN')
    if (!confirmed) next.confirm = tErrors('CONFIRM')
    setErrors(next)
    if (next.reason || next.pin || next.confirm) return
    setRejectFailure(null)
    const result = await rejecting.send((key) => decide({ taskId, decision: 'REJECT', reason: reason.trim(), pin }, key))
    if (!result) return
    setRejectPin('')
    if (result.ok) {
      finished(t('rejected'))
      return
    }
    if (stale.check(result)) return
    if (result.at === 'pin') {
      setErrors((e) => ({ ...e, pin: result.text }))
      focusField(rejectPinId)
      return
    }
    setRejectFailure(result)
  }

  /** The decision still waits for this member, and this visit has not made it */
  const active = open && !stale.closed && !done
  return (
    <>
      <LiffContent>
        {/* What this visit decided, or that the task was closed meanwhile (by whom, when — FR-DOA-004 AC2), until the page
            rendered again says it itself (who decided it, when) — one notice */}
        {done && open ? <LiffNotice tone="success">{done}</LiffNotice> : null}
        {stale.closed && open ? <LiffNotice tone="danger">{stale.closed}</LiffNotice> : null}
        {active ? <LiffNotice tone="info">{t('stepUpHint')}</LiffNotice> : null}
        {children}

        {active ? (
          <LiffSection id={REJECT_POLICY_ID} title={t('rejectTitle')}>
            <form method="post" onSubmit={onReject} noValidate className="flex flex-col gap-4">
              <p className="text-ink-muted">{t('rejectHint')}</p>
              {rejectFailure ? <TaskRefusal failure={rejectFailure} pinSettingsHref={pinSettingsHref} helpHref={helpHref} /> : null}
              <LiffTextArea
                id={`${id}-reason`}
                name="reason"
                label={t('reason')}
                value={reason}
                onChange={(value) => {
                  setReason(value)
                  setErrors((e) => ({ ...e, reason: undefined }))
                }}
                error={errors.reason}
                maxLength={REASON_MAX_LENGTH}
              />
              <PinInput
                id={rejectPinId}
                name="pin"
                label={t('pin')}
                length={pinLength}
                value={rejectPin}
                onChange={(value) => {
                  setRejectPin(value)
                  setErrors((e) => ({ ...e, pin: undefined }))
                }}
                {...(errors.pin ? { error: errors.pin } : {})}
                disabled={rejecting.pending || !hydrated}
              />
              <LiffTick
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
          </LiffSection>
        ) : null}
      </LiffContent>

      {active ? (
        <LiffActionBar label={t('title')}>
          <form method="post" onSubmit={onApprove} noValidate className="flex flex-col gap-2">
            {approveFailure ? <TaskRefusal failure={approveFailure} pinSettingsHref={pinSettingsHref} helpHref={helpHref} /> : null}
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
            <PinInput
              id={approvePinId}
              name="pin"
              label={t('pin')}
              length={pinLength}
              value={approvePin}
              onChange={(value) => {
                setApprovePin(value)
                setApprovePinError(undefined)
              }}
              {...(approvePinError ? { error: approvePinError } : {})}
              disabled={approving.pending || !hydrated}
            />
            <Button type="submit" disabled={approving.pending || !hydrated} aria-busy={approving.pending || undefined} className="w-full">
              {t('approve')}
            </Button>
          </form>
          <a href={`#${REJECT_POLICY_ID}`} className="inline-flex min-h-11 items-center justify-center font-medium text-danger underline underline-offset-4 hover:no-underline">
            {t('rejectTitle')}
          </a>
        </LiffActionBar>
      ) : null}
    </>
  )
}
