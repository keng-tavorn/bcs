'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { forgetUnlinked, isLineUserAgent, knownUnlinked, rememberUnlinked, type LiffSignInResult } from './bootstrap'
import { reloadOnce } from './reload'
import type { LiffSdk } from './sdk'
import { createLiffSessionKeeper, mockIdToken, type LiffSessionCheck, type LiffSessionKeeper, type LiffSessionKind } from './session-keeper'

// The LIFF bootstrap of every page under /liff (src/app/liff/layout.tsx mounts it once; it stays while the person moves
// between LIFF pages). In this order (§9.4):
//  1. liff.init({ liffId }) before anything else — the SDK comes through import(), outside the HTML's scripts. With
//     LIFF_MOCK (local only) liff.init is not called: the "LINE user" is the one the page was given (an e2e test
//     chooses it) and its ID token comes from POST /api/liff/mock-token, which asks the fake LINE server of the run. The
//     SDK module is still loaded, so a page weighs in tests what it weighs in the LINE app (§9.4: 200 KB gzip).
//     Everything after the token is the same in both modes.
//  2. signIn(): the ID token to POST /api/liff/session (ADR-046), which opens a LIFF session; the gate of a page that
//     was rendered without a session calls it and then shows the page (./liff-gate.tsx).
//  3. Renewal (./session-keeper.ts): when the person is active again (a tap, a key, the page coming back into view), a
//     LIFF session near the 15-minute idle limit is renewed with a fresh ID token (FR-AUTH-003 AC1), at most once a
//     minute and never after an answer that will not change; the new session replaces the old one, whose id is gone
//     (NFR-SEC-04). A password sign-in is never renewed with LINE. Pages call ensureSession() before a server action
//     and act on its answer: a final refusal means the session cannot be kept on this page load — reloadForNewToken()
//     for TOKEN_INVALID in the LINE app, otherwise say so — rather than sending the action with an ended session.
// The ID token is held only in memory for one request at a time: never in a URL, storage or a log.

export interface LiffConfig {
  /** NEXT_PUBLIC_LIFF_ID of this environment (ADR-024); null when LIFF is not set up here */
  readonly liffId: string | null
  /**
   * LIFF_MOCK=1 (APP_ENV=local only): the LINE user the page stands for (null: a browser outside LINE), and the name of
   * the cookie that chooses it (./mock-line-user.tsx sets it for a developer)
   */
  readonly mock: { readonly lineUserId: string | null; readonly cookie: string } | null
  /** The session the server rendered this page with: opened with LINE, a password sign-in (web), or none */
  readonly session: LiffSessionKind | null
}

export type LiffStatus = 'loading' | 'ready' | 'failed'

export interface Liff {
  /** The SDK is starting, started, or could not start */
  readonly status: LiffStatus
  /** An ID token can be had: inside the LINE app (or a mocked LINE user) */
  readonly inClient: boolean
  /** Running with LIFF_MOCK (local) */
  readonly mocked: boolean
  /** LIFF_MOCK: the cookie that names the mocked LINE user; null in the LINE app */
  readonly mockCookie: string | null
  /** A fresh ID token, or null outside LINE. Throws when the token could not be fetched (mock) */
  idToken(): Promise<string | null>
  /** Opens a LIFF session with the ID token (one request at a time; parallel calls share it) */
  signIn(): Promise<LiffSignInResult>
  /**
   * Renews a LIFF session first when it may be close to the idle limit, and says whether it can be kept: call before a
   * server action, and do not send it after a final refusal (see LiffSessionCheck)
   */
  ensureSession(): Promise<LiffSessionCheck>
  /**
   * In the LINE app, loads the page again for a new ID token (LINE no longer accepts the one the page has), at most once
   * a minute per tab; false when it did not (LIFF_MOCK, too soon). True means the page is going away.
   */
  reloadForNewToken(): boolean
  /** This tab knows the LINE account is not linked (help stops asking LINE); forgotten after a link or a sign-in */
  readonly unlinked: { remember(): void; known(): boolean; forget(): void }
  /** Back to the LINE chat (inside LINE only; does nothing elsewhere) */
  closeWindow(): void
  /** A page outside the LIFF app (e.g. a workspace page), in the phone's browser when inside LINE */
  openExternal(href: string): void
}

const LiffContext = createContext<Liff | null>(null)

/** The bootstrap of the page; only inside <LiffProvider> (every page under /liff) */
export function useLiff(): Liff {
  const liff = useContext(LiffContext)
  if (!liff) throw new Error('useLiff() works inside <LiffProvider>, which src/app/liff/layout.tsx provides')
  return liff
}

type SdkState = { readonly status: LiffStatus; readonly inClient: boolean }

function tabStorage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function LiffProvider({ config, children }: { readonly config: LiffConfig; readonly children: ReactNode }) {
  const mocked = config.mock !== null
  const mockLineUserId = config.mock?.lineUserId ?? null
  const mockCookie = config.mock?.cookie ?? null
  const { liffId, session } = config
  /** What the real SDK answered (set once its start settled) */
  const [started, setStarted] = useState<SdkState | null>(null)
  const sdkState: SdkState = mocked
    ? { status: 'ready', inClient: mockLineUserId !== null }
    : !liffId
      ? { status: 'failed', inClient: false }
      : (started ?? { status: 'loading', inClient: false })
  const sdk = useRef<Promise<LiffSdk | null> | null>(null)

  // 1. The SDK first (real LINE); with LIFF_MOCK only its module, so the page loads the same scripts
  useEffect(() => {
    if (mocked) {
      void import('./sdk').catch(() => null)
      return
    }
    if (!liffId) return
    let cancelled = false
    const starting = import('./sdk').then(({ initLiff }) => initLiff(liffId))
    sdk.current = starting.catch(() => null)
    starting.then(
      (liff) => {
        if (!cancelled) setStarted({ status: 'ready', inClient: liff.inClient })
      },
      () => {
        if (!cancelled) setStarted({ status: 'failed', inClient: isLineUserAgent(navigator.userAgent) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [mocked, liffId])

  const idToken = useCallback(async (): Promise<string | null> => {
    if (mocked) return mockLineUserId ? mockIdToken(fetch, mockLineUserId) : null
    const liff = sdk.current ? await sdk.current : null
    return liff ? liff.idToken() : null
  }, [mocked, mockLineUserId])

  // 2. and 3. One keeper per page load, made when first needed (an effect or a handler); it always asks the current way
  // to get a token
  const tokenSource = useRef(idToken)
  useEffect(() => {
    tokenSource.current = idToken
  }, [idToken])
  const keeperRef = useRef<LiffSessionKeeper | null>(null)
  const keeper = useCallback(
    (): LiffSessionKeeper =>
      (keeperRef.current ??= createLiffSessionKeeper({ now: () => Date.now(), idToken: () => tokenSource.current(), fetch: (input, init) => fetch(input, init) })),
    [],
  )

  useEffect(() => {
    keeper().seen(session)
  }, [keeper, session])

  const signIn = useCallback(() => keeper().signIn(), [keeper])
  const ensureSession = useCallback(() => keeper().renewIfDue(), [keeper])
  // With LIFF_MOCK the token comes from the fake LINE server: loading the page again would not change it
  const reloadForNewToken = useCallback(() => !mocked && reloadOnce(), [mocked])

  useEffect(() => {
    const onActivity = () => {
      if (document.visibilityState === 'visible') void ensureSession()
    }
    window.addEventListener('pointerdown', onActivity, { capture: true, passive: true })
    window.addEventListener('keydown', onActivity, { capture: true })
    document.addEventListener('visibilitychange', onActivity)
    return () => {
      window.removeEventListener('pointerdown', onActivity, { capture: true })
      window.removeEventListener('keydown', onActivity, { capture: true })
      document.removeEventListener('visibilitychange', onActivity)
    }
  }, [ensureSession])

  // The LINE account of this tab: the mocked LINE user, or the LINE app's own (one LINE account per LIFF window)
  const who = mockLineUserId ?? 'line'
  const unlinked = useMemo(
    () => ({
      remember: () => rememberUnlinked(tabStorage(), who),
      known: () => knownUnlinked(tabStorage(), who),
      forget: () => forgetUnlinked(tabStorage(), who),
    }),
    [who],
  )

  const closeWindow = useCallback(() => {
    void sdk.current?.then((liff) => {
      if (liff?.inClient) liff.closeWindow()
    })
  }, [])

  const openExternal = useCallback((href: string) => {
    const url = new URL(href, window.location.href).toString()
    const inBrowser = () => {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
    if (!sdk.current) {
      inBrowser()
      return
    }
    void sdk.current.then((liff) => (liff?.inClient ? liff.openExternal(url) : inBrowser()))
  }, [])

  const value = useMemo<Liff>(
    () => ({
      status: sdkState.status,
      inClient: sdkState.inClient,
      mocked,
      mockCookie,
      idToken,
      signIn,
      ensureSession,
      reloadForNewToken,
      unlinked,
      closeWindow,
      openExternal,
    }),
    [sdkState.status, sdkState.inClient, mocked, mockCookie, idToken, signIn, ensureSession, reloadForNewToken, unlinked, closeWindow, openExternal],
  )
  return <LiffContext.Provider value={value}>{children}</LiffContext.Provider>
}
