import { CalendarClock, CircleCheck, CircleSlash, CircleX, Clock, FilePen } from 'lucide-react'
import { cn } from '../cn'

// An authority change's status as an icon and words, never colour alone (NFR-A11Y-03). The label arrives translated.
const LOOK = {
  DRAFT: { Icon: FilePen, tone: 'text-ink-muted' },
  PENDING_APPROVAL: { Icon: Clock, tone: 'text-warn' },
  SCHEDULED: { Icon: CalendarClock, tone: 'text-info' },
  APPLIED: { Icon: CircleCheck, tone: 'text-primary' },
  REJECTED: { Icon: CircleX, tone: 'text-danger' },
  CANCELLED: { Icon: CircleSlash, tone: 'text-ink-muted' },
} as const

export type ChangeStatusValue = keyof typeof LOOK

export function ChangeStatus({ status, label, className }: { status: ChangeStatusValue; label: string; className?: string }) {
  const { Icon, tone } = LOOK[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-medium', className)}>
      <Icon className={cn('size-4 shrink-0', tone)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}
