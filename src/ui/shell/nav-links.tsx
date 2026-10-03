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
  doa: GitBranch,
  orgAuthority: Network,
  policyHistory: History,
  modules: Blocks,
  tenants: Building,
  security: KeyRound,
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

export function NavLinks({ entries }: { entries: readonly NavEntry[] }) {
  const pathname = usePathname()
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
              const current = isCurrent(pathname, item.href)
              const Icon = ICONS[item.key] ?? FileText
              return (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    aria-current={current ? 'page' : undefined}
                    // On phones the menu sits in a <details> over the page; close it once a page is chosen
                    onClick={(event) => event.currentTarget.closest('details')?.removeAttribute('open')}
                    className={cn(
                      'flex min-h-11 items-center gap-3 rounded-md border-l-2 px-3 py-2 text-ink transition-colors duration-150 hover:bg-bg',
                      current ? 'border-primary bg-bg font-semibold' : 'border-transparent',
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
