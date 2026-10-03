'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '../form/button'
import { Notice } from '../form/notice'
import { useSubmissionKey } from '../form/submission-key'
import { formatDateTime } from '../format'
import { remindErrorKey, type RemindOutcome } from './outcome'

// Reminding the person who holds a document, by hand (FR-VIS-001 AC2): at most once an hour per document, whoever
// reminds. The button names who gets the reminder and about what; the answer says it was sent and when the next one may
// go, or — within the hour — that it was reminded already and from when it may be sent again, in plain words. The
// service checks the board's scope, the task's state and the hour again (BR-AUTH-05); the key makes a double press one
// reminder (§4.3).

export interface RemindButtonProps {
  readonly taskId: string
  /** What the button says: "ส่งเตือน วีระ ปฏิบัติการ" */
  readonly label: string
  /** The same with the document, for screen readers: "ส่งเตือน วีระ ปฏิบัติการ เรื่อง PR-2569-00012 …" */
  readonly ariaLabel: string
  /** Already reminded within the hour: "ส่งเตือนแล้วภายในชั่วโมงนี้ ส่งได้อีกครั้งหลัง …" */
  readonly hint: string | null
  readonly locale: string
  readonly remind: (taskId: string, idempotencyKey: string) => Promise<RemindOutcome>
}

export function RemindButton({ taskId, label, ariaLabel, hint, locale, remind }: RemindButtonProps) {
  const t = useTranslations('board.remind')
  const te = useTranslations('board.errors')
  const router = useRouter()
  const submission = useSubmissionKey()
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<RemindOutcome | null>(null)

  async function onRemind() {
    setPending(true)
    setOutcome(null)
    let result: RemindOutcome
    try {
      result = await remind(taskId, submission.key)
      submission.next()
    } catch {
      // no answer: the same key is kept, so pressing again is the same reminder
      result = { ok: false, code: 'FAILED' }
    }
    setPending(false)
    setOutcome(result)
    if (result.ok) router.refresh()
  }

  const time = (iso: string | undefined) => (iso ? formatDateTime(locale, iso) : '-')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
        <Button variant="secondary" onClick={() => void onRemind()} disabled={pending} aria-busy={pending || undefined} aria-label={pending ? undefined : ariaLabel} className="self-start">
          {pending ? t('sending') : label}
        </Button>
        {hint && !outcome ? <p className="text-base text-ink-muted md:text-sm">{hint}</p> : null}
      </div>
      {outcome?.ok ? (
        <Notice tone="success">{t('sent', { time: time(outcome.at), again: time(outcome.nextAt) })}</Notice>
      ) : outcome ? (
        <Notice tone="danger">{te(remindErrorKey(outcome), { time: time(outcome.nextAt), requestId: outcome.requestId ?? '-' })}</Notice>
      ) : null}
    </div>
  )
}
