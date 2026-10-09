'use client'

import { Copy, Ellipsis, FileDown, XCircle } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { cn } from '../cn'
import { Button } from '../shadcn/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../shadcn/dropdown-menu'

// The client parts of the document header (FR-INT-012 AC1, §9.10 "หัว"): the menu ⋯ (print the PDF, copy the link,
// cancel when the reader may) and the one-row header that stays at the top once the full header has scrolled away.

/** Where a cancel form waits on the page: the menu opens it and moves there */
export const CANCEL_ANCHOR = 'cancel-document'

export interface DocMenuLabels {
  readonly menu: string
  readonly pdf: string
  readonly copy: string
  readonly copied: string
  readonly cancel: string
}

export function DocMenu({ pdfHref, cancel, labels }: { pdfHref: string | null; cancel: boolean; labels: DocMenuLabels }) {
  const copy = async () => {
    // The link without the tab chosen: whoever opens it starts at the overview
    const url = new URL(window.location.href)
    url.search = ''
    url.hash = ''
    try {
      await navigator.clipboard.writeText(url.toString())
      toast.success(labels.copied)
    } catch {
      window.prompt(labels.copy, url.toString())
    }
  }
  const openCancel = () => {
    const details = document.querySelector<HTMLDetailsElement>(`#${CANCEL_ANCHOR} details`)
    if (!details) return
    details.open = true
    details.scrollIntoView({ block: 'center' })
    details.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-11 gap-2 px-3 text-base md:text-sm" aria-label={labels.menu}>
          <Ellipsis aria-hidden="true" />
          <span className="hidden sm:inline">{labels.menu}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {pdfHref ? (
          <DropdownMenuItem asChild className="min-h-11 text-base md:text-sm">
            <a href={pdfHref}>
              <FileDown aria-hidden="true" />
              {labels.pdf}
            </a>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem className="min-h-11 text-base md:text-sm" onSelect={() => void copy()}>
          <Copy aria-hidden="true" />
          {labels.copy}
        </DropdownMenuItem>
        {cancel ? (
          <DropdownMenuItem className="min-h-11 text-base text-danger md:text-sm" onSelect={openCancel}>
            <XCircle aria-hidden="true" />
            {labels.cancel}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The header in one row, fixed under the top bar once the full header (`targetId`) has left the screen. It repeats what
 * the header says for the eye only (aria-hidden): screen readers keep the real header, and nothing here takes focus.
 */
export function CompactHeader({ targetId, children }: { targetId: string; children: ReactNode }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const target = document.getElementById(targetId)
    if (!target) return
    // The top bar is 3.5 rem (h-14): the header counts as gone once it is under it
    const observer = new IntersectionObserver(([entry]) => setShown(entry ? !entry.isIntersecting : false), { rootMargin: '-56px 0px 0px 0px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [targetId])
  return (
    <div
      aria-hidden="true"
      data-compact-header=""
      className={cn(
        'fixed inset-x-0 top-14 z-10 flex min-h-11 items-center gap-2 border-b border-line bg-bg px-4 py-1.5 lg:left-(--sidebar-width-icon) lg:px-6 lg:group-has-[[data-slot=sidebar][data-state=expanded]]/sidebar-wrapper:left-(--sidebar-width)',
        // Shown or not at once: no fade, which is decoration (§9.9) and would read as low contrast while it runs
        shown ? 'visible' : 'pointer-events-none invisible',
      )}
    >
      {children}
    </div>
  )
}
