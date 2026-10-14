// The status badges of §9.10 (ป้ายสถานะ) as data: each status's colour pair (--<tone>-bg with --<tone>-ink) and the name
// of its lucide icon. No imports, so the workspace's badge (./badges.tsx: shadcn/ui Badge with lucide-react) and the LIFF
// badge (src/ui/liff/status-badge.tsx: plain SVG, ADR-052) read the same table and never drift apart.

export type BadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral'

/** The lucide icons of the table, by their lucide-react names */
export type BadgeIcon =
  | 'AlarmClock'
  | 'Ban'
  | 'CircleCheck'
  | 'CircleCheckBig'
  | 'CircleDot'
  | 'CircleX'
  | 'Clock'
  | 'Copy'
  | 'FilePen'
  | 'Hourglass'
  | 'Lock'
  | 'MessageCircleQuestion'
  | 'PackageCheck'
  | 'Send'
  | 'ShoppingCart'
  | 'Split'
  | 'TrendingDown'
  | 'TrendingUp'
  | 'Undo2'
  | 'Wallet'
  | 'Zap'

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

/** A request line's price against the median of the past prices (S6-11 · BR-PRC-03): above or below it by more than the
 * organization's priceAlertPct. Not in §9.10's table, which has no price state: warn as a thing to look at, info for a
 * lower price, which is no fault */
export const PRICE_BADGES: Readonly<Record<'HIGH' | 'LOW', BadgeLook>> = {
  HIGH: { tone: 'warn', icon: 'TrendingUp' },
  LOW: { tone: 'info', icon: 'TrendingDown' },
}

/** A flag of a sent request (S6-13 · FR-INT-103 · BR-DUP-05): it looks like one the requester sent within the window
 * (DUPLICATE), or with others of its paying department it reaches a higher DOA rule (SPLIT). Not in §9.10's table, which
 * has no such state: warn for both, things for the approver to look at — a flag never blocks and never changes the route */
export const FLAG_BADGES: Readonly<Record<'DUPLICATE' | 'SPLIT', BadgeLook>> = {
  DUPLICATE: { tone: 'warn', icon: 'Copy' },
  SPLIT: { tone: 'warn', icon: 'Split' },
}

export const FALLBACK_BADGE: BadgeLook = { tone: 'neutral', icon: null }
