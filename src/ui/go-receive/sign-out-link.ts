'use client'

// BR-APP-09 (FR-PLT-301 AC9) on every sign-out of this phone, not only the one of /go/receive: the menu's "ออกจากระบบ"
// (src/ui/auth/sign-out-button.tsx) asks here whether the receiving queue holds anything, and if so opens /go/receive
// with its sign-out warning, which sends what may be recorded first, warns by kind and deletes the queue once confirmed.
// The queue's code (IndexedDB through ./store.ts) is loaded only when the button is pressed.

/** /go/receive with its sign-out warning open */
export const GO_SIGN_OUT_PARAM = 'signOut'
export const GO_SIGN_OUT_PATH = `/go/receive?${GO_SIGN_OUT_PARAM}=1`

/** Receipts kept on this phone, of anyone (0 when the phone keeps none or storage cannot be read) */
export async function receiptsOnPhone(): Promise<number> {
  try {
    const { readQueue } = await import('./store')
    return (await readQueue()).length
  } catch {
    return 0
  }
}

/** The page was opened to sign out (the param is taken off the address so a reload does not ask again) */
export function openedToSignOut(): boolean {
  const params = new URLSearchParams(window.location.search)
  if (params.get(GO_SIGN_OUT_PARAM) !== '1') return false
  params.delete(GO_SIGN_OUT_PARAM)
  const rest = params.toString()
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`)
  return true
}
