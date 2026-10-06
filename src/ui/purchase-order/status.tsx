import { Ban, CircleCheck, CircleX, Clock, FilePen, PackageCheck, PackageOpen, Send, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../cn'

// A purchase order's status as an icon and words, never colour alone (NFR-A11Y-03). The label arrives translated.

const LOOK: Readonly<Record<string, { Icon: LucideIcon; tone: string }>> = {
  DRAFT: { Icon: FilePen, tone: 'text-ink-muted' },
  PENDING_APPROVAL: { Icon: Clock, tone: 'text-warn' },
  APPROVED: { Icon: CircleCheck, tone: 'text-primary' },
  SENT: { Icon: Send, tone: 'text-info' },
  PARTIALLY_RECEIVED: { Icon: PackageOpen, tone: 'text-info' },
  RECEIVED: { Icon: PackageCheck, tone: 'text-primary' },
  CLOSED: { Icon: CircleCheck, tone: 'text-ink-muted' },
  CANCELLED: { Icon: Ban, tone: 'text-ink-muted' },
  REJECTED: { Icon: CircleX, tone: 'text-danger' },
}

export function PoStatus({ status, label, className }: { status: string; label: string; className?: string }) {
  const { Icon, tone } = LOOK[status] ?? LOOK.DRAFT!
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-medium', className)}>
      <Icon className={cn('size-4 shrink-0', tone)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}

/**
 * The notice above a rejected purchase order, in the token and the icon its status and its timeline give "ไม่อนุมัติ":
 * --danger with a cross (§9.9 token table: not approved), never the --warn of a PO that waits — a PO returned for changes
 * or an e-mail that bounced keep theirs. It tells where the PO stands rather than an error just made, so it is read out
 * politely (role=status), the way ../form/notice.tsx reads out every notice but an error.
 */
export function RejectedNotice({ children }: { children: ReactNode }) {
  const { Icon, tone } = LOOK.REJECTED!
  return (
    <div role="status" className="flex items-start gap-2 border-l-4 border-danger bg-surface px-3 py-2.5 text-ink">
      <Icon className={cn('mt-1 size-4 shrink-0', tone)} aria-hidden="true" />
      <div>{children}</div>
    </div>
  )
}
