'use client'

import {
  Blocks,
  Building,
  Building2,
  ClipboardList,
  FileDown,
  FilePlus2,
  FileText,
  Gauge,
  GitBranch,
  History,
  House,
  Inbox,
  KeyRound,
  Layers,
  Network,
  PackageCheck,
  Receipt,
  ShieldCheck,
  ShoppingCart,
  ChartColumn,
  Users,
  Wallet,
  type LucideIcon,
  CalendarDays,
  Hash,
  LayoutList,
  ListTree,
  UserCheck,
  BellRing,
  MessageCircle,
  MessagesSquare,
  RectangleEllipsis,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '../cn'

// Menu links with an icon and a label (never icon-only); the current page is marked with aria-current, a rule and
// bold text, not colour alone (NFR-A11Y-03).

const ICONS: Record<string, LucideIcon> = {
  home: House,
  newRequest: FilePlus2,
  requests: FileText,
  tasks: Inbox,
  receiving: PackageCheck,
  pool: Layers,
  pos: ShoppingCart,
  suppliers: Building2,
  invoices: Receipt,
  exports: FileDown,
  budgets: Wallet,
  board: ClipboardList,
  reports: ChartColumn,
  kpi: Gauge,
  audit: ShieldCheck,
  members: Users,
  org: ListTree,
  calendar: CalendarDays,
  numbering: Hash,
  requestTypes: LayoutList,
  doa: GitBranch,
  orgAuthority: Network,
  policyHistory: History,
  modules: Blocks,
  tenants: Building,
  delegation: UserCheck,
  security: KeyRound,
  line: MessagesSquare,
  pin: RectangleEllipsis,
  lineLink: MessageCircle,
  notifications: BellRing,
}

export interface NavEntry {
  readonly key: string
  readonly href: string
  readonly label: string
  readonly group: string
  readonly groupLabel: string
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

export function NavLinks({ entries }: { entries: readonly NavEntry[] }) {
  const pathname = usePathname()
  const current = currentHref(pathname, entries)
  const groups: Array<{ key: string; label: string; items: NavEntry[] }> = []
  for (const entry of entries) {
    const last = groups.at(-1)
    if (last?.key === entry.group) last.items.push(entry)
    else groups.push({ key: entry.group, label: entry.groupLabel, items: [entry] })
  }
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          {groups.length > 1 ? <p className="px-3 text-base font-medium text-ink-muted md:text-sm">{group.label}</p> : null}
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const here = item.href === current
              const Icon = ICONS[item.key] ?? FileText
              return (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    aria-current={here ? 'page' : undefined}
                    // On phones the menu sits in a <details> over the page; close it once a page is chosen
                    onClick={(event) => event.currentTarget.closest('details')?.removeAttribute('open')}
                    className={cn(
                      'flex min-h-11 items-center gap-3 rounded-md border-l-2 px-3 py-2 text-ink transition-colors duration-150 hover:bg-bg',
                      here ? 'border-primary bg-bg font-semibold' : 'border-transparent',
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span>{item.label}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
