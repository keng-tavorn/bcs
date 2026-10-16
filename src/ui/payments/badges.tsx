import { Archive, Ban, CircleCheck, CircleCheckBig, CircleDot, CircleX, Clock, FileCheck, FilePen, Flag, Hourglass, Landmark, MailCheck, MailWarning, MailX, type LucideIcon } from 'lucide-react'
import type { BadgeTone } from '../document/badges'
import { Badge } from '../shadcn/badge'

// The badges of the payment run screens (§9.10 ป้ายสถานะ): a light background with its ink, a lucide icon and a word,
// never colour alone (NFR-A11Y-03). A run's status, a flag of an item (BR-PAY-06), an item's result, its payment advice
// and a bank file's version. Words arrive translated.

interface Look {
  readonly tone: BadgeTone
  readonly Icon: LucideIcon
}

const RUN: Readonly<Record<string, Look>> = {
  DRAFT: { tone: 'neutral', Icon: FilePen },
  PENDING_APPROVAL: { tone: 'warn', Icon: Clock },
  APPROVED: { tone: 'ok', Icon: CircleCheck },
  FILE_READY: { tone: 'info', Icon: FileCheck },
  SENT_TO_BANK: { tone: 'info', Icon: Landmark },
  COMPLETED: { tone: 'ok', Icon: CircleCheckBig },
  REJECTED: { tone: 'danger', Icon: CircleX },
  CANCELLED: { tone: 'neutral', Icon: Ban },
}

const ITEM: Readonly<Record<string, Look>> = {
  INCLUDED: { tone: 'neutral', Icon: CircleDot },
  PAID: { tone: 'ok', Icon: CircleCheckBig },
  FAILED: { tone: 'danger', Icon: CircleX },
}

const ADVICE: Readonly<Record<string, Look>> = {
  PENDING: { tone: 'neutral', Icon: Hourglass },
  SENT: { tone: 'ok', Icon: MailCheck },
  FAILED: { tone: 'danger', Icon: MailX },
  NO_EMAIL: { tone: 'warn', Icon: MailWarning },
}

const FILE: Readonly<Record<string, Look>> = {
  CURRENT: { tone: 'ok', Icon: FileCheck },
  SUPERSEDED: { tone: 'neutral', Icon: Archive },
}

const FALLBACK: Look = { tone: 'neutral', Icon: CircleDot }

function LookBadge({ look, label, className }: { look: Look; label: string; className?: string }) {
  const { tone, Icon } = look
  return (
    <Badge variant={tone} data-tone={tone} className={`text-base whitespace-normal md:text-sm ${className ?? ''}`}>
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  )
}

export function RunStatusBadge({ status, label, className }: { status: string; label: string; className?: string }) {
  return <LookBadge look={RUN[status] ?? FALLBACK} label={label} {...(className ? { className } : {})} />
}

/** A flag of an item: something the approver checks before approving (BR-PAY-06) */
export function FlagBadge({ label }: { label: string }) {
  return <LookBadge look={{ tone: 'warn', Icon: Flag }} label={label} />
}

export function ItemResultBadge({ status, label }: { status: string; label: string }) {
  return <LookBadge look={ITEM[status] ?? FALLBACK} label={label} />
}

export function AdviceBadge({ status, label }: { status: string; label: string }) {
  return <LookBadge look={ADVICE[status] ?? FALLBACK} label={label} />
}

export function FileStatusBadge({ status, label }: { status: string; label: string }) {
  return <LookBadge look={FILE[status] ?? FALLBACK} label={label} />
}
