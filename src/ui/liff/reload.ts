import { MS_PER_MINUTE } from '@/lib/constants'

// In the LINE app, liff.getIDToken() hands out the ID token liff.init() got when the page loaded. Once LINE no longer
// accepts it (it expired while the page stayed open), only a new page load brings a new one: the gate (./liff-gate.tsx)
// and a page about to run a server action (useLiff().reloadForNewToken(), after ensureSession() said so) load the page
// again — at most once a minute per tab, so a token LINE keeps refusing never turns into a loop of page loads.

const RELOAD_KEY = 'bcs-liff-reloaded-at'
const RELOAD_EVERY_MS = MS_PER_MINUTE

/** Loads the page again for a fresh ID token; false when it did not (it did less than a minute ago, or no storage) */
export function reloadOnce(): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? '0')
    if (Date.now() - last < RELOAD_EVERY_MS) return false
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    return false
  }
  window.location.reload()
  return true
}
