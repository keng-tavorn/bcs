'use client'

import { useRouter } from 'next/navigation'
import type { MouseEvent, ReactNode } from 'react'

// A light link inside the app: an ordinary <a href> that, on a plain tap, moves without loading the page again
// (router.push). next/link does the same, but it brings some 4 to 5 KB gzip of client code into the first JavaScript of
// every page that renders it, even from a server component. The pages that render on every route — the root error and
// not-found boundaries (src/app/error.tsx, src/app/not-found.tsx) — and the LIFF pages, whose first JavaScript is at most
// 200 KB gzip with the LINE SDK (§9.4; src/ui/liff/liff-link.tsx), use this one instead. No prefetching: the pages it
// leads to are dynamic. A link that leaves the app (another site, a page that must load anew) is a plain <a>.

/** Looks like a text link, at least 44 px high (NFR-A11Y-02) */
export const LIGHT_LINK_CLASS = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

export function LightLink({ href, className, children }: { readonly href: string; readonly className?: string; readonly children: ReactNode }) {
  const router = useRouter()
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // Let the browser handle a new tab, a download or a modified click
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    router.push(href)
  }
  return (
    <a href={href} className={className ?? LIGHT_LINK_CLASS} onClick={onClick}>
      {children}
    </a>
  )
}
