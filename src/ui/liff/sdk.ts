import liff from '@line/liff/core'
import CloseWindow from '@line/liff/close-window'
import GetIDToken from '@line/liff/get-id-token'
import IsInClient from '@line/liff/is-in-client'
import IsLoggedIn from '@line/liff/is-logged-in'
import OpenWindow from '@line/liff/open-window'

// The LINE LIFF SDK, loaded only through import() by ./liff-provider.tsx so it never counts in the first JavaScript of a
// LIFF page (§9.4: at most 200 KB gzip). The pluggable SDK with the five calls BCS uses, about a third smaller than the
// whole SDK. liff.init() runs once per page load, before the bootstrap asks for anything (§9.4); with ?liff.state= on
// /liff it also takes the browser on to the deep-linked page.

export interface LiffSdk {
  /** Running inside the LINE app (not an outside browser) */
  readonly inClient: boolean
  /** liff.getIDToken() when LINE has signed the person in to the LIFF app; null outside LINE */
  idToken(): string | null
  closeWindow(): void
  /** Opens a page in the phone's browser (outside LINE) */
  openExternal(url: string): void
}

let started: Promise<LiffSdk> | null = null

/** Starts the SDK once per page load; every later call gets the same answer */
export function initLiff(liffId: string): Promise<LiffSdk> {
  started ??= start(liffId)
  return started
}

async function start(liffId: string): Promise<LiffSdk> {
  liff.use(new GetIDToken())
  liff.use(new IsInClient())
  liff.use(new IsLoggedIn())
  liff.use(new CloseWindow())
  liff.use(new OpenWindow())
  await liff.init({ liffId })
  return {
    inClient: liff.isInClient(),
    idToken: () => (liff.isLoggedIn() ? liff.getIDToken() : null),
    closeWindow: () => liff.closeWindow(),
    openExternal: (url) => {
      void liff.openWindow({ url, external: true })
    },
  }
}
