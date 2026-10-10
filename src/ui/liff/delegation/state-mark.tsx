import { LiffStatusBadge, type LiffBadgeLook } from '../status-badge'

// The state of a delegation on /liff/delegation as a status badge of §9.10 (S16-11): the tones and icons of the
// workspace's src/ui/delegation/delegation-state.tsx, drawn by the LIFF badge (plain SVG, no lucide-react in the page's
// first JavaScript, §9.4 · ADR-052). An icon and words, never colour alone (NFR-A11Y-03). Rendered by the server; the
// label arrives translated.

const LOOK = {
  ACTIVE: { tone: 'ok', icon: 'CircleCheck' },
  SCHEDULED: { tone: 'warn', icon: 'Clock' },
  ENDED: { tone: 'neutral', icon: 'CircleMinus' },
  REVOKED: { tone: 'neutral', icon: 'CircleSlash' },
} as const satisfies Record<string, LiffBadgeLook>

export type LiffDelegationState = keyof typeof LOOK

export function LiffDelegationStateMark({ state, label, className }: { readonly state: LiffDelegationState; readonly label: string; readonly className?: string }) {
  return <LiffStatusBadge look={LOOK[state]} label={label} className={className} />
}
