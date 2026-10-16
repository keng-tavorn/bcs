'use client'

import type { MouseEvent, ReactNode } from 'react'
import { useLiff } from './liff-provider'

// A link from a LIFF page to a web page that has no LIFF page (FR-LINE-302 AC2): on a plain tap it opens outside LINE —
// liff.openExternal in the LINE app, a new tab in a browser (useLiff().openExternal) — so the member keeps the LIFF page
// and sees the workspace in the phone's browser. An ordinary <a href> underneath: a modified click, or a page whose
// script has not run yet, still reaches the page.

export function LiffWebLink({ href, className, children }: { readonly href: string; readonly className?: string; readonly children: ReactNode }) {
  const liff = useLiff()
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    liff.openExternal(href)
  }
  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  )
}
