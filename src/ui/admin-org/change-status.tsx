import { StatusBadge, type BadgeLook } from '../document/badges'
import { cn } from '../cn'

// An authority change's status as a status badge of §9.10: a tone, an icon and words, never colour alone
// (NFR-A11Y-03). The label arrives translated.
const LOOK = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  PENDING_APPROVAL: { tone: 'warn', icon: 'Clock' },
  SCHEDULED: { tone: 'info', icon: 'Hourglass' },
  APPLIED: { tone: 'ok', icon: 'CircleCheck' },
  REJECTED: { tone: 'danger', icon: 'CircleX' },
  CANCELLED: { tone: 'neutral', icon: 'Ban' },
} as const satisfies Record<string, BadgeLook>

export type ChangeStatusValue = keyof typeof LOOK

export function ChangeStatus({ status, label, className }: { status: ChangeStatusValue; label: string; className?: string }) {
  return <StatusBadge look={LOOK[status]} label={label} className={cn('text-base md:text-sm', className)} />
}
