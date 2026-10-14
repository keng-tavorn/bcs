import { Ban, CircleAlert, CircleCheck, CircleCheckBig, CircleX, Clock, Copy, FilePen, Inbox, Send, TriangleAlert, Wallet, type LucideIcon } from 'lucide-react'
import type { BadgeTone } from '../../document/badges'
import { Badge } from '../../shadcn/badge'

// The status badges of the tier-2 invoice screens (§9.10 ป้ายสถานะ): a light background with its ink, a lucide icon and a
// word, never colour alone (NFR-A11Y-03). Words arrive translated.

interface Look {
  readonly tone: BadgeTone
  readonly Icon: LucideIcon
}

const INVOICE: Readonly<Record<string, Look>> = {
  DRAFT: { tone: 'neutral', Icon: FilePen },
  EXCEPTION: { tone: 'danger', Icon: TriangleAlert },
  PENDING_APPROVAL: { tone: 'warn', Icon: Clock },
  READY_FOR_PAYMENT: { tone: 'ok', Icon: Wallet },
  IN_PAYMENT_RUN: { tone: 'info', Icon: Send },
  PAID: { tone: 'ok', Icon: CircleCheckBig },
  REJECTED: { tone: 'danger', Icon: CircleX },
  CANCELLED: { tone: 'neutral', Icon: Ban },
}

const INBOX: Readonly<Record<string, Look>> = {
  RECEIVED: { tone: 'info', Icon: Inbox },
  PROCESSED: { tone: 'ok', Icon: CircleCheck },
  IGNORED: { tone: 'neutral', Icon: Ban },
  FAILED: { tone: 'danger', Icon: CircleAlert },
}

const FALLBACK: Look = { tone: 'neutral', Icon: FilePen }

function LookBadge({ look, label }: { look: Look; label: string }) {
  const { tone, Icon } = look
  return (
    <Badge variant={tone} data-tone={tone} className="text-base whitespace-normal md:text-sm">
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  )
}

export function InvoiceStatusBadge({ status, label }: { status: string; label: string }) {
  return <LookBadge look={INVOICE[status] ?? FALLBACK} label={label} />
}

export function InboxStatusBadge({ status, label }: { status: string; label: string }) {
  return <LookBadge look={INBOX[status] ?? FALLBACK} label={label} />
}

/** The match flagged the invoice as a possible duplicate (BR-MATCH-08) */
export function DuplicateBadge({ label }: { label: string }) {
  return <LookBadge look={{ tone: 'warn', Icon: Copy }} label={label} />
}
