import { Ban, CircleCheck, CircleX, Clock, FilePen, PackageCheck, PackageOpen, Send, Truck, Undo2, type LucideIcon } from 'lucide-react'
import { cn } from '../cn'

// Status of a purchase order, a goods receipt or a variance as an icon and words, never colour alone (NFR-A11Y-03).
// Labels arrive translated.

type Look = { readonly Icon: LucideIcon; readonly tone: string }

const PO_LOOK: Readonly<Record<string, Look>> = {
  DRAFT: { Icon: FilePen, tone: 'text-ink-muted' },
  PENDING_APPROVAL: { Icon: Clock, tone: 'text-warn' },
  APPROVED: { Icon: CircleCheck, tone: 'text-primary' },
  SENT: { Icon: Truck, tone: 'text-info' },
  PARTIALLY_RECEIVED: { Icon: PackageOpen, tone: 'text-warn' },
  RECEIVED: { Icon: PackageCheck, tone: 'text-primary' },
  CLOSED: { Icon: CircleCheck, tone: 'text-ink-muted' },
  CANCELLED: { Icon: Ban, tone: 'text-ink-muted' },
  REJECTED: { Icon: CircleX, tone: 'text-danger' },
}

const RECEIPT_LOOK: Readonly<Record<string, Look>> = {
  DRAFT: { Icon: FilePen, tone: 'text-ink-muted' },
  POSTED: { Icon: PackageCheck, tone: 'text-primary' },
  REVERSED: { Icon: Undo2, tone: 'text-warn' },
}

const VARIANCE_LOOK: Readonly<Record<string, Look>> = {
  RECORDED: { Icon: Send, tone: 'text-info' },
  PENDING_APPROVAL: { Icon: Clock, tone: 'text-warn' },
  APPROVED: { Icon: CircleCheck, tone: 'text-primary' },
  REJECTED: { Icon: CircleX, tone: 'text-danger' },
}

const LOOKS = { po: PO_LOOK, receipt: RECEIPT_LOOK, variance: VARIANCE_LOOK } as const

export function StatusMark({ of, status, label, className }: { of: keyof typeof LOOKS; status: string; label: string; className?: string }) {
  const { Icon, tone } = LOOKS[of][status] ?? { Icon: FilePen, tone: 'text-ink-muted' }
  return (
    <span className={cn('inline-flex items-start gap-1.5 font-medium', className)}>
      <Icon className={cn('mt-[0.3em] size-4 shrink-0', tone)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}
