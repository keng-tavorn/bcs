'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useId, useState, type FormEvent } from 'react'
import { PAYMENT_TERM_MAX_DAYS, PO_NOTE_MAX_LENGTH, REASON_MAX_LENGTH } from '@/lib/constants'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useOutcomeAction } from '../procurement/use-outcome-action'
import { DoaRef } from '../request-view/doa-ref'
import { ConfirmBox, TextArea } from '../request-view/text-area'
import { PO_NO_ANSWER, poActionErrorKey, type PoAction, type PoFailure, type PoOutcome } from './outcome'

// What procurement can do with a PO now (spec §6.4, FR-P2P-004, FR-P2P-005, FR-P2P-010), each in its own part with a
// button that says what happens (§9.9 rule 7): send a draft for approval with the route the DOA engine expects shown
// first (principle 3); send an approved PO to its supplier by e-mail — a second press names the address, because an
// e-mail cannot be called back; send it again with a reason; cancel it with what happens to its request lines, a
// reason and a tick; close it with a tick. Cancel is outlined in danger and sits apart from the sending. The page offers
// a part only when the PO's state and the member's role allow it; the services check both again. Goods that will not
// come are settled on the PO's receiving page ("ปิดใบสั่งซื้อทั้งที่รับไม่ครบ", src/ui/receiving/close-short.tsx), which
// procurement's menu does not list: every text here that sends procurement there carries the link (§9.9 rules 7 and 8).
// While its action runs, a button says what it is doing in its own words ("กำลังส่ง PO", "กำลังยกเลิก PO"); an action
// that got no answer says it is not certain it was done, and to press the same button again (PO_NO_ANSWER). The sentence
// that says what a part does is read before pressing: body text at the body's size (§9.9: 15 px on the web), as the
// route and the budget above the button; only the hints of the choices and fields stay at 14 px.

const REASON_MIN = 3

/** A plain text link, 44 px tall, underlined, without an arrow (§9.9) */
const LINK = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

/** The way to the PO's receiving page, named with the PO */
function ReceivingLink({ href, label }: { href: string; label: string }) {
  const t = useTranslations('purchaseOrder.actions')
  return (
    <Link href={href} className={LINK}>
      {t('receivingLink', { label })}
    </Link>
  )
}

/**
 * The refusal of the cancel or the close, beside its part: in words, and — when what fixes it is done on the receiving
 * page — the way there. A cancel is refused once goods came (GR_POSTED) and a close while some did not come
 * (SHORT_NOT_APPROVED): what will not come is closed short on that page.
 */
export function PartRefusal({ part, failure, receiving }: { part: 'cancel' | 'close'; failure: PoFailure; receiving: { readonly href: string; readonly label: string } | null }) {
  const failureText = usePoFailureText()
  const fixedOnReceiving = poActionErrorKey(failure, part) === (part === 'cancel' ? 'GR_POSTED' : 'SHORT_NOT_APPROVED')
  return (
    <Notice tone="danger">
      <p>{failureText(failure, part)}</p>
      {receiving && fixedOnReceiving ? <ReceivingLink href={receiving.href} label={receiving.label} /> : null}
    </Notice>
  )
}

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
  /** The PO's receiving page, once it went to its supplier (SENT, PARTIALLY_RECEIVED, RECEIVED); null before */
  readonly receivingHref?: string | null
  /** What to say when nothing can be done now (the PO waits for its approver, or it is over) */
  readonly nothing?: string
  readonly actions: {
    readonly submit: (poId: string, idempotencyKey: string) => Promise<PoOutcome>
    readonly send: (input: { poId: string; reason?: string }, idempotencyKey: string) => Promise<PoOutcome>
    readonly cancel: (input: { poId: string; disposition: 'RETURN_TO_POOL' | 'CANCEL_REQUEST_LINES'; reason: string }, idempotencyKey: string) => Promise<PoOutcome>
    readonly close: (poId: string, idempotencyKey: string) => Promise<PoOutcome>
  }
}

/**
 * The words of an action that did not go through (§9.9 rule 7): a refusal says what happened and how to fix it; no answer
 * says, in the words of `action`, that it is not certain it was done, and to press its button again (`no`: the line of a
 * line's action)
 */
export function usePoFailureText() {
  const t = useTranslations('purchaseOrder.errors')
  return (failure: PoFailure, action: PoAction, no = 0) =>
    t(poActionErrorKey(failure, action), { left: failure.left ?? '-', shortfall: failure.shortfall ?? '-', requestId: failure.requestId ?? '-', max: PAYMENT_TERM_MAX_DAYS, noteMax: PO_NOTE_MAX_LENGTH, no })
}

const failureOf = (outcome: PoOutcome | null): PoFailure | null => (outcome && !outcome.ok ? outcome : null)

/** No answer came: the action may have been done, and the same press sends the same submission again */
const unanswered = (outcome: PoOutcome): boolean => !outcome.ok && outcome.code === PO_NO_ANSWER.code

function SubmitPart({ poId, preview, run, onDone }: { poId: string; preview: SubmitPreviewView; run: PoActionsProps['actions']['submit']; onDone: (text: string, tone: 'success') => void }) {
  const t = useTranslations('purchaseOrder.actions')
  const failureText = usePoFailureText()
  const id = useId()
  const action = useOutcomeAction<PoOutcome>(PO_NO_ANSWER)
  const failure = failureOf(action.outcome)
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h3 id={`${id}-title`} className="font-semibold text-ink">
        {t('submit.title')}
      </h3>
      {/* The route the DOA engine expects: information in --info, never the --primary of "approved" (§9.9 token table),
          as the request form's expected approver is; what procurement reads before sending is content at the body's
          size (§9.9: 15 px on the web, principle 3) */}
      {preview.route ? (
        <div className="flex flex-col gap-2 border-l-4 border-info bg-surface px-3 py-2.5">
          <p className="font-medium text-ink">{t('submit.routeTitle')}</p>
          <ol className="flex flex-col">
            {preview.route.steps.map((step) => (
              <li key={step} className="text-ink">
                {step}
              </li>
            ))}
          </ol>
          <DoaRef label={preview.route.doaRef} className="self-start" />
          <p className="text-ink-muted">{preview.route.why}</p>
        </div>
      ) : null}
      {preview.blocked ? <Notice tone="danger">{preview.blocked}</Notice> : null}
      <p className="text-ink">{preview.budget}</p>
      <p className="text-ink-muted">{t('submit.hint')}</p>
      {failure ? <Notice tone="danger">{failureText(failure, 'submit')}</Notice> : null}
      <Button
        onClick={async () => {
          const outcome = await action.run((key) => run(poId, key))
          if (outcome.ok) onDone(t('submit.done'), 'success')
        }}
        disabled={action.pending || preview.blocked !== null}
        className="w-full sm:w-auto sm:self-start"
      >
        {action.pending ? t('submit.working') : t('submit.button')}
      </Button>
    </section>
  )
}

/**
 * The second press of a sending, naming the PO and the address: an e-mail cannot be called back. While it is on its
 * way the button says so in its own words ("กำลังส่ง PO", or "กำลังส่ง PO อีกครั้ง" for a sending again)
 */
export function SendConfirm({ id, text, again, pending, onConfirm, onBack }: { id: string; text: string; again: boolean; pending: boolean; onConfirm: () => void; onBack: () => void }) {
  const t = useTranslations('purchaseOrder.actions')
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-2 border-l-4 border-info bg-surface px-3 py-2.5">
      <p id={id} className="font-medium text-ink">
        {text}
      </p>
      <div className="flex flex-wrap gap-3">
        <Button onClick={onConfirm} disabled={pending}>
          {pending ? (again ? t('resend.working') : t('send.working')) : t('send.confirm')}
        </Button>
        <Button variant="secondary" onClick={onBack} disabled={pending}>
          {t('send.back')}
        </Button>
      </div>
    </div>
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
  const action = useOutcomeAction<PoOutcome>(PO_NO_ANSWER)
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string>()
  const failure = failureOf(action.outcome)

  async function send() {
    const outcome = await action.run((key) => run({ poId, ...(again ? { reason: reason.trim() } : {}) }, key))
    // No answer: the second press stays, so "ยืนยันส่ง PO" is pressed again as it is — the same submission, which
    // e-mails the supplier once (spec §4.3); its words say so above the form
    if (unanswered(outcome)) return
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
      {again ? <p className="text-ink-muted">{t('resend.hint')}</p> : null}
      {failure ? <Notice tone="danger">{failureText(failure, again ? 'resend' : 'send')}</Notice> : null}
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
            <SendConfirm id={`${id}-confirm`} text={t('send.confirmText', { number: label, email })} again={again} pending={action.pending} onConfirm={() => void send()} onBack={() => setConfirming(false)} />
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

function CancelPart({
  poId,
  receiving,
  run,
  onDone,
}: {
  poId: string
  receiving: { readonly href: string; readonly label: string } | null
  run: PoActionsProps['actions']['cancel']
  onDone: (text: string, tone: 'success') => void
}) {
  const t = useTranslations('purchaseOrder.actions')
  const id = useId()
  const action = useOutcomeAction<PoOutcome>(PO_NO_ANSWER)
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
      <p className="text-ink-muted">{t('cancel.hint')}</p>
      {failure ? <PartRefusal part="cancel" failure={failure} receiving={receiving} /> : null}
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
              className="mt-1 size-5 shrink-0"
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
        {action.pending ? t('cancel.working') : t('cancel.button')}
      </Button>
    </form>
  )
}

function ClosePart({
  poId,
  receiving,
  run,
  onDone,
}: {
  poId: string
  receiving: { readonly href: string; readonly label: string } | null
  run: PoActionsProps['actions']['close']
  onDone: (text: string, tone: 'success') => void
}) {
  const t = useTranslations('purchaseOrder.actions')
  const id = useId()
  const action = useOutcomeAction<PoOutcome>(PO_NO_ANSWER)
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
      <p className="text-ink-muted">{t('close.hint')}</p>
      {failure ? <PartRefusal part="close" failure={failure} receiving={receiving} /> : null}
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
        {action.pending ? t('close.working') : t('close.button')}
      </Button>
    </form>
  )
}

export function PoActions({ poId, label, submit, send, resend, cancel, close, closeWaits, receivingHref = null, nothing: nothingText, actions }: PoActionsProps) {
  const t = useTranslations('purchaseOrder.actions')
  const id = useId()
  const [done, setDone] = useState<{ text: string; tone: 'success' | 'warning' } | null>(null)
  const onDone = (text: string, tone: 'success' | 'warning') => setDone({ text, tone })
  const nothing = !submit && !send && !resend && !cancel && !close && !closeWaits
  const receiving = receivingHref ? { href: receivingHref, label } : null

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
      {close ? <ClosePart poId={poId} receiving={receiving} run={actions.close} onDone={onDone} /> : null}
      {closeWaits ? (
        <div className="flex flex-col gap-1 border-t border-line pt-4">
          <p className="text-ink-muted">{closeWaits}</p>
          {/* What will not come is closed short there; procurement's menu does not list the receiving page */}
          {receiving ? <ReceivingLink href={receiving.href} label={receiving.label} /> : null}
        </div>
      ) : null}
      {cancel ? <CancelPart poId={poId} receiving={receiving} run={actions.cancel} onDone={onDone} /> : null}
    </section>
  )
}
