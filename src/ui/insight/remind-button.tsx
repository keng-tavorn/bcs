'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState } from 'react'
import { MS_PER_HOUR } from '@/lib/constants'
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
// moves to the question (so a second press of the same key lands on words, not on the confirmation), back to the button
// when the question closes unanswered, and to the answer once the service has answered.
// Within the hour the page knows a reminder cannot go — from the board (againAt), from the reminder this button just
// sent, or from the service's refusal of a reminder someone sent meanwhile — so it offers no press that can only fail
// (§9.9 rule 7): the button cannot be pressed, the sentence beside it (or the answer under it) says from when it may be
// sent again and describes it to screen readers, and it can be pressed again by itself once that time comes. The page
// never words a refusal of its own: a refusal is the service's. The service checks the board's scope, the task's state
// and the hour again (BR-AUTH-05); the key makes a double press one reminder (§4.3).

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
  /** Already reminded within the hour: "ส่งเตือนแล้วภายในชั่วโมงนี้ ส่งได้อีกครั้งหลัง …", said beside the button */
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

/** The longest one timer waits (a reminder waits an hour at most); the time is checked again whenever it fires */
const LONGEST_WAIT_MS = MS_PER_HOUR

/** The later of two times (ISO), either of which may be unknown */
const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : Date.parse(b) > Date.parse(a) ? b : a)

/** The service's answer that says from when the document may be reminded again: its reminder, or its refusal within the hour */
const nextOf = (outcome: RemindOutcome | null): string | null => {
  if (!outcome) return null
  if (outcome.ok) return outcome.nextAt
  return remindErrorKey(outcome) === 'RECENT' ? (outcome.nextAt ?? null) : null
}

export function RemindButton({ taskId, view, locale, remind }: RemindButtonProps) {
  const t = useTranslations('board.remind')
  const te = useTranslations('board.errors')
  const router = useRouter()
  const id = useId()
  const submission = useSubmissionKey()
  const box = useRef<HTMLDivElement>(null)
  /** Where focus goes once the question opens or closes: nothing moves it when the page loads */
  const focusTo = useRef<'question' | 'button' | 'answer' | null>(null)
  const [asking, setAsking] = useState(false)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<RemindOutcome | null>(null)
  /** The latest time seen to pass: a reminder may go again once from-when is not later than it */
  const [passed, setPassed] = useState<string | null>(null)

  // From when the document may be reminded again, as far as the page knows. Read as the server drew the page until
  // the timer below has seen the time pass, so the button the page loads with is the one the server drew
  const againAt = later(view.againAt, nextOf(outcome))
  const waiting = againAt !== null && (passed === null || Date.parse(againAt) > Date.parse(passed))

  useEffect(() => {
    if (againAt === null) return
    let timer: number | undefined
    const wait = () => Math.min(Math.max(Date.parse(againAt) - Date.now(), 0), LONGEST_WAIT_MS)
    const check = () => {
      // a timer fires before the time only when the wait was longer than one timer waits: wait again
      if (Date.parse(againAt) > Date.now()) {
        timer = window.setTimeout(check, wait())
        return
      }
      // the answer stays as said (it names the time it spoke of) until the next press asks again
      setPassed(againAt)
    }
    timer = window.setTimeout(check, wait())
    return () => window.clearTimeout(timer)
  }, [againAt])

  useEffect(() => {
    const target = focusTo.current
    focusTo.current = null
    if (target) box.current?.querySelector<HTMLElement>(`[data-focus="${target}"]`)?.focus()
  }, [asking])

  function ask() {
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
    // the answer takes the question's place and the focus: after a reminder the button waits for the hour
    focusTo.current = 'answer'
    setAsking(false)
    if (result.ok) router.refresh()
  }

  const time = (iso: string | undefined) => (iso ? formatDateTime(locale, iso) : '-')
  const hintId = `${id}-hint`
  const answerId = `${id}-answer`
  // what says from when it may go: the answer under the button, or the board's sentence beside it
  const hint = waiting && !outcome ? view.hint : null
  const describedBy = waiting ? (outcome ? answerId : hint ? hintId : undefined) : undefined

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
          <Button variant="secondary" data-focus="button" onClick={ask} disabled={waiting} aria-label={view.ariaLabel} aria-describedby={describedBy} className={WRAPS}>
            {view.label}
          </Button>
          {hint ? (
            <p id={hintId} className="text-ink-muted">
              {hint}
            </p>
          ) : null}
        </div>
      )}
      {outcome ? (
        // the answer is where the focus goes once the service has answered
        <div id={answerId} data-focus="answer" tabIndex={-1} className="outline-none">
          {outcome.ok ? (
            <Notice tone="success">{t('sent', { time: time(outcome.at), again: time(outcome.nextAt) })}</Notice>
          ) : (
            <Notice tone="danger">{te(remindErrorKey(outcome), { time: time(outcome.nextAt), requestId: outcome.requestId ?? '-' })}</Notice>
          )}
        </div>
      ) : null}
    </div>
  )
}
