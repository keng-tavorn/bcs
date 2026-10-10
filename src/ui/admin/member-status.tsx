import { StatusBadge, type BadgeLook } from '../document/badges'
import { cn } from '../cn'

// A member's status as a status badge of §9.10: a tone, an icon and words, never colour alone (NFR-A11Y-03). The label
// arrives translated.
const LOOK = {
  ACTIVE: { tone: 'ok', icon: 'CircleCheck' },
  INVITED: { tone: 'warn', icon: 'Clock' },
  DEACTIVATED: { tone: 'neutral', icon: 'Ban' },
} as const satisfies Record<string, BadgeLook>

export function MemberStatus({ status, label, className }: { status: keyof typeof LOOK; label: string; className?: string }) {
  return <StatusBadge look={LOOK[status]} label={label} className={cn('text-base md:text-sm', className)} />
}
