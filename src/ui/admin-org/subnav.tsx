import Link from 'next/link'
import { cn } from '../cn'

// The three parts of the organization structure pages (spec §9.1 /admin/org): departments, cost centers, positions.
// Links, the current one marked with aria-current, a rule and bold text, not colour alone (NFR-A11Y-03).

export type OrgSection = 'departments' | 'costCenters' | 'positions'

const HREF: Record<OrgSection, string> = {
  departments: '/admin/org',
  costCenters: '/admin/org/cost-centers',
  positions: '/admin/org/positions',
}

const ORDER: readonly OrgSection[] = ['departments', 'costCenters', 'positions']

export function OrgSubnav({ current, label, labels }: { current: OrgSection; label: string; labels: Readonly<Record<OrgSection, string>> }) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-x-6 border-b border-line">
        {ORDER.map((section) => {
          const active = section === current
          return (
            <li key={section}>
              <Link
                href={HREF[section]}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px inline-flex min-h-11 items-center border-b-2 px-0.5 font-medium transition-colors duration-150',
                  active ? 'border-primary font-semibold text-ink' : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {labels[section]}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
