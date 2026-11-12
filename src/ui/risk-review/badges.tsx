import { Shield, ShieldAlert, ShieldCheck, type LucideIcon } from 'lucide-react'
import { Badge } from '../shadcn/badge'
import type { BadgeTone } from '../document/badge-looks'

// A supplier's risk tier as a badge (S11-06): §9.10 has no row for it, so it follows the table's way — a light
// background with its ink, an icon and a word, never colour alone (NFR-A11Y-03). Low is plain (neutral), medium a thing
// to look at (warn), high one that needs care (danger); each tier has its own shield, so the three differ without colour.

const TIER_LOOKS: Readonly<Record<'LOW' | 'MEDIUM' | 'HIGH', { readonly tone: BadgeTone; readonly Icon: LucideIcon }>> = {
  LOW: { tone: 'neutral', Icon: ShieldCheck },
  MEDIUM: { tone: 'warn', Icon: Shield },
  HIGH: { tone: 'danger', Icon: ShieldAlert },
}

export function TierBadge({ tier, label, className }: { tier: 'LOW' | 'MEDIUM' | 'HIGH'; label: string; className?: string }) {
  const { tone, Icon } = TIER_LOOKS[tier]
  return (
    <Badge variant={tone} data-tone={tone} data-tier={tier} className={className}>
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  )
}
