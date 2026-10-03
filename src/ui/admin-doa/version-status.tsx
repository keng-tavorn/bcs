import { CalendarClock, CircleCheck, CircleX, Clock, FilePen, History, Undo2 } from 'lucide-react'
import { cn } from '../cn'

// A DOA version's status as an icon and words, never colour alone (NFR-A11Y-03). A published version is shown as in
// effect, or as approved and waiting for its start. The label arrives translated.

export type VersionLook = 'DRAFT' | 'PENDING_APPROVAL' | 'IN_EFFECT' | 'UPCOMING' | 'PUBLISHED' | 'SUPERSEDED' | 'REJECTED' | 'WITHDRAWN'

const LOOK = {
  DRAFT: { Icon: FilePen, tone: 'text-ink-muted' },
  PENDING_APPROVAL: { Icon: Clock, tone: 'text-warn' },
  IN_EFFECT: { Icon: CircleCheck, tone: 'text-primary' },
  UPCOMING: { Icon: CalendarClock, tone: 'text-info' },
  PUBLISHED: { Icon: CircleCheck, tone: 'text-primary' },
  SUPERSEDED: { Icon: History, tone: 'text-ink-muted' },
  REJECTED: { Icon: CircleX, tone: 'text-danger' },
  WITHDRAWN: { Icon: Undo2, tone: 'text-ink-muted' },
} as const

/** Which look a version gets: in effect and upcoming are kinds of PUBLISHED */
export function versionLook(v: { readonly status: string; readonly inEffect: boolean; readonly upcoming: boolean }): VersionLook {
  if (v.status === 'PUBLISHED') return v.inEffect ? 'IN_EFFECT' : v.upcoming ? 'UPCOMING' : 'PUBLISHED'
  return (v.status in LOOK ? v.status : 'DRAFT') as VersionLook
}

export function VersionStatus({ look, label, className }: { look: VersionLook; label: string; className?: string }) {
  const { Icon, tone } = LOOK[look]
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-medium', className)}>
      <Icon className={cn('size-4 shrink-0', tone)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}
