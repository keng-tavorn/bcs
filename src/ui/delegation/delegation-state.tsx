import { CircleCheck, CircleMinus, CircleSlash, Clock } from 'lucide-react'
import { cn } from '../cn'

// The state of a delegation as an icon and words, never colour alone (NFR-A11Y-03). The label arrives translated.
const LOOK = {
  ACTIVE: { Icon: CircleCheck, tone: 'text-primary' },
  SCHEDULED: { Icon: Clock, tone: 'text-warn' },
  ENDED: { Icon: CircleMinus, tone: 'text-ink-muted' },
  REVOKED: { Icon: CircleSlash, tone: 'text-ink-muted' },
} as const

export type DelegationStateName = keyof typeof LOOK

export function DelegationState({ state, label, className }: { state: DelegationStateName; label: string; className?: string }) {
  const { Icon, tone } = LOOK[state]
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5', className)}>
      <Icon className={cn('size-4 shrink-0', tone)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}
