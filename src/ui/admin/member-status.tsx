import { CircleCheck, CircleSlash, Clock } from 'lucide-react'
import { cn } from '../cn'

// A member's status as an icon and words, never colour alone (NFR-A11Y-03). The label arrives translated.
const LOOK = {
  ACTIVE: { Icon: CircleCheck, tone: 'text-primary' },
  INVITED: { Icon: Clock, tone: 'text-warn' },
  DEACTIVATED: { Icon: CircleSlash, tone: 'text-ink-muted' },
} as const

export function MemberStatus({ status, label, className }: { status: keyof typeof LOOK; label: string; className?: string }) {
  const { Icon, tone } = LOOK[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <Icon className={cn('size-4 shrink-0', tone)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}
