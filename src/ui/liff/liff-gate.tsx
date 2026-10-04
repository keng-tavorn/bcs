'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '../form/button'
import { LIFF_HOME_PATH, LIFF_LINK_PATH, liffStateTarget, webSignInHref, type LiffSignInRefusal, type LiffSignInResult } from './bootstrap'
import { useLiff } from './liff-provider'
import { LiffNotice } from './notice'

// What a LIFF page shows when the server rendered it without a member session — never any of the page's data (§9.4).
// It waits for the SDK, signs in with the LINE ID token (./liff-provider.tsx) and then shows the page (router.refresh,
// so the server renders it again with the session). When that cannot work it says why and what to do:
//  - mode "member" (a page that needs the member: tasks, requests, track, delegation, gr): a LINE account that is not
//    linked goes to /liff/link; a browser outside the LINE app goes to the web sign-in, which returns to this page
//    (§9.4: outside LINE, the web login) — a web session opens LIFF pages too;
//  - mode "optional" (help, a refused link code): tries quietly and stays on the page when it cannot sign in. A LINE
//    account this tab already knows is not linked is not asked again (every refusal costs a call to LINE and an
//    auth.login_failed Event): the tab forgets that after a link or a sign-in;
//  - mode "index" (/liff): signed in → /liff/tasks, not linked → /liff/link, outside LINE → the web sign-in. A deep link
//    of LINE arrives here as ?liff.state=<path> and goes on to /liff/<path> first.
//  - mode "link" (/liff/link): not linked → shows `whenUnlinked` (the sign-in of FR-LINE-001 AC2), outside LINE → shows
//    `whenOutside`; nothing moves.
// `state` is the session the server rendered the page with. Only "signed-out" signs in with LINE: a page that has a
// session — a password sign-in inside LINE included — is never swapped for the session of the LINE account's owner.
// state "member": the server saw a member (only /liff renders the gate then, to follow a deep link or go home);
// state "needs-2fa-setup": the member's role needs TOTP set up on the web before any work (FR-AUTH-002 AC1);
// state "no-membership": the identity is no active member anywhere.

export type LiffGateMode = 'member' | 'optional' | 'index' | 'link'
export type LiffGateState = 'signed-out' | 'member' | 'needs-2fa-setup' | 'no-membership'

type Problem = 'ambiguous' | 'tokenInvalid' | 'unavailable' | 'failed'
type Outcome =
  | { readonly kind: 'moving'; readonly to: 'link' | 'web' }
  | { readonly kind: 'quiet' }
  | { readonly kind: 'unlinked' }
  | { readonly kind: 'outside' }
  | { readonly kind: 'problem'; readonly problem: Problem }

const PROBLEMS: Readonly<Record<Exclude<LiffSignInRefusal, 'NOT_IN_LINE' | 'LINK_REQUIRED'>, Problem>> = {
  LINK_AMBIGUOUS: 'ambiguous',
  TOKEN_INVALID: 'tokenInvalid',
  UNAVAILABLE: 'unavailable',
  FAILED: 'failed',
}

export interface LiffGateProps {
  readonly mode: LiffGateMode
  readonly state: LiffGateState
  /** /liff only: the ?liff.state= of a deep link from LINE */
  readonly liffState?: string | null
  /** Where to set up two-step verification (the web workspace) */
  readonly workspaceHref?: string
  /** mode "link": what to show when the LINE account is not linked */
  readonly whenUnlinked?: ReactNode
  /** mode "link": what to show in a browser outside the LINE app */
  readonly whenOutside?: ReactNode
}

export function LiffGate({ mode, state, liffState = null, workspaceHref = '/', whenUnlinked = null, whenOutside = null }: LiffGateProps) {
  const t = useTranslations('liff.gate')
  const router = useRouter()
  const { status, inClient, signIn, unlinked, reloadForNewToken } = useLiff()
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [attempt, setAttempt] = useState(0)
  const deepLink = mode === 'index' ? liffStateTarget(liffState) : null
  // The SDK did not start inside LINE: no ID token can come, only a new page load helps (when one is needed at all)
  const sdkFailed = status === 'failed' && inClient && state === 'signed-out'

  useEffect(() => {
    if (status === 'loading') return
    if (deepLink) {
      router.replace(deepLink)
      return
    }
    // A member's session is kept as it is: /liff goes on to the tasks without asking LINE for anything
    if (state === 'member') {
      if (mode === 'index') router.replace(LIFF_HOME_PATH)
      return
    }
    if (state !== 'signed-out' || sdkFailed) return
    let cancelled = false
    // Help asks LINE once per tab about an account it was told is not linked: the answer is known
    const asked: Promise<LiffSignInResult> = mode === 'optional' && unlinked.known() ? Promise.resolve({ ok: false, reason: 'LINK_REQUIRED' }) : signIn()
    void asked.then((result) => {
      if (cancelled) return
      if (result.ok) {
        unlinked.forget()
        if (mode === 'index') router.replace(LIFF_HOME_PATH)
        else router.refresh()
        return
      }
      if (result.reason === 'LINK_REQUIRED') unlinked.remember()
      if (mode === 'optional' && (result.reason === 'LINK_REQUIRED' || result.reason === 'NOT_IN_LINE')) {
        setOutcome({ kind: 'quiet' })
        return
      }
      if (mode === 'link' && (result.reason === 'LINK_REQUIRED' || result.reason === 'NOT_IN_LINE')) {
        setOutcome({ kind: result.reason === 'LINK_REQUIRED' ? 'unlinked' : 'outside' })
        return
      }
      if (result.reason === 'LINK_REQUIRED') {
        setOutcome({ kind: 'moving', to: 'link' })
        router.replace(LIFF_LINK_PATH)
        return
      }
      if (result.reason === 'NOT_IN_LINE') {
        setOutcome({ kind: 'moving', to: 'web' })
        window.location.replace(webSignInHref(`${window.location.pathname}${window.location.search}`))
        return
      }
      // An ID token LINE no longer accepts: in the LINE app a new page load brings a new one
      if (result.reason === 'TOKEN_INVALID' && reloadForNewToken()) return
      setOutcome({ kind: 'problem', problem: PROBLEMS[result.reason] })
    })
    return () => {
      cancelled = true
    }
  }, [status, sdkFailed, signIn, unlinked, reloadForNewToken, router, mode, state, deepLink, attempt])

  if (state === 'needs-2fa-setup' && !deepLink) {
    return (
      <LiffNotice tone="info">
        <p>{t('needsTwoFactor')}</p>
        <a href={workspaceHref} className="mt-2 inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('openWorkspace')}
        </a>
      </LiffNotice>
    )
  }
  if (state === 'no-membership' && !deepLink) return <LiffNotice tone="danger">{t('noMembership')}</LiffNotice>
  if (outcome?.kind === 'quiet') return null
  if (outcome?.kind === 'unlinked') return whenUnlinked
  if (outcome?.kind === 'outside') return whenOutside
  if (sdkFailed || outcome?.kind === 'problem') {
    const problem = outcome?.kind === 'problem' ? outcome.problem : 'sdkFailed'
    const reload = problem === 'sdkFailed' || problem === 'tokenInvalid'
    return (
      <LiffNotice tone="danger">
        <p>{t(problem)}</p>
        <div className="mt-2">
          {reload ? (
            <Button variant="secondary" onClick={() => window.location.reload()}>
              {t('reload')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                setOutcome(null)
                setAttempt((n) => n + 1)
              }}
            >
              {t('retry')}
            </Button>
          )}
        </div>
      </LiffNotice>
    )
  }
  const words =
    deepLink || state === 'member' ? t('opening') : outcome?.kind === 'moving' ? (outcome.to === 'link' ? t('toLink') : t('toWebSignIn')) : t('signingIn')
  // On a page that works without signing in (help) the attempt is announced to screen readers only
  return (
    <p role="status" className={mode === 'optional' ? 'sr-only' : 'text-ink-muted'}>
      {words}
    </p>
  )
}
