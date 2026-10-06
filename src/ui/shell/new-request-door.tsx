'use client'

import { FilePlus2 } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '../cn'

// The one door (§9.9 principle 2): "ขอซื้อ / ขอจ้าง" as the main button, seen from every page of the workspace — in the
// bar above the content on a wide screen, in its own row under the header on a phone, where the menu is closed. The
// shell draws it only for a member who may create requests (its menu entry is there, request.create); on the door's own
// pages (the catalogue and the form, under its address) it steps aside, since the page is where it leads.

const DOOR_CLASS =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-center font-medium text-primary-foreground underline-offset-4 transition-colors duration-150 hover:underline'

/** Whether the page is the door's own: its address or one under it */
export const atDoor = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`)

export function NewRequestDoor({ href, label, className, linkClassName }: { href: string; label: string; className?: string; linkClassName?: string }) {
  const pathname = usePathname()
  if (atDoor(pathname, href)) return null
  return (
    <div className={className}>
      <Link href={href} className={cn(DOOR_CLASS, linkClassName)}>
        <FilePlus2 className="size-4 shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </Link>
    </div>
  )
}
