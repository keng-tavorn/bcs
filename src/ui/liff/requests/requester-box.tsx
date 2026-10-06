'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { requestErrorKey, type ActionFailure, type ActionOutcome } from '../../tasks/outcome'
import { LiffActionBar } from '../action-bar'
import { Button } from '../button'
import { LiffContent } from '../content'
import { LiffLink } from '../liff-link'
import { LiffNotice } from '../notice'
import { describedBy, primaryLinkClass, secondaryLinkClass, textareaClass } from './classes'
import { useRequestKey } from './key'
import { LiffLabelled } from './labelled'
import { useLiffReady } from './ready'

// What the requester does on their request in LINE (FR-INT-009, §9.4 /liff/requests/[id]): answer the approver's
// question (AC3: the task goes back to the approver who asked), send a returned request again or change it first (AC2:
// a new route under the DOA in effect, BR-DOA-09), or go on with a draft. The same choices, words and server commands
// as the workspace's box (src/ui/request-view/requester-actions.tsx), laid out for a phone in the LINE app (§9.9: one
// column, the main button at the bottom of the screen): what is asked, the reason or the state sits under the request's
// heading in "สิ่งที่ต้องทำ", and the one main action — send the answer, send again, or open the draft — sits in the bar at
// the bottom, with the server's refusal next to it. Built from the LIFF parts so that a request page that shows it stays
// within its first JavaScript (§9.4: at most 200 KB gzip with the LINE SDK); the workspace's box brings next/link, its
// notice and the uuid package. Before each send the LIFF session is kept (./ready.ts); one try at a time, and the
// submission's idempotencyKey is reused when no answer came back (spec §4.3). A success renders the page again with the
// request as it is now, and its confirmation in the button's own words stays (§9.9 rule 7). The services check the
// requester, the state and every rule again (BR-AUTH-05).

export interface LiffRequesterProps {
  readonly requestId: string
  /** An open question of the approver (the task waits for the answer) */
  readonly question: { readonly infoRequestId: string; readonly text: string; readonly askedLine: string } | null
  /** RETURNED: the approver's reason */
  readonly returned: { readonly reason: string | null } | null
  readonly draft: boolean
  /** The request's LIFF form while it is a draft or returned (/liff/requests/<id>/edit) */
  readonly editHref: string | null
  readonly canResubmit: boolean
  readonly actions: {
    readonly answer: (input: { infoRequestId: string; answer: string }, idempotencyKey: string) => Promise<ActionOutcome>
    readonly resubmit: (requestId: string, idempotencyKey: string) => Promise<ActionOutcome>
  }
}

/** Money of a refusal (decimal text from the server) as the screens write it */
function money(value: string | undefined): string {
  if (!value) return '-'
  try {
    return formatSatang(amountToSatang(value))
  } catch {
    return value
  }
}

const SIGNED_OUT: ActionFailure = { ok: false, code: 'UNAUTHENTICATED' }

export function LiffRequesterScreen({ header, children, requestId, question, returned, draft, editHref, canResubmit, actions }: LiffRequesterProps & { readonly header: ReactNode; readonly children: ReactNode }) {
  const t = useTranslations('requestView.actions')
  const tErrors = useTranslations('requestView.errors')
  const tl = useTranslations('liffRequests.view')
  const router = useRouter()
  const ready = useLiffReady()
  const answerKey = useRequestKey()
  const resubmitKey = useRequestKey()
  const id = useId()
  const formId = `${id}-answer-form`
  const answerRef = useRef<HTMLTextAreaElement>(null)
  const busy = useRef(false)
  const [answer, setAnswer] = useState('')
  const [answerError, setAnswerError] = useState<string>()
  const [pending, setPending] = useState<'answer' | 'resubmit' | null>(null)
  const [failure, setFailure] = useState<ActionFailure | null>(null)
  const [done, setDone] = useState<string | null>(null)

  /** One try at a time; the session first; the key kept when no answer came back */
  async function send(what: 'answer' | 'resubmit', call: (idempotencyKey: string) => Promise<ActionOutcome>, key: { key: string; next: () => void }): Promise<boolean> {
    if (busy.current) return false
    busy.current = true
    setPending(what)
    setFailure(null)
    setDone(null)
    let outcome: ActionOutcome | null
    try {
      const readiness = await ready()
      if (readiness === 'go') {
        outcome = await call(key.key)
        key.next()
      } else {
        outcome = readiness === 'ended' ? SIGNED_OUT : null
      }
    } catch {
      outcome = { ok: false, code: 'FAILED' }
    } finally {
      busy.current = false
      setPending(null)
    }
    if (!outcome) return false
    if (!outcome.ok) {
      setFailure(outcome)
      return false
    }
    router.refresh()
    return true
  }

  async function onAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!question) return
    const text = answer.trim()
    if (!text) {
      setAnswerError(tErrors('ANSWER'))
      answerRef.current?.focus()
      return
    }
    setAnswerError(undefined)
    if (await send('answer', (key) => actions.answer({ infoRequestId: question.infoRequestId, answer: text }, key), answerKey)) {
      setAnswer('')
      setDone(t('answered'))
    }
  }

  async function onResubmit() {
    if (await send('resubmit', (key) => actions.resubmit(requestId, key), resubmitKey)) setDone(t('resubmitted'))
  }

  const failed = failure
    ? tErrors(requestErrorKey(failure), { available: money(failure.available), shortfall: money(failure.shortfall), rule: failure.rule ?? '-', requestId: failure.requestId ?? '-' })
    : null
  const editDraft = draft && editHref
  const hasBar = Boolean(question || returned || editDraft)
  // "สิ่งที่ต้องทำ" shows only with something in it: what to do now, or the confirmation of what was just done here. A
  // request cancelled, or answered elsewhere, while this page was open has neither (the cancel says so where it was made)
  const hasToDo = Boolean(done || hasBar)

  return (
    <>
      <LiffContent>
        {header}
        {hasToDo ? (
          <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4 border-t border-line pt-5">
            <h2 id={`${id}-title`} className="text-lg font-semibold">
              {t('title')}
            </h2>
            {done ? <LiffNotice tone="success">{done}</LiffNotice> : null}

            {question ? (
              <form id={formId} onSubmit={onAnswer} noValidate className="flex flex-col gap-3">
                <h3 className="font-semibold">{t('answerTitle')}</h3>
                <blockquote className="border-l-2 border-info pl-3">
                  <span className="block break-words whitespace-pre-line">{question.text}</span>
                  <span className="block text-ink-muted">{question.askedLine}</span>
                </blockquote>
                <LiffLabelled id={`${id}-answer`} label={t('answerLabel')} hint={t('answerHint')} error={answerError}>
                  <textarea
                    ref={answerRef}
                    id={`${id}-answer`}
                    name="answer"
                    className={textareaClass}
                    value={answer}
                    maxLength={REASON_MAX_LENGTH}
                    required
                    aria-required
                    aria-invalid={answerError ? true : undefined}
                    aria-describedby={describedBy(`${id}-answer`, true, Boolean(answerError))}
                    onChange={(event) => {
                      setAnswer(event.currentTarget.value)
                      // The message goes once the field is being fixed (§9.9: errors say what to fix)
                      setAnswerError(undefined)
                    }}
                  />
                </LiffLabelled>
              </form>
            ) : null}

            {editDraft ? (
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold">{t('draftTitle')}</h3>
                <p className="text-ink-muted">{t('draftHint')}</p>
              </div>
            ) : null}

            {returned ? (
              <div className="flex flex-col gap-2">
                <h3 className="font-semibold">{t('returnedTitle')}</h3>
                {returned.reason ? <p className="break-words whitespace-pre-line">{t('returnedReason', { reason: returned.reason })}</p> : null}
                <p className="text-ink-muted">{t('resubmitHint')}</p>
              </div>
            ) : null}
          </section>
        ) : null}
        {children}
      </LiffContent>

      {hasBar ? (
        <LiffActionBar label={tl('barLabel')}>
          {failed ? <LiffNotice tone="danger">{failed}</LiffNotice> : null}
          {question ? (
            <Button type="submit" form={formId} disabled={pending !== null} className="h-auto min-h-11 w-full py-2">
              {pending === 'answer' ? t('working') : t('answerSubmit')}
            </Button>
          ) : null}
          {editDraft ? (
            <LiffLink href={editHref} className={primaryLinkClass}>
              {t('editDraft')}
            </LiffLink>
          ) : null}
          {returned ? (
            canResubmit ? (
              <div className="flex items-stretch gap-3">
                {editHref ? (
                  <LiffLink href={editHref} className={secondaryLinkClass}>
                    {t('edit')}
                  </LiffLink>
                ) : null}
                <Button onClick={() => void onResubmit()} disabled={pending !== null} className="h-auto min-h-11 min-w-0 flex-1 py-2">
                  {pending === 'resubmit' ? t('working') : t('resubmit')}
                </Button>
              </div>
            ) : editHref ? (
              <LiffLink href={editHref} className={primaryLinkClass}>
                {t('edit')}
              </LiffLink>
            ) : null
          ) : null}
        </LiffActionBar>
      ) : null}
    </>
  )
}
