import Link from 'next/link'
import { cn } from '../cn'
import { BUDGET_BADGES, PO_BADGES, REQUEST_BADGES, StatusBadge, type BadgeLook } from '../document/badges'

// States of the budget screens as the status badges of §9.10 (S16-10): a light background with its ink, a lucide icon
// and words, never colour alone (NFR-A11Y-03). The looks come from the one table of src/ui/document/badges.tsx; labels
// arrive translated. Badges wrap on narrow screens, so a long amount in the words never pushes a phone sideways.

const WRAP = 'h-auto whitespace-normal text-base md:text-sm'

/**
 * Below digest.budgetLowPct: "ใกล้หมด เหลือ 8.3%", the badge งบใกล้หมด (warn); nothing left (`out`): "งบหมด เหลือ 0.00
 * บาท", the badge งบไม่พอ (danger) — the wallet icon of §9.10 in both, the words telling them apart. With a `link` the
 * warning's number opens what it counts (§9.9: every number opens its list) — the ledger's movements behind what is left:
 * the badge sits inside a link like every other one of the page (--primary, underlined), named with the warning first and
 * where it leads after. The badge's own ink and icon say what it warns of, so the link takes nothing away from the warning.
 */
export function LowBadge({ label, out, link, className }: { label: string; out?: boolean; link?: { readonly href: string; readonly label: string } | null; className?: string }) {
  const look = BUDGET_BADGES[out ? 'SHORT' : 'LOW']
  if (!link) return <StatusBadge look={look} label={label} className={cn(WRAP, className)} />
  return (
    <Link href={link.href} aria-label={link.label} className={cn('group inline-flex self-start rounded-4xl text-primary underline underline-offset-4 hover:no-underline', className)}>
      <StatusBadge look={look} label={label} className={cn(WRAP, 'underline underline-offset-4 group-hover:no-underline')} />
    </Link>
  )
}

const LINE_LOOK: Readonly<Record<'FROZEN' | 'CLOSED', BadgeLook>> = {
  FROZEN: { tone: 'warn', icon: 'Ban' },
  CLOSED: { tone: 'neutral', icon: 'Lock' },
}

/** A line that takes no new reservation (FROZEN) or is closed; an open line shows nothing */
export function LineStatusBadge({ status, label, className }: { status: 'FROZEN' | 'CLOSED'; label: string; className?: string }) {
  return <StatusBadge look={LINE_LOOK[status]} label={label} className={cn(WRAP, className)} />
}

/** A request's or a PO's status: the badges of §9.10 (the PO's own looks for the statuses only a PO has) */
export function DocumentStatus({ status, label, className }: { status: string; label: string; className?: string }) {
  return <StatusBadge look={REQUEST_BADGES[status] ?? PO_BADGES[status]} label={label} className={cn(WRAP, className)} />
}

const GRANT_LOOK = {
  ACTIVE: { tone: 'ok', icon: 'CircleCheck' },
  SCHEDULED: { tone: 'info', icon: 'Clock' },
  ENDED: { tone: 'neutral', icon: 'Lock' },
  REVOKED: { tone: 'neutral', icon: 'Ban' },
} as const satisfies Record<string, BadgeLook>

export type GrantStateName = keyof typeof GRANT_LOOK

/** A grant in force, coming, ended or taken back */
export function GrantState({ state, label, className }: { state: GrantStateName; label: string; className?: string }) {
  return <StatusBadge look={GRANT_LOOK[state]} label={label} className={cn(WRAP, className)} />
}
