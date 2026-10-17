// Service worker (spec §9.7, FR-PLT-005 AC2). It precaches only the offline page, the manifest and the icons; every
// other request (pages, data, API, files) always goes to the network and is never stored, so no business data is
// kept on the device in tier 1. A navigation that fails offline shows the Thai offline page. A new build changes
// VERSION, so the browser installs the new worker and the page offers to reload (no web push in tier 1).
// POST requests never reach the worker where the browser has the Static Routing API (InstallEvent.addRoutes): they go
// straight to the network. A page that is left sends its draft as a keepalive POST (FR-INT-006 AC1). When the page is
// replaced by another one in the same window (a link, a reload, a new address), Chromium drops that request if the
// worker controls the page, even though the fetch handler leaves every request but GET alone: measured in Chromium 153,
// no save arrived with the worker and all of them arrived with the rule or with no worker; a tab closed outright
// delivered its save either way. tests/e2e/pwa.spec.ts checks the rule, tests/e2e/liff-requests.spec.ts the saves with
// the worker in place. Where the API is missing, nothing changes: the fetch handler still ignores POST requests.
// One page is kept for use without a signal (S17-13, BR-APP-03, FR-PLT-301): /go/receive, BCS Go's receiving, whose
// HTML is a shell with no business data (its data lives in the phone's IndexedDB). Opened with a signal, the page is
// stored as it came, and the page hands the worker the hashed static files it loaded (/_next/static/…) to keep beside
// it; without a signal the stored page opens with them. Nothing else of /_next/static is kept, no response of data is
// ever stored, and a new build starts with an empty store (the page fills it again the next time it is opened). Other
// pages' static files are not touched while there is a signal.

export const dynamic = 'force-static'

const VERSION = process.env.APP_COMMIT_SHA || `build-${process.env.BCS_BUILD_STAMP}`
const PRECACHE = ['/offline', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png']

const GO_SHELL = '/go/receive'
/** The static files a page may hand over at once: more than any page loads, a cap on what a message can make it fetch */
const GO_ASSETS_MAX = 300

const SCRIPT = `
const CACHE = ${JSON.stringify(`bcs-shell-${VERSION}`)};
const PRECACHE = ${JSON.stringify(PRECACHE)};
const GO_CACHE = ${JSON.stringify(`bcs-go-${VERSION}`)};
const GO_SHELL = ${JSON.stringify(GO_SHELL)};
const GO_ASSETS_MAX = ${GO_ASSETS_MAX};
const STATIC_PREFIX = '/_next/static/';

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([postToNetwork(event), caches.open(CACHE).then((cache) => cache.addAll(PRECACHE))]));
});

// The rule is added during the install event; a browser that refuses it still installs the worker
function postToNetwork(event) {
  if (!event.addRoutes) return undefined;
  try {
    return Promise.resolve(event.addRoutes({ condition: { requestMethod: 'POST' }, source: 'network' })).catch(() => undefined);
  } catch {
    return undefined;
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('bcs-') && key !== CACHE && key !== GO_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  else if (event.data && event.data.type === 'GO_KEEP_SHELL') event.waitUntil(keepGoShell(event.data.assets));
});

// A request of the page /go/receive itself (its scripts and styles; a font a style asks for names the style instead)
function fromGoShell(request) {
  try {
    const referrer = new URL(request.referrer);
    return referrer.origin === self.location.origin && referrer.pathname === GO_SHELL;
  } catch {
    return false;
  }
}

// The page /go/receive and the static files it loaded, from this origin only
function keepGoShell(assets) {
  const statics = (Array.isArray(assets) ? assets : [])
    .filter((path) => typeof path === 'string' && path.startsWith(STATIC_PREFIX) && !path.includes('..'))
    .slice(0, GO_ASSETS_MAX);
  return caches.open(GO_CACHE).then((cache) => Promise.all([
    fetch(GO_SHELL, { credentials: 'same-origin', cache: 'no-store' }).then((res) => (res.ok && !res.redirected ? cache.put(GO_SHELL, res) : undefined)),
    ...statics.map((path) => cache.match(path).then((hit) => hit || fetch(path).then((res) => (res.ok ? cache.put(path, res) : undefined)))),
  ])).catch(() => undefined);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const own = url.origin === self.location.origin;
  if (request.mode === 'navigate') {
    if (own && url.pathname === GO_SHELL) {
      event.respondWith(fetch(request).then((res) => {
        if (res.ok && !res.redirected) {
          const copy = res.clone();
          event.waitUntil(caches.open(GO_CACHE).then((cache) => cache.put(GO_SHELL, copy)).catch(() => undefined));
        }
        return res;
      }).catch(() => caches.match(GO_SHELL, { cacheName: GO_CACHE }).then((hit) => hit || caches.match('/offline'))));
      return;
    }
    event.respondWith(fetch(request).catch(() => caches.match('/offline')));
    return;
  }
  if (own && PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
    return;
  }
  // The hashed files of /go/receive, once the page handed them over: for that page (its requests name it as their
  // referrer) or without a signal. Every other page's static files are left to the network as before the worker knew them
  if (own && url.pathname.startsWith(STATIC_PREFIX) && (fromGoShell(request) || !self.navigator.onLine)) {
    event.respondWith(caches.match(request, { cacheName: GO_CACHE }).then((hit) => hit || fetch(request)));
  }
});
`

export function GET() {
  return new Response(SCRIPT, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      'service-worker-allowed': '/',
    },
  })
}
