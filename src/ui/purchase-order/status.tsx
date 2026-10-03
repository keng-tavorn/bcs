import { Ban, CircleCheck, CircleX, Clock, FilePen, PackageCheck, PackageOpen, Send, type LucideIcon } from 'lucide-react'
import { cn } from '../cn'

// A purchase order's status as an icon and words, never colour alone (NFR-A11Y-03). The label arrives translated.

const LOOK: Readonly<Record<string, { Icon: LucideIcon; tone: string }>> = {
  DRAFT: { Icon: FilePen, tone: 'text-ink-muted' },
  PENDING_APPROVAL: { Icon: Clock, tone: 'text-warn' },
  APPROVED: { Icon: CircleCheck, tone: 'text-primary' },
  SENT: { Icon: Send, tone: 'text-info' },
  PARTIALLY_RECEIVED: { Icon: PackageOpen, tone: 'text-info' },
  RECEIVED: { Icon: PackageCheck, tone: 'text-primary' },
  CLOSED: { Icon: CircleCheck, tone: 'text-ink-muted' },
  CANCELLED: { Icon: Ban, tone: 'text-ink-muted' },
  REJECTED: { Icon: CircleX, tone: 'text-danger' },
}

export function PoStatus({ status, label, className }: { status: string; label: string; className?: string }) {
  const { Icon, tone } = LOOK[status] ?? LOOK.DRAFT!
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-medium', className)}>
      <Icon className={cn('size-4 shrink-0', tone)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}
