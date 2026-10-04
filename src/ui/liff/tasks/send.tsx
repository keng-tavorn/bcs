'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCallback, useRef, useState } from 'react'
import { Button } from '../../form/button'
import { LIFF_LINK_CLASS, LiffLink } from '../liff-link'
import { useLiff } from '../liff-provider'
import { LiffNotice } from '../notice'
import { newDecisionKey } from './key'
import type { LiffTaskFailure, LiffTaskResult } from './result'

// What the forms of the LIFF decision page share (./decision.tsx, ./policy-decision.tsx; FR-LINE-003, FR-AUTH-005):
//  - useLiffSend: one form's sending. The LIFF session is kept first (useLiff().ensureSession(), §9.4): one that cannot be
//    kept on this page load sends nothing — in the LINE app a new page load brings a fresh ID token, otherwise the form
//    says to open the page again. One try at a time: a second press while one is on its way is dropped before it reaches
//    the server, so a double tap never counts two wrong PINs (FR-AUTH-005 AC3). The idempotencyKey of the submission — a
//    uuid on every WebView of the LINE app (./key.ts) — is reused when no answer came back (spec §4.3) and renewed after
//    every answer.
//  - TaskRefusal: what the server answered, in the member's words, by the form's button — with where to set a PIN when
//    the member has none (the web settings, or how it works in LINE), and a reload when the session ended.

/** The idempotencyKey of the form's submission: the same until next() (call it once an answer arrives) */
function useDecisionKey(): { readonly key: string; readonly next: () => void } {
  const [key, setKey] = useState(newDecisionKey)
  const next = useCallback(() => setKey(newDecisionKey()), [])
  return { key, next }
}

export function useLiffSend() {
  const liff = useLiff()
  const t = useTranslations('liffTasks.decide')
  const submission = useDecisionKey()
  const busy = useRef(false)
  const [pending, setPending] = useState(false)

  /** Sends once; null when nothing was sent (a try on its way, or the page is loading again for a fresh ID token) */
  const send = async (run: (idempotencyKey: string) => Promise<LiffTaskResult>): Promise<LiffTaskResult | null> => {
    if (busy.current) return null
    busy.current = true
    setPending(true)
    try {
      const session = await liff.ensureSession()
      if (!session.ok && session.final) {
        if (session.reason === 'TOKEN_INVALID' && liff.reloadForNewToken()) return null
        return { ok: false, at: 'form', text: t('signedOut'), signedOut: true }
      }
      try {
        const result = await run(submission.key)
        submission.next()
        return result
      } catch {
        // No answer came back (the network): the key stays, so sending again is the same submission
        return { ok: false, at: 'form', text: t('failed') }
      }
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return { pending, send }
}

/**
 * A task decided, moved or closed while the page was open: said at the top — who decided it and when (FR-DOA-004 AC2) —
 * and the page is rendered again to show the task as it is now, whose own notice then says it instead (the forms show
 * `closed` only while the page still says the task is open) and whose decision bar goes
 */
export function useClosedTask() {
  const router = useRouter()
  const [closed, setClosed] = useState<string | null>(null)
  const check = useCallback(
    (result: LiffTaskResult): boolean => {
      if (result.ok || result.at !== 'closed') return false
      setClosed(result.text)
      router.refresh()
      window.scrollTo({ top: 0 })
      return true
    },
    [router],
  )
  return { closed, check }
}

export interface TaskRefusalProps {
  readonly failure: LiffTaskFailure
  /** Where a member sets their PIN on the web (FR-AUTH-005 AC1) */
  readonly pinSettingsHref: string
  /** How BCS works in LINE, the PIN included (/liff/help) */
  readonly helpHref: string
}

/** A refusal next to the form's button: what happened and what to do, with the one way out that helps */
export function TaskRefusal({ failure, pinSettingsHref, helpHref }: TaskRefusalProps) {
  const t = useTranslations('liffTasks.decide')
  return (
    <LiffNotice tone="danger">
      <p>{failure.text}</p>
      {failure.pinNotSet ? (
        <div className="mt-1 flex flex-col">
          {/* A page of the web workspace: it loads as a page of its own, outside the LIFF app */}
          <a href={pinSettingsHref} className={LIFF_LINK_CLASS}>
            {t('setPin')}
          </a>
          <LiffLink href={helpHref}>{t('pinHelp')}</LiffLink>
        </div>
      ) : null}
      {failure.signedOut ? (
        <div className="mt-2">
          <Button variant="secondary" onClick={() => window.location.reload()}>
            {t('reload')}
          </Button>
        </div>
      ) : null}
    </LiffNotice>
  )
}
