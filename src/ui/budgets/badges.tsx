import { Ban, CircleAlert, CircleCheck, CircleMinus, CircleSlash, CircleX, Clock, FilePen, Lock, PackageCheck, PauseCircle, Send, TriangleAlert, Undo2, type LucideIcon } from 'lucide-react'
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
 * in the danger colour the token table gives to งบไม่พอ (§9.9)
 */
export function LowBadge({ label, out, className }: { label: string; out?: boolean; className?: string }) {
  return out ? (
    <Badge Icon={CircleAlert} tone="text-danger" label={label} className={cn('font-medium text-ink', className)} />
  ) : (
    <Badge Icon={TriangleAlert} tone="text-warn" label={label} className={cn('font-medium text-ink', className)} />
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
