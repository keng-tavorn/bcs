import { Ban, CircleAlert, CircleCheck, CircleMinus, CircleSlash, CircleX, Clock, FilePen, Lock, PackageCheck, PauseCircle, Send, TriangleAlert, Undo2, type LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { cn } from '../cn'

// States of the budget screens as an icon and words, never colour alone (NFR-A11Y-03). Labels arrive translated.

function Badge({ Icon, tone, label, className }: { Icon: LucideIcon; tone: string; label: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-start gap-1.5', className)}>
      <Icon className={cn('mt-[0.3em] size-4 shrink-0', tone)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}

/**
 * Below digest.budgetLowPct: "ใกล้หมด เหลือ 8.3%", in the warning colour; nothing left (`out`): "งบหมด เหลือ 0.00 บาท",
 * in the danger colour the token table gives to งบไม่พอ (§9.9). With a `link` the warning's number opens what it counts
 * (§9.9: every number opens its list) — the ledger's movements behind what is left — and keeps its icon in the warning's
 * or the danger's colour in front: the words are a link like every other one of the page, --primary and underlined (§9.9
 * tokens: --primary is for links), named with the warning first and where it leads after. The icon and the words say
 * what it warns of, so the link's colour takes nothing away from the warning.
 */
export function LowBadge({ label, out, link, className }: { label: string; out?: boolean; link?: { readonly href: string; readonly label: string } | null; className?: string }) {
  const Icon = out ? CircleAlert : TriangleAlert
  const tone = out ? 'text-danger' : 'text-warn'
  if (!link) return <Badge Icon={Icon} tone={tone} label={label} className={cn('font-medium text-ink', className)} />
  return (
    <Link href={link.href} aria-label={link.label} className={cn('inline-flex items-start gap-1.5 self-start font-medium text-primary underline underline-offset-4 hover:no-underline', className)}>
      <Icon className={cn('mt-[0.3em] size-4 shrink-0', tone)} aria-hidden="true" />
      <span>{label}</span>
    </Link>
  )
}

/** A line that takes no new reservation (FROZEN) or is closed; an open line shows nothing */
export function LineStatusBadge({ status, label, className }: { status: 'FROZEN' | 'CLOSED'; label: string; className?: string }) {
  return status === 'FROZEN' ? <Badge Icon={PauseCircle} tone="text-warn" label={label} className={className} /> : <Badge Icon={Lock} tone="text-ink-muted" label={label} className={className} />
}

const DOCUMENT_LOOK: Readonly<Record<string, { Icon: LucideIcon; tone: string }>> = {
  DRAFT: { Icon: FilePen, tone: 'text-ink-muted' },
  PENDING_APPROVAL: { Icon: Clock, tone: 'text-warn' },
  RETURNED: { Icon: Undo2, tone: 'text-warn' },
  APPROVED: { Icon: CircleCheck, tone: 'text-primary' },
  PARTIALLY_ORDERED: { Icon: PackageCheck, tone: 'text-primary' },
  ORDERED: { Icon: PackageCheck, tone: 'text-primary' },
  COMPLETED: { Icon: CircleCheck, tone: 'text-primary' },
  SENT: { Icon: Send, tone: 'text-primary' },
  PARTIALLY_RECEIVED: { Icon: PackageCheck, tone: 'text-primary' },
  RECEIVED: { Icon: PackageCheck, tone: 'text-primary' },
  CLOSED: { Icon: CircleCheck, tone: 'text-ink-muted' },
  REJECTED: { Icon: CircleX, tone: 'text-danger' },
  CANCELLED: { Icon: Ban, tone: 'text-ink-muted' },
}

/** A request's or a PO's status */
export function DocumentStatus({ status, label, className }: { status: string; label: string; className?: string }) {
  const { Icon, tone } = DOCUMENT_LOOK[status] ?? DOCUMENT_LOOK.DRAFT!
  return <Badge Icon={Icon} tone={tone} label={label} className={className} />
}

const GRANT_LOOK = {
  ACTIVE: { Icon: CircleCheck, tone: 'text-primary' },
  SCHEDULED: { Icon: Clock, tone: 'text-warn' },
  ENDED: { Icon: CircleMinus, tone: 'text-ink-muted' },
  REVOKED: { Icon: CircleSlash, tone: 'text-ink-muted' },
} as const

export type GrantStateName = keyof typeof GRANT_LOOK

/** A grant in force, coming, ended or taken back */
export function GrantState({ state, label, className }: { state: GrantStateName; label: string; className?: string }) {
  const { Icon, tone } = GRANT_LOOK[state]
  return <Badge Icon={Icon} tone={tone} label={label} className={cn('font-medium', className)} />
}
