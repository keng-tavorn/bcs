import {
  AlarmClock,
  Ban,
  CircleCheck,
  CircleCheckBig,
  CircleDot,
  CircleX,
  Clock,
  Copy,
  FilePen,
  Gauge,
  Hourglass,
  Lock,
  MessageCircleQuestion,
  PackageCheck,
  Send,
  ShoppingCart,
  Split,
  TrendingDown,
  TrendingUp,
  Undo2,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '../shadcn/badge'
import { FALLBACK_BADGE, type BadgeIcon, type BadgeLook } from './badge-looks'

// The status badges of §9.10 (ป้ายสถานะ): a light background with its ink, a lucide icon and a word, never colour alone
// (NFR-A11Y-03, §9.9 principle 10). The table lives in ./badge-looks.ts, shared with the LIFF badge; server and client
// parts pass the look's name (a string crosses to the client, a component does not) and its translated word.

export {
  BUDGET_BADGES,
  BURN_BADGES,
  FLAG_BADGES,
  PO_BADGES,
  PRICE_BADGES,
  REQUEST_BADGES,
  STEP_BADGES,
  URGENCY_BADGES,
  type BadgeIcon,
  type BadgeLook,
  type BadgeTone,
  type StepBadgeKey,
} from './badge-looks'

export const BADGE_ICONS = {
  AlarmClock,
  Ban,
  CircleCheck,
  CircleCheckBig,
  CircleDot,
  CircleX,
  Clock,
  Copy,
  FilePen,
  Gauge,
  Hourglass,
  Lock,
  MessageCircleQuestion,
  PackageCheck,
  Send,
  ShoppingCart,
  Split,
  TrendingDown,
  TrendingUp,
  Undo2,
  Wallet,
  Zap,
} as const satisfies Record<BadgeIcon, LucideIcon>

export function StatusBadge({ look, label, className }: { look: BadgeLook | undefined; label: string; className?: string }) {
  const { tone, icon } = look ?? FALLBACK_BADGE
  const Icon = icon ? BADGE_ICONS[icon] : null
  return (
    <Badge variant={tone} data-tone={tone} className={className}>
      {Icon ? <Icon aria-hidden="true" data-icon={icon} /> : null}
      {label}
    </Badge>
  )
}
