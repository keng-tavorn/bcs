'use client'

import { useEffect } from 'react'

// The RFx page's one write (S10-07 · FR-SRC-202 AC1): after the page has loaded, it POSTs portal.rfx.view once with the
// CSRF header — the GET of the page writes nothing (§17.3). Drawn only while the invite is still INVITED; a second
// load sends the same idempotency key and changes nothing. Nothing is shown.

export function MarkViewed({ action, csrf, rfxEventId }: { readonly action: string; readonly csrf: string; readonly rfxEventId: string }) {
  useEffect(() => {
    const body = new FormData()
    body.set('action', 'view')
    body.set('rfxEventId', rfxEventId)
    body.set('csrf', csrf)
    void fetch(action, { method: 'POST', body, headers: { 'x-bcs-portal-csrf': csrf } }).catch(() => undefined)
  }, [action, csrf, rfxEventId])
  return null
}
