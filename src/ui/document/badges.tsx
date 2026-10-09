import {
  AlarmClock,
  Ban,
  CircleCheck,
  CircleCheckBig,
  CircleDot,
  CircleX,
  Clock,
  FilePen,
  Hourglass,
  Lock,
  MessageCircleQuestion,
  PackageCheck,
  Send,
  ShoppingCart,
  Undo2,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '../shadcn/badge'

// The status badges of §9.10 (ป้ายสถานะ): a light background with its ink, a lucide icon and a word, never colour alone
// (NFR-A11Y-03, §9.9 principle 10). The table lives here once; server and client parts pass the look's name (a string
// crosses to the client, a component does not) and its translated word.

export type BadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral'

export const BADGE_ICONS = {
  AlarmClock,
  Ban,
  CircleCheck,
  CircleCheckBig,
  CircleDot,
  CircleX,
  Clock,
  FilePen,
  Hourglass,
  Lock,
  MessageCircleQuestion,
  PackageCheck,
  Send,
  ShoppingCart,
  Undo2,
  Wallet,
  Zap,
} as const satisfies Record<string, LucideIcon>

export type BadgeIcon = keyof typeof BADGE_ICONS

export interface BadgeLook {
  readonly tone: BadgeTone
  /** null: the word alone (§9.10 "ความด่วน ปกติ" has no icon) */
  readonly icon: BadgeIcon | null
}

/** A request's status (§9.10 คำขอ · คำขอผู้ขายรายใหม่) */
export const REQUEST_BADGES: Readonly<Record<string, BadgeLook>> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  PENDING_APPROVAL: { tone: 'warn', icon: 'Clock' },
  RETURNED: { tone: 'warn', icon: 'Undo2' },
  APPROVED: { tone: 'ok', icon: 'CircleCheck' },
  PARTIALLY_ORDERED: { tone: 'info', icon: 'ShoppingCart' },
  ORDERED: { tone: 'info', icon: 'ShoppingCart' },
  COMPLETED: { tone: 'ok', icon: 'CircleCheckBig' },
  SUBMITTED: { tone: 'info', icon: 'Send' },
  DONE: { tone: 'ok', icon: 'CircleCheck' },
  REJECTED: { tone: 'danger', icon: 'CircleX' },
  CANCELLED: { tone: 'neutral', icon: 'Ban' },
}

/** A PO's status (§9.10 PO) */
export const PO_BADGES: Readonly<Record<string, BadgeLook>> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  PENDING_APPROVAL: { tone: 'warn', icon: 'Clock' },
  APPROVED: { tone: 'ok', icon: 'CircleCheck' },
  SENT: { tone: 'info', icon: 'Send' },
  PARTIALLY_RECEIVED: { tone: 'info', icon: 'PackageCheck' },
  RECEIVED: { tone: 'ok', icon: 'PackageCheck' },
  CLOSED: { tone: 'neutral', icon: 'Lock' },
  REJECTED: { tone: 'danger', icon: 'CircleX' },
  CANCELLED: { tone: 'neutral', icon: 'Ban' },
}

/** A step of a route, as its card shows it (§9.10 งานอนุมัติ, and the outcome of a decided step) */
export type StepBadgeKey = 'OPEN' | 'OPEN_HALF' | 'OVERDUE' | 'INFO_REQUESTED' | 'WAITING' | 'APPROVE' | 'RETURN' | 'REJECT' | 'CANCELLED' | 'DONE'

export const STEP_BADGES: Readonly<Record<StepBadgeKey, BadgeLook>> = {
  // Waiting for its decision: neutral, warn once half of its time is used, danger past it
  OPEN: { tone: 'neutral', icon: 'Hourglass' },
  OPEN_HALF: { tone: 'warn', icon: 'Hourglass' },
  OVERDUE: { tone: 'danger', icon: 'AlarmClock' },
  INFO_REQUESTED: { tone: 'info', icon: 'MessageCircleQuestion' },
  WAITING: { tone: 'neutral', icon: 'CircleDot' },
  APPROVE: { tone: 'ok', icon: 'CircleCheck' },
  RETURN: { tone: 'warn', icon: 'Undo2' },
  REJECT: { tone: 'danger', icon: 'CircleX' },
  CANCELLED: { tone: 'neutral', icon: 'Ban' },
  DONE: { tone: 'neutral', icon: 'CircleCheck' },
}

export const URGENCY_BADGES: Readonly<Record<'NORMAL' | 'URGENT', BadgeLook>> = {
  NORMAL: { tone: 'neutral', icon: null },
  URGENT: { tone: 'warn', icon: 'Zap' },
}

/** งบพอ · งบใกล้หมด · งบไม่พอ */
export const BUDGET_BADGES: Readonly<Record<'OK' | 'LOW' | 'SHORT', BadgeLook>> = {
  OK: { tone: 'ok', icon: 'Wallet' },
  LOW: { tone: 'warn', icon: 'Wallet' },
  SHORT: { tone: 'danger', icon: 'Wallet' },
}

const FALLBACK: BadgeLook = { tone: 'neutral', icon: null }

export function StatusBadge({ look, label, className }: { look: BadgeLook | undefined; label: string; className?: string }) {
  const { tone, icon } = look ?? FALLBACK
  const Icon = icon ? BADGE_ICONS[icon] : null
  return (
    <Badge variant={tone} data-tone={tone} className={className}>
      {Icon ? <Icon aria-hidden="true" data-icon={icon} /> : null}
      {label}
    </Badge>
  )
}
