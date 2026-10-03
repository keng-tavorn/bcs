// Service worker (spec §9.7, FR-PLT-005 AC2). It precaches only the offline page, the manifest and the icons; every
// other request (pages, data, API, files) always goes to the network and is never stored, so no business data is
// kept on the device in tier 1. A navigation that fails offline shows the Thai offline page. A new build changes
// VERSION, so the browser installs the new worker and the page offers to reload (no web push in tier 1).

export const dynamic = 'force-static'

const VERSION = process.env.APP_COMMIT_SHA || `build-${Date.now()}`
const PRECACHE = ['/offline', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png']

const SCRIPT = `
const CACHE = ${JSON.stringify(`bcs-shell-${VERSION}`)};
const PRECACHE = ${JSON.stringify(PRECACHE)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('bcs-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline')));
    return;
  }
  const url = new URL(request.url);
  if (url.origin === self.location.origin && PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
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
