'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useRef } from 'react'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { duplicateLabel, type DuplicateAsk } from '../../request-form/duplicate'
import { LiffLink } from '../liff-link'
import { LiffNotice } from '../notice'
import { describedBy, textareaClass } from './classes'
import { LiffLabelled } from './labelled'

// S6-13 (FR-INT-103 · BR-DUP-05) on step 3 of the LIFF request form: the workspace's panel (src/ui/request-form/
// duplicate-panel.tsx) in LIFF's light components — the send was refused because the request looks like one the
// requester sent within the window, so an inline warning (never a pop-up, NG-13) links the requests it looks like, on
// their LIFF pages, and asks for the reason the next send carries (./request-form.tsx). Plain elements, no shadcn/ui or
// Workspace component (ADR-052). Sending with the box empty does not go: the box says why and takes focus.

const linkClass = 'inline-flex min-h-11 items-center font-medium break-words text-primary underline underline-offset-4 hover:no-underline'
const ID = 'liff-duplicate-reason'

export function LiffDuplicatePanel({ ask, requestsPath }: { readonly ask: DuplicateAsk; readonly requestsPath: string }) {
  const t = useTranslations('requestForm.duplicate')
  const tf = useTranslations('requestForm.fields')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  // Shown right above the send button in the bar: brought into view with the focus on its heading
  useEffect(() => {
    headingRef.current?.scrollIntoView({ block: 'center' })
    headingRef.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (ask.stops > 0) boxRef.current?.focus()
  }, [ask.stops])
  const error = ask.missing && ask.reason.trim() === '' ? t('reasonMissing') : undefined
  return (
    <LiffNotice tone="warning">
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
                  <LiffLink href={`${requestsPath}/${encodeURIComponent(m.id)}`} className={linkClass}>
                    {duplicateLabel(m)}
                  </LiffLink>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <LiffLabelled id={ID} label={t('reasonLabel')} requiredText={tf('required')} hint={t('reasonHint')} error={error}>
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
        </LiffLabelled>
      </div>
    </LiffNotice>
  )
}
