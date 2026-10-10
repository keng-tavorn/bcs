import { CircleCheck, CircleMinus, CircleSlash, Clock } from 'lucide-react'
import type { BadgeTone } from '../document/badges'
import { Badge } from '../shadcn/badge'

// The state of a delegation as an icon and words, never colour alone (NFR-A11Y-03). The label arrives translated.
// A status badge of §9.10 (S16-10): the tone in the badge's light background, the same icons as before, so the LIFF
// copy (src/ui/liff/delegation/state-mark.tsx) still draws the same marks.
const LOOK = {
  ACTIVE: { Icon: CircleCheck, tone: 'ok' },
  SCHEDULED: { Icon: Clock, tone: 'warn' },
  ENDED: { Icon: CircleMinus, tone: 'neutral' },
  REVOKED: { Icon: CircleSlash, tone: 'neutral' },
} as const satisfies Record<string, { Icon: typeof CircleCheck; tone: BadgeTone }>

export type DelegationStateName = keyof typeof LOOK

export function DelegationState({ state, label, className }: { state: DelegationStateName; label: string; className?: string }) {
  const { Icon, tone } = LOOK[state]
  return (
    <Badge variant={tone} data-tone={tone} className={className}>
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  )
}
