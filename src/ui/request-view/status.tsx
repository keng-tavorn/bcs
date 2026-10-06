import {
  Ban,
  Bookmark,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  FilePen,
  KeyRound,
  Lock,
  MessageCircleQuestion,
  PackageCheck,
  Send,
  Undo2,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../cn'

// Status as an icon and words, never colour alone (NFR-A11Y-03). Labels arrive translated.

const REQUEST_LOOK: Readonly<Record<string, { Icon: LucideIcon; tone: string }>> = {
  DRAFT: { Icon: FilePen, tone: 'text-ink-muted' },
  PENDING_APPROVAL: { Icon: Clock, tone: 'text-warn' },
  RETURNED: { Icon: Undo2, tone: 'text-warn' },
  APPROVED: { Icon: CircleCheck, tone: 'text-primary' },
  PARTIALLY_ORDERED: { Icon: PackageCheck, tone: 'text-primary' },
  ORDERED: { Icon: PackageCheck, tone: 'text-primary' },
  COMPLETED: { Icon: CircleCheck, tone: 'text-primary' },
  REJECTED: { Icon: CircleX, tone: 'text-danger' },
  CANCELLED: { Icon: Ban, tone: 'text-ink-muted' },
  SUBMITTED: { Icon: Send, tone: 'text-info' },
  DONE: { Icon: CircleCheck, tone: 'text-primary' },
}

/** A request's status: icon and label */
export function RequestStatus({ status, label, className }: { status: string; label: string; className?: string }) {
  const { Icon, tone } = REQUEST_LOOK[status] ?? REQUEST_LOOK.DRAFT!
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-medium', className)}>
      <Icon className={cn('size-4 shrink-0', tone)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}

const LINE_LOOK = {
  waiting: { Icon: Clock, tone: 'text-warn', text: 'text-ink' },
  overdue: { Icon: CircleAlert, tone: 'text-danger', text: 'text-danger font-medium' },
  due: { Icon: CalendarClock, tone: 'text-ink-muted', text: 'text-ink-muted' },
  question: { Icon: MessageCircleQuestion, tone: 'text-info', text: 'text-ink' },
  person: { Icon: UserRound, tone: 'text-ink-muted', text: 'text-ink' },
  team: { Icon: Users, tone: 'text-ink-muted', text: 'text-ink' },
  done: { Icon: CircleCheck, tone: 'text-primary', text: 'text-ink' },
  /** Sent back to the requester for changes: the same icon as the timeline's return */
  returned: { Icon: Undo2, tone: 'text-warn', text: 'text-ink' },
  /** Not approved: the same icon as the timeline's rejection */
  rejected: { Icon: CircleX, tone: 'text-danger', text: 'text-ink' },
  closed: { Icon: Ban, tone: 'text-ink-muted', text: 'text-ink-muted' },
  key: { Icon: KeyRound, tone: 'text-info', text: 'text-ink' },
  draft: { Icon: FilePen, tone: 'text-ink-muted', text: 'text-ink' },
  /**
   * Budget held for a document — reserved for a request waiting for approval, or committed in a purchase order: a
   * padlock in --info, never the approved mark (--primary is "approved", §9.9 tokens), whatever the document's state
   */
  held: { Icon: Lock, tone: 'text-info', text: 'text-ink' },
  /**
   * The quotation the requester chose: a fact of the request, not a decision on it — a bookmark in --info, never the
   * approved mark (--primary is "approved", §9.9 tokens), whether the request still waits for its approvers or not
   */
  chosen: { Icon: Bookmark, tone: 'text-info', text: 'text-ink' },
} as const

export type StateKind = keyof typeof LINE_LOOK

/** One line of state (waiting time, due time, who holds it…) with an icon that says the same as the words */
export function StateLine({ kind, children, className }: { kind: StateKind; children: ReactNode; className?: string }) {
  const { Icon, tone, text } = LINE_LOOK[kind]
  return (
    <span className={cn('inline-flex items-start gap-1.5', text, className)}>
      <Icon className={cn('mt-[0.3em] size-4 shrink-0', tone)} aria-hidden="true" />
      <span>{children}</span>
    </span>
  )
}
