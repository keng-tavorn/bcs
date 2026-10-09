'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '../cn'
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '../shadcn/sidebar'
import { menuIcon } from './menu-icons'

// The sidebar's menu (§9.10, FR-PLT-013 AC2): the groups in the order the shell passes them, a heading over each named
// group, the `footer` group at the bottom. Every entry has an icon and its words; collapsed to icons, each keeps its
// words as aria-label and shows them in a tooltip. The current page is marked with aria-current, a 3 px rule and bold
// text, not colour alone (NFR-A11Y-03). On a small screen the menu is a sheet, which a chosen page closes.

export interface NavEntry {
  readonly key: string
  readonly href: string
  readonly label: string
  readonly group: string
  /** The group's heading; empty for a group without one */
  readonly groupLabel: string
  /** The number beside the entry (§9.10 "ตัวเลขข้างเมนู"), with what it counts in words for screen readers */
  readonly count?: { readonly value: number; readonly label: string }
}

function isCurrent(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * The one entry of the menu the page belongs to: the longest address the page's path starts with, so that the request
 * form (/requests/new/…) marks "ขอซื้อ / ขอจ้าง" alone and not "คำขอ" (/requests) too; null when none matches
 */
export function currentHref(pathname: string, entries: readonly Pick<NavEntry, 'href'>[]): string | null {
  let best: string | null = null
  for (const { href } of entries) if (isCurrent(pathname, href) && (best === null || href.length > best.length)) best = href
  return best
}

/** Entries grouped in their order, each group once */
function grouped(entries: readonly NavEntry[]) {
  const groups: Array<{ key: string; label: string; items: NavEntry[] }> = []
  for (const entry of entries) {
    const last = groups.at(-1)
    if (last?.key === entry.group) last.items.push(entry)
    else groups.push({ key: entry.group, label: entry.groupLabel, items: [entry] })
  }
  return groups
}

function NavGroup({ label, items, current }: { label: string; items: readonly NavEntry[]; current: string | null }) {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarGroup>
      {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5">
          {items.map((item) => {
            const here = item.href === current
            const Icon = menuIcon(item.key)
            const name = item.count ? `${item.label} · ${item.count.label}` : item.label
            return (
              <SidebarMenuItem key={item.key}>
                <SidebarMenuButton
                  asChild
                  isActive={here}
                  tooltip={item.label}
                  className={cn(
                    'relative h-10 text-base text-sidebar-foreground lg:text-sm',
                    here && 'font-semibold before:absolute before:inset-y-1.5 before:left-0 before:w-0.75 before:rounded-full before:bg-sidebar-primary',
                  )}
                >
                  <Link href={item.href} aria-current={here ? 'page' : undefined} aria-label={name} onClick={() => setOpenMobile(false)}>
                    <Icon aria-hidden="true" />
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
                {item.count && item.count.value > 0 ? <SidebarMenuBadge aria-hidden="true">{item.count.value}</SidebarMenuBadge> : null}
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

/** The menu: every group but `footer` in the scrolling middle, `footer` pinned to the bottom */
export function NavLinks({ entries, label }: { entries: readonly NavEntry[]; label: string }) {
  const pathname = usePathname()
  const current = currentHref(pathname, entries)
  const groups = grouped(entries)
  const body = groups.filter((g) => g.key !== 'footer')
  const footer = groups.filter((g) => g.key === 'footer')
  return (
    <nav aria-label={label} className="flex min-h-0 flex-1 flex-col">
      <SidebarContent>
        {body.map((g) => (
          <NavGroup key={g.key} label={g.label} items={g.items} current={current} />
        ))}
      </SidebarContent>
      {footer.length > 0 ? (
        <SidebarFooter className="border-t border-sidebar-border p-0">
          {footer.map((g) => (
            <NavGroup key={g.key} label={g.label} items={g.items} current={current} />
          ))}
        </SidebarFooter>
      ) : null}
    </nav>
  )
}
