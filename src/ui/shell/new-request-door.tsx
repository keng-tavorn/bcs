import { FilePlus2 } from 'lucide-react'
import Link from 'next/link'
import type { MouseEventHandler } from 'react'
import { cn } from '../cn'

// The one door (§9.9 principle 2, FR-PLT-013 AC3 AC4): "ขอซื้อ / ขอจ้าง" as the main button, a capsule in the top bar
// of every page of the workspace, a phone's too. The shell draws it only for a member who may create requests (its menu
// entry is there, request.create). It steps aside by what the page shows, not by its address: the door's own content —
// the catalogue of request types and the request form — carries DOOR_ASIDE, and while the page holds it the door is
// hidden. So the form keeps the page to itself at every address it has — /requests/new/[type], and /requests/[id]/edit
// for a draft or a returned request, which a new form moves to when its first save creates the draft — and the
// confirmation once sent, which has no form, offers the door again for the next request.

/** What the door's own content carries (spread on its root): while the page shows it, the door steps aside */
export const DOOR_ASIDE = { 'data-door-aside': '' } as const

/**
 * Hidden while the page holds DOOR_ASIDE (`body:has([data-door-aside])`): set on the door's wrapper. Tailwind reads each
 * class whole, so the selector is written out.
 */
export const DOOR_HIDDEN = '[body:has([data-door-aside])_&]:hidden'

const DOOR_CLASS =
  'inline-flex max-w-full min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-3 text-center font-medium whitespace-nowrap text-primary-foreground transition-colors duration-150 hover:bg-primary-hover active:bg-primary-hover sm:px-4 lg:min-h-10'

export function NewRequestDoor({
  href,
  label,
  className,
  linkClassName,
  onClick,
}: {
  href: string
  label: string
  className?: string
  linkClassName?: string
  /** Opens the dialog that starts a new request in place of the page (./new-request-door-dialog.tsx, FR-INT-010) */
  onClick?: MouseEventHandler<HTMLAnchorElement>
}) {
  return (
    // The last thing in the top bar to give way, on a phone only: with a long count on the bell its words shorten (its
    // name stays whole for screen readers) rather than push the bar wider than the screen or over the menu button. From
    // 768 px it keeps its width and the breadcrumb shortens instead.
    <div data-door="" className={cn('min-w-0 md:shrink-0', className, DOOR_HIDDEN)}>
      <Link href={href} className={cn(DOOR_CLASS, linkClassName)} onClick={onClick} aria-haspopup={onClick ? 'dialog' : undefined}>
        <FilePlus2 className="hidden size-4 shrink-0 sm:block" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </Link>
    </div>
  )
}
