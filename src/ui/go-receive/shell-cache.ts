'use client'

// /go/receive opens without a signal once it was opened with one (S17-13, BR-APP-03, §9.7): the page hands the service
// worker (src/app/sw.js) the hashed static files it loaded — its scripts, styles and fonts under /_next/static — and the
// worker keeps them beside the page's shell. Nothing of the page's data is in either: copies and receipts live in the
// phone's IndexedDB (./store.ts). Without a worker (a development build, a browser without one) nothing happens.

const STATIC_PREFIX = '/_next/static/'

/** The static files of this origin that the page has loaded so far */
function loadedStatics(): string[] {
  const out = new Set<string>()
  for (const entry of performance.getEntriesByType('resource')) {
    const url = new URL(entry.name)
    if (url.origin === window.location.origin && url.pathname.startsWith(STATIC_PREFIX)) out.add(`${url.pathname}${url.search}`)
  }
  return [...out]
}

export function keepShellOffline(): void {
  if (!('serviceWorker' in navigator)) return
  void navigator.serviceWorker.ready
    .then((registration) => registration.active?.postMessage({ type: 'GO_KEEP_SHELL', assets: loadedStatics() }))
    .catch(() => undefined)
}
