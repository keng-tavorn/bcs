'use client'

import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { PAYMENT_TERM_MAX_DAYS, PO_NOTE_MAX_LENGTH, REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useOutcomeAction } from '../procurement/use-outcome-action'
import { DoaRef } from '../request-view/doa-ref'
import { ConfirmBox, TextArea } from '../request-view/text-area'
import { poCancelErrorKey, poErrorKey, type PoErrorKey, type PoFailure, type PoOutcome } from './outcome'

// What procurement can do with a PO now (spec §6.4, FR-P2P-004, FR-P2P-005, FR-P2P-010), each in its own part with a
// button that says what happens (§9.9 rule 7): send a draft for approval with the route the DOA engine expects shown
// first (principle 3); send an approved PO to its supplier by e-mail — a second press names the address, because an
// e-mail cannot be called back; send it again with a reason; cancel it with what happens to its request lines, a
// reason and a tick; close it with a tick. Cancel is outlined in danger and sits apart from the sending. The page offers
// a part only when the PO's state and the member's role allow it; the services check both again.

const REASON_MIN = 3

export interface SubmitPreviewView {
  /** "DOA-DEMO ฉบับ 1 ข้อ PO-01" with why, and each step's approver; null when the engine refuses */
  readonly route: { readonly doaRef: string; readonly why: string; readonly steps: readonly string[] } | null
  /** Why it cannot be sent, already worded */
  readonly blocked: string | null
  /** BR-BUD-05 in words: what more is reserved, or that nothing is */
  readonly budget: string
}

export interface PoActionsProps {
  readonly poId: string
  /** The PO number, or how a draft is named */
  readonly label: string
  readonly submit: SubmitPreviewView | null
  /** The first sending; the supplier's address or null when the register has none */
  readonly send: { readonly email: string | null } | null
  readonly resend: { readonly email: string | null } | null
  readonly cancel: boolean
  readonly close: boolean
  /** Why closing waits, already worded */
  readonly closeWaits: string | null
  /** What to say when nothing can be done now (the PO waits for its approver, or it is over) */
  readonly nothing?: string
  readonly actions: {
    readonly submit: (poId: string, idempotencyKey: string) => Promise<PoOutcome>
    readonly send: (input: { poId: string; reason?: string }, idempotencyKey: string) => Promise<PoOutcome>
    readonly cancel: (input: { poId: string; disposition: 'RETURN_TO_POOL' | 'CANCEL_REQUEST_LINES'; reason: string }, idempotencyKey: string) => Promise<PoOutcome>
    readonly close: (poId: string, idempotencyKey: string) => Promise<PoOutcome>
  }
}

/** The words of a failure: what happened and how to fix it (§9.9 rule 7); `keyOf` picks the message of the part that failed */
export function usePoFailureText(keyOf: (failure: PoFailure) => PoErrorKey = poErrorKey) {
  const t = useTranslations('purchaseOrder.errors')
  return (failure: PoFailure) =>
    t(keyOf(failure), { left: failure.left ?? '-', shortfall: failure.shortfall ?? '-', requestId: failure.requestId ?? '-', max: PAYMENT_TERM_MAX_DAYS, noteMax: PO_NOTE_MAX_LENGTH })
}

const failureOf = (outcome: PoOutcome | null): PoFailure | null => (outcome && !outcome.ok ? outcome : null)

function SubmitPart({ poId, preview, run, onDone }: { poId: string; preview: SubmitPreviewView; run: PoActionsProps['actions']['submit']; onDone: (text: string, tone: 'success') => void }) {
  const t = useTranslations('purchaseOrder.actions')
  const failureText = usePoFailureText()
  const id = useId()
  const action = useOutcomeAction<PoOutcome>({ ok: false, code: 'FAILED' })
  const failure = failureOf(action.outcome)
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h3 id={`${id}-title`} className="font-semibold text-ink">
        {t('submit.title')}
      </h3>
      {preview.route ? (
        <div className="flex flex-col gap-2 border-l-4 border-primary bg-surface px-3 py-2.5">
          <p className="font-medium text-ink">{t('submit.routeTitle')}</p>
          <ol className="flex flex-col">
            {preview.route.steps.map((step) => (
              <li key={step} className="text-ink">
                {step}
              </li>
            ))}
          </ol>
          <DoaRef label={preview.route.doaRef} className="self-start text-base md:text-sm" />
          <p className="text-base text-ink-muted md:text-sm">{preview.route.why}</p>
        </div>
      ) : null}
      {preview.blocked ? <Notice tone="danger">{preview.blocked}</Notice> : null}
      <p className="text-base text-ink md:text-sm">{preview.budget}</p>
      <p className="text-base text-ink-muted md:text-sm">{t('submit.hint')}</p>
      {failure ? <Notice tone="danger">{failureText(failure)}</Notice> : null}
      <Button
        onClick={async () => {
          const outcome = await action.run((key) => run(poId, key))
          if (outcome.ok) onDone(t('submit.done'), 'success')
        }}
        disabled={action.pending || preview.blocked !== null}
        className="w-full sm:w-auto sm:self-start"
      >
        {action.pending ? t('working') : t('submit.button')}
      </Button>
    </section>
  )
}

function SendPart({
  poId,
  label,
  email,
  again,
  run,
  onDone,
}: {
  poId: string
  label: string
  email: string | null
  again: boolean
  run: PoActionsProps['actions']['send']
  onDone: (text: string, tone: 'success' | 'warning') => void
}) {
  const t = useTranslations('purchaseOrder.actions')
  const failureText = usePoFailureText()
  const id = useId()
  const action = useOutcomeAction<PoOutcome>({ ok: false, code: 'FAILED' })
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string>()
  const failure = failureOf(action.outcome)

  async function send() {
    const outcome = await action.run((key) => run({ poId, ...(again ? { reason: reason.trim() } : {}) }, key))
    setConfirming(false)
    if (!outcome.ok) return
    if (outcome.bounce) onDone(t('send.bounced', { code: outcome.bounce }), 'warning')
    else onDone(again ? t('resend.resent') : t('send.sent'), 'success')
    setReason('')
  }

  function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (again && reason.trim().length < REASON_MIN) return setReasonError(t('reasonMissing'))
    setReasonError(undefined)
    action.clear()
    setConfirming(true)
  }

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h3 id={`${id}-title`} className="font-semibold text-ink">
        {again ? t('resend.title') : t('send.title')}
      </h3>
      {email ? <p className="text-ink">{t('send.to', { email })}</p> : <Notice tone="warning">{t('send.noEmail')}</Notice>}
      {again ? <p className="text-base text-ink-muted md:text-sm">{t('resend.hint')}</p> : null}
      {failure ? <Notice tone="danger">{failureText(failure)}</Notice> : null}
      {email ? (
        <form onSubmit={ask} noValidate className="flex flex-col gap-3">
          {again ? (
            <TextArea
              id={`${id}-reason`}
              label={t('resend.reason')}
              hint={t('resend.reasonHint')}
              value={reason}
              onChange={(event) => {
                setReason(event.currentTarget.value)
                setReasonError(undefined)
                setConfirming(false)
              }}
              error={reasonError}
              maxLength={REASON_MAX_LENGTH}
              required
            />
          ) : null}
          {confirming ? (
            <div role="group" aria-labelledby={`${id}-confirm`} className="flex flex-col gap-2 border-l-4 border-info bg-surface px-3 py-2.5">
              <p id={`${id}-confirm`} className="font-medium text-ink">
                {t('send.confirmText', { number: label, email })}
              </p>
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => void send()} disabled={action.pending}>
                  {action.pending ? t('working') : t('send.confirm')}
                </Button>
                <Button variant="secondary" onClick={() => setConfirming(false)} disabled={action.pending}>
                  {t('send.back')}
                </Button>
              </div>
            </div>
          ) : (
            <Button type="submit" variant={again ? 'secondary' : 'primary'} className="w-full sm:w-auto sm:self-start">
              {again ? t('resend.button') : t('send.button')}
            </Button>
          )}
        </form>
      ) : null}
    </section>
  )
}

function CancelPart({ poId, run, onDone }: { poId: string; run: PoActionsProps['actions']['cancel']; onDone: (text: string, tone: 'success') => void }) {
  const t = useTranslations('purchaseOrder.actions')
  const failureText = usePoFailureText(poCancelErrorKey)
  const id = useId()
  const action = useOutcomeAction<PoOutcome>({ ok: false, code: 'FAILED' })
  const [disposition, setDisposition] = useState<'RETURN_TO_POOL' | 'CANCEL_REQUEST_LINES'>('RETURN_TO_POOL')
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [errors, setErrors] = useState<{ reason?: string; confirm?: string }>({})
  const failure = failureOf(action.outcome)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: typeof errors = {}
    if (reason.trim().length < REASON_MIN) next.reason = t('reasonMissing')
    if (!confirmed) next.confirm = t('confirmMissing')
    setErrors(next)
    if (next.reason || next.confirm) return
    const outcome = await action.run((key) => run({ poId, disposition, reason: reason.trim() }, key))
    if (outcome.ok) onDone(t('cancel.done'), 'success')
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby={`${id}-title`} className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 id={`${id}-title`} className="font-semibold text-ink">
        {t('cancel.title')}
      </h3>
      <p className="text-base text-ink-muted md:text-sm">{t('cancel.hint')}</p>
      {failure ? <Notice tone="danger">{failureText(failure)}</Notice> : null}
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 font-medium text-ink">{t('cancel.choice')}</legend>
        {(['RETURN_TO_POOL', 'CANCEL_REQUEST_LINES'] as const).map((value) => (
          <label key={value} className="flex min-h-11 items-start gap-3 py-1">
            <input
              type="radio"
              name={`${id}-disposition`}
              value={value}
              checked={disposition === value}
              onChange={() => setDisposition(value)}
              aria-describedby={`${id}-${value}-hint`}
              className="mt-1 size-5 shrink-0 accent-[var(--primary)]"
            />
            <span className="flex flex-col">
              <span className="font-medium text-ink">{t(`cancel.${value}`)}</span>
              <span id={`${id}-${value}-hint`} className="text-base text-ink-muted md:text-sm">
                {t(`cancel.${value}_HINT`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <TextArea
        id={`${id}-reason`}
        label={t('cancel.reason')}
        hint={t('cancel.reasonHint')}
        value={reason}
        onChange={(event) => {
          setReason(event.currentTarget.value)
          setErrors((e) => ({ ...e, reason: undefined }))
        }}
        error={errors.reason}
        maxLength={REASON_MAX_LENGTH}
        required
      />
      <ConfirmBox
        id={`${id}-confirm`}
        label={t('cancel.confirmTick')}
        checked={confirmed}
        onChange={(checked) => {
          setConfirmed(checked)
          setErrors((e) => ({ ...e, confirm: undefined }))
        }}
        error={errors.confirm}
      />
      <Button type="submit" variant="danger" disabled={action.pending} className="self-start">
        {action.pending ? t('working') : t('cancel.button')}
      </Button>
    </form>
  )
}

function ClosePart({ poId, run, onDone }: { poId: string; run: PoActionsProps['actions']['close']; onDone: (text: string, tone: 'success') => void }) {
  const t = useTranslations('purchaseOrder.actions')
  const failureText = usePoFailureText()
  const id = useId()
  const action = useOutcomeAction<PoOutcome>({ ok: false, code: 'FAILED' })
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string>()
  const failure = failureOf(action.outcome)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!confirmed) return setError(t('confirmMissing'))
    setError(undefined)
    const outcome = await action.run((key) => run(poId, key))
    if (outcome.ok) onDone(t('close.done'), 'success')
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby={`${id}-title`} className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 id={`${id}-title`} className="font-semibold text-ink">
        {t('close.title')}
      </h3>
      <p className="text-base text-ink-muted md:text-sm">{t('close.hint')}</p>
      {failure ? <Notice tone="danger">{failureText(failure)}</Notice> : null}
      <ConfirmBox
        id={`${id}-confirm`}
        label={t('close.confirmTick')}
        checked={confirmed}
        onChange={(checked) => {
          setConfirmed(checked)
          setError(undefined)
        }}
        error={error}
      />
      <Button type="submit" variant="secondary" disabled={action.pending} className="self-start">
        {action.pending ? t('working') : t('close.button')}
      </Button>
    </form>
  )
}

export function PoActions({ poId, label, submit, send, resend, cancel, close, closeWaits, nothing: nothingText, actions }: PoActionsProps) {
  const t = useTranslations('purchaseOrder.actions')
  const id = useId()
  const [done, setDone] = useState<{ text: string; tone: 'success' | 'warning' } | null>(null)
  const onDone = (text: string, tone: 'success' | 'warning') => setDone({ text, tone })
  const nothing = !submit && !send && !resend && !cancel && !close && !closeWaits

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4">
      <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">
        {t('title')}
      </h2>
      {done ? <Notice tone={done.tone}>{done.text}</Notice> : null}
      {nothing ? <p className="text-ink-muted">{nothingText ?? t('nothing')}</p> : null}
      {submit ? <SubmitPart poId={poId} preview={submit} run={actions.submit} onDone={onDone} /> : null}
      {send ? <SendPart poId={poId} label={label} email={send.email} again={false} run={actions.send} onDone={onDone} /> : null}
      {resend ? <SendPart poId={poId} label={label} email={resend.email} again run={actions.send} onDone={onDone} /> : null}
      {close ? <ClosePart poId={poId} run={actions.close} onDone={onDone} /> : null}
      {closeWaits ? <p className="border-t border-line pt-4 text-base text-ink-muted md:text-sm">{closeWaits}</p> : null}
      {cancel ? <CancelPart poId={poId} run={actions.cancel} onDone={onDone} /> : null}
    </section>
  )
}
