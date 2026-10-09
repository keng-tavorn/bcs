'use client'

import { usePathname } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { SIDEBAR_COOKIE_MAX_AGE, SIDEBAR_COOKIE_NAME, SidebarProvider } from '../shadcn/sidebar'
import { TooltipProvider } from '../shadcn/tooltip'

// Whether the sidebar is open (FR-PLT-013 AC2): the member's last choice, kept in the browser (the sidebar's cookie,
// which the layout reads to draw the first page the same way), except on a document page, which opens collapsed for
// a wider page; a choice made on a document page holds for that page only.

/** A request, its approval task or a PO: the pages of one document (S16-07) */
export function isDocumentPage(pathname: string): boolean {
  return /^\/(?:requests|tasks|procurement\/pos)\/(?!new(?:\/|$))[^/]+$/.test(pathname)
}

export function ShellFrame({ defaultOpen, children }: { defaultOpen: boolean; children: ReactNode }) {
  const pathname = usePathname()
  const [preference, setPreference] = useState(defaultOpen)
  const [documentChoice, setDocumentChoice] = useState<{ readonly pathname: string; readonly open: boolean } | null>(null)
  const documentPage = isDocumentPage(pathname)
  const open = documentPage ? (documentChoice?.pathname === pathname ? documentChoice.open : false) : preference

  const onOpenChange = (next: boolean) => {
    if (documentPage) {
      setDocumentChoice({ pathname, open: next })
      return
    }
    setPreference(next)
    document.cookie = `${SIDEBAR_COOKIE_NAME}=${next}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; samesite=lax`
  }

  return (
    <TooltipProvider>
      <SidebarProvider open={open} onOpenChange={onOpenChange} className="bg-bg">
        {children}
      </SidebarProvider>
    </TooltipProvider>
  )
}
