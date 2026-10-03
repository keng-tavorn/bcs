'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '../form/button'

// Registers the service worker in production builds and offers to reload when a new version is ready (spec §9.7).
// The page reloads only after the user chose "update now" in this tab: the first install also changes the controller
// (clients.claim), and reloading then would wipe whatever the user had already typed. The banner says to save first,
// can be put off until later, and sticks to the bottom of the screen inside the page flow, so it never hides the last
// control of a page (scroll to the end and it sits below it).
export function PwaRegistration({ labels }: { labels: { updateReady: string; updateNow: string; updateLater: string } }) {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const updateRequested = useRef(false)

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return
    let reloading = false
    const onControllerChange = () => {
      if (!updateRequested.current || reloading) return
      reloading = true
      window.location.reload()
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        if (registration.waiting && navigator.serviceWorker.controller) setWaiting(registration.waiting)
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) setWaiting(worker)
          })
        })
      })
      .catch(() => undefined)
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
  }, [])

  if (!waiting || dismissed) return null
  return (
    <div role="status" className="sticky inset-x-0 bottom-0 z-50 border-t border-line bg-surface px-4 py-3">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3">
        <p className="font-medium">{labels.updateReady}</p>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => setDismissed(true)}>
            {labels.updateLater}
          </Button>
          <Button
            onClick={() => {
              updateRequested.current = true
              // Another tab may have switched to the new version already (the worker is no longer waiting): this page
              // only needs a reload, and no second controllerchange would come to trigger it
              if (waiting.state !== 'installed') return window.location.reload()
              waiting.postMessage('SKIP_WAITING')
            }}
          >
            {labels.updateNow}
          </Button>
        </div>
      </div>
    </div>
  )
}
