import { cn } from '../cn'
import type { BadgeLook } from '../document/badge-looks'
import { StatusBadge } from '../document/badges'

// The status badges of the bank-account screens (§9.10 ป้ายสถานะ): a light background with its ink, a lucide icon and a
// word, never colour alone (NFR-A11Y-03) — an account in force, replaced or closed; a request drafted, waiting, approved,
// not approved or cancelled. Words arrive translated.

const ACCOUNT: Readonly<Record<string, BadgeLook>> = {
  ACTIVE: { tone: 'ok', icon: 'CircleCheck' },
  SUPERSEDED: { tone: 'neutral', icon: 'Lock' },
  CLOSED: { tone: 'neutral', icon: 'Ban' },
}

const CHANGE: Readonly<Record<string, BadgeLook>> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  PENDING_APPROVAL: { tone: 'warn', icon: 'Clock' },
  APPROVED: { tone: 'ok', icon: 'CircleCheck' },
  REJECTED: { tone: 'danger', icon: 'CircleX' },
  CANCELLED: { tone: 'neutral', icon: 'Ban' },
}

const SIZE = 'text-base whitespace-normal md:text-sm'

export function AccountStatusBadge({ status, label, className }: { status: string; label: string; className?: string }) {
  return <StatusBadge look={ACCOUNT[status]} label={label} className={cn(SIZE, className)} />
}

export function ChangeStatusBadge({ status, label, className }: { status: string; label: string; className?: string }) {
  return <StatusBadge look={CHANGE[status]} label={label} className={cn(SIZE, className)} />
}
