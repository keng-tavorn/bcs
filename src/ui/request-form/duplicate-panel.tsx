'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useRef } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { Notice } from '../form/notice'
import { describedBy, Labelled, textareaClass } from './controls'
import { duplicateLabel, type DuplicateAsk } from './duplicate'

// S6-13 (FR-INT-103 · BR-DUP-05) on the "ตรวจและส่ง" step of the workspace's form: the send was refused because the
// request looks like one the requester sent within the window (DUPLICATE_UNACKNOWLEDGED). An inline warning — never a
// pop-up (NG-13) — says so, links the requests it looks like, and asks for the reason, which the next send carries
// (./request-form.tsx). Sending with the box empty does not go: the box says why and takes focus. The LIFF form has its
// own (src/ui/liff/requests/duplicate-panel.tsx).

const linkClass = 'inline-flex min-h-11 items-center font-medium break-words text-primary underline underline-offset-4 hover:no-underline'
const ID = 'duplicate-reason'

export function DuplicatePanel({ ask }: { ask: DuplicateAsk }) {
  const t = useTranslations('requestForm.duplicate')
  const tf = useTranslations('requestForm.fields')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  // Shown after the send button in the bar at the foot of the page: brought into view with the focus on its heading
  useEffect(() => {
    headingRef.current?.scrollIntoView({ block: 'center' })
    headingRef.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (ask.stops > 0) boxRef.current?.focus()
  }, [ask.stops])
  const error = ask.missing && ask.reason.trim() === '' ? t('reasonMissing') : undefined
  return (
    <Notice tone="warning">
      <div className="flex flex-col gap-3">
        <h3 ref={headingRef} tabIndex={-1} className="font-semibold text-ink outline-none">
          {t('title')}
        </h3>
        <p>{t('intro')}</p>
        {ask.matched.length ? (
          <div className="flex flex-col">
            <p className="text-ink-muted">{t('matched')}</p>
            <ul aria-label={t('matched')} className="flex flex-wrap gap-x-4">
              {ask.matched.map((m) => (
                <li key={m.id}>
                  <a href={`/requests/${encodeURIComponent(m.id)}`} className={linkClass}>
                    {duplicateLabel(m)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <Labelled id={ID} label={t('reasonLabel')} requiredText={tf('required')} hint={t('reasonHint')} error={error} className="max-w-xl">
          <textarea
            ref={boxRef}
            id={ID}
            name="duplicateReason"
            className={textareaClass}
            value={ask.reason}
            maxLength={REASON_MAX_LENGTH}
            required
            aria-required
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(ID, true, Boolean(error))}
            onChange={(e) => ask.onReason(e.currentTarget.value)}
          />
        </Labelled>
      </div>
    </Notice>
  )
}
