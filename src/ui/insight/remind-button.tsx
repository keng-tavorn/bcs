'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { formatDateTime } from '../format'
import { remindErrorKey, type RemindOutcome } from './outcome'

// Reminding the person who holds a document, by hand (FR-VIS-001 AC2): at most once an hour per document, whoever
// reminds. A reminder cannot be taken back — the holder is notified at once, an Event records it, and nobody may remind
// that document again for an hour — so the button only asks (§9.9: nothing that cannot be undone without a
// confirmation), in the document's row where the button was, never in a modal: whom it reminds about what and what
// follows, then "ยืนยันส่งเตือน (ชื่อ)" as the main button, apart from "ยังไม่ส่งเตือน". Only the confirmation sends. Focus
// moves to the question (so a second press of the same key lands on words, not on the confirmation), and back to the
// button when the question closes. The answer says it was sent and when the next one may go. Within the hour — the
// page knows it from the board (againAt) or from the reminder it just sent — the button does not ask for a reminder
// that cannot go (§9.9 rule 7: the words of a button say what will happen): it says at once that the document was
// reminded already and from when it may be sent again, in plain words, as the service would. The service checks the
// board's scope, the task's state and the hour again (BR-AUTH-05); the key makes a double press one reminder (§4.3).

/** One document's reminder in words, translated: the button, what its first press asks, and the confirmation */
export interface RemindView {
  /** What the button says: "ส่งเตือน วีระ ปฏิบัติการ" */
  readonly label: string
  /** The same with the document, for screen readers: "ส่งเตือน วีระ ปฏิบัติการ เรื่อง PR-2569-00012 …" */
  readonly ariaLabel: string
  /** What the first press asks: whom it reminds about what, and that it cannot be called back */
  readonly question: string
  /** The button that sends: "ยืนยันส่งเตือน วีระ ปฏิบัติการ" */
  readonly confirmLabel: string
  /** The same with the document, for screen readers */
  readonly confirmAriaLabel: string
  /** Already reminded within the hour: "ส่งเตือนแล้วภายในชั่วโมงนี้ ส่งได้อีกครั้งหลัง …" */
  readonly hint: string | null
  /** Already reminded within the hour: from when it may be sent again (ISO); null when it may be sent now */
  readonly againAt: string | null
}

export interface RemindButtonProps {
  readonly taskId: string
  readonly view: RemindView
  readonly locale: string
  readonly remind: (taskId: string, idempotencyKey: string) => Promise<RemindOutcome>
}

/** A button that carries a person's name: at least 44 px tall, and its words wrap within the row on a phone */
const WRAPS = 'h-auto min-h-11 max-w-full self-start py-2 text-left'

export function RemindButton({ taskId, view, locale, remind }: RemindButtonProps) {
  const t = useTranslations('board.remind')
  const te = useTranslations('board.errors')
  const router = useRouter()
  const id = useId()
  const submission = useSubmissionKey()
  const box = useRef<HTMLDivElement>(null)
  /** Where focus goes once the question opens or closes: nothing moves it when the page loads */
  const focusTo = useRef<'question' | 'button' | null>(null)
  const [asking, setAsking] = useState(false)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<RemindOutcome | null>(null)

  useEffect(() => {
    const target = focusTo.current
    focusTo.current = null
    if (target) box.current?.querySelector<HTMLElement>(`[data-focus="${target}"]`)?.focus()
  }, [asking])

  function ask() {
    // Reminded within the hour (the board said so, or this button just sent one): nothing to ask, nothing to send — the
    // row says at once from when it may be sent again, in the service's own words for that refusal
    const known = [view.againAt, outcome?.nextAt].filter((at): at is string => typeof at === 'string')
    const again = known.reduce<string | null>((latest, at) => (latest === null || Date.parse(at) > Date.parse(latest) ? at : latest), null)
    if (again !== null && Date.parse(again) > Date.now()) {
      setOutcome({ ok: false, code: 'RATE_LIMITED', reason: 'REMINDED_WITHIN_HOUR', nextAt: again })
      return
    }
    // the last answer is no longer the last thing done
    setOutcome(null)
    focusTo.current = 'question'
    setAsking(true)
  }

  function close() {
    focusTo.current = 'button'
    setAsking(false)
  }

  async function onConfirm() {
    setPending(true)
    let result: RemindOutcome
    try {
      result = await remind(taskId, submission.key)
      submission.next()
    } catch {
      // no answer: the same key is kept, so confirming again is the same reminder
      result = { ok: false, code: 'FAILED' }
    }
    setPending(false)
    setOutcome(result)
    close()
    if (result.ok) router.refresh()
  }

  const time = (iso: string | undefined) => (iso ? formatDateTime(locale, iso) : '-')

  return (
    <div ref={box} className="flex flex-col gap-2">
      {asking ? (
        <div role="group" aria-labelledby={`${id}-question`} className="flex flex-col gap-3 border-l-4 border-info bg-surface px-3 py-2.5">
          <p id={`${id}-question`} data-focus="question" tabIndex={-1} className="font-medium text-ink outline-none">
            {view.question}
          </p>
          {/* The confirmation is the main button and "not yet" an outlined one, 24 px apart (12 px stacked on a phone):
              never pressed one for the other. A long name wraps inside the button rather than widen the page */}
          <div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
            <Button onClick={() => void onConfirm()} disabled={pending} aria-busy={pending || undefined} aria-label={pending ? undefined : view.confirmAriaLabel} className={WRAPS}>
              {pending ? t('sending') : view.confirmLabel}
            </Button>
            <Button variant="secondary" onClick={close} disabled={pending} className="self-start">
              {t('keep')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
          <Button variant="secondary" data-focus="button" onClick={ask} aria-label={view.ariaLabel} className={WRAPS}>
            {view.label}
          </Button>
          {view.hint && !outcome ? <p className="text-ink-muted">{view.hint}</p> : null}
        </div>
      )}
      {outcome?.ok ? (
        <Notice tone="success">{t('sent', { time: time(outcome.at), again: time(outcome.nextAt) })}</Notice>
      ) : outcome ? (
        <Notice tone="danger">{te(remindErrorKey(outcome), { time: time(outcome.nextAt), requestId: outcome.requestId ?? '-' })}</Notice>
      ) : null}
    </div>
  )
}
