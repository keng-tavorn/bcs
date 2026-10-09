'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Fragment } from 'react'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '../shadcn/breadcrumb'

// The top bar's trail (§9.10 "แถบบน"): on a page deeper than one level, the menu entries above it, each a link, and the
// page itself when it is a menu entry (/settings/pin: ตั้งค่าของฉัน › PIN ยืนยันธุรกรรม). A document page's own name is
// its heading, so its trail stops at the list (/requests/…: คำขอ). Hidden on a small screen, where the bar has no room.

export interface TrailEntry {
  readonly href: string
  readonly label: string
}

/** The menu entries on the way to this page, outermost first; empty on a page one level deep */
export function trailOf(pathname: string, entries: readonly TrailEntry[]): Array<TrailEntry & { readonly current: boolean }> {
  if (pathname.split('/').filter(Boolean).length < 2) return []
  return entries
    .filter((e) => e.href !== '/' && (pathname === e.href || pathname.startsWith(`${e.href}/`)))
    .sort((a, b) => a.href.length - b.href.length)
    .map((e) => ({ ...e, current: e.href === pathname }))
}

export function ShellBreadcrumb({ entries }: { entries: readonly TrailEntry[] }) {
  const trail = trailOf(usePathname(), entries)
  if (trail.length === 0) return null
  return (
    <Breadcrumb className="hidden min-w-0 md:block">
      <BreadcrumbList className="flex-nowrap">
        {trail.map((step, i) => (
          <Fragment key={step.href}>
            {i > 0 ? <BreadcrumbSeparator /> : null}
            <BreadcrumbItem className="min-w-0">
              {step.current ? (
                <BreadcrumbPage className="truncate">{step.label}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild className="truncate">
                  <Link href={step.href}>{step.label}</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
