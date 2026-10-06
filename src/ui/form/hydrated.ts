'use client'

import { useSyncExternalStore } from 'react'

// Whether the page's script runs yet. A form whose submit is handled in the browser (onSubmit calling a server action)
// does nothing safe before React hydrates it: the browser would submit it natively, to the address of the page. So the
// submit button of such a form waits for this (a disabled default button also stops pressing Enter in a field), and the
// form says method="post", so that even a native submission never writes what was typed — a password, a secret — into
// the address, the browser's history, a request log or a Referer header (NFR-SEC-09).
//
// false in the server's HTML and while React hydrates it, then true; true at once on a page opened by client navigation.

const subscribe = () => () => undefined
const inBrowser = () => true
const onServer = () => false

/** True once React runs this page in the browser (false in the server's HTML and during hydration) */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, inBrowser, onServer)
}
