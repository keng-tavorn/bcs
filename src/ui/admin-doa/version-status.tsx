import { StatusBadge, type BadgeLook } from '../document/badges'
import { cn } from '../cn'

// A DOA version's status as a status badge of §9.10: a tone, an icon and words, never colour alone (NFR-A11Y-03). A
// published version is shown as in effect, or as approved and waiting for its start. The label arrives translated.

export type VersionLook = 'DRAFT' | 'PENDING_APPROVAL' | 'IN_EFFECT' | 'UPCOMING' | 'PUBLISHED' | 'SUPERSEDED' | 'REJECTED' | 'WITHDRAWN'

const LOOK = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  PENDING_APPROVAL: { tone: 'warn', icon: 'Clock' },
  IN_EFFECT: { tone: 'ok', icon: 'CircleCheck' },
  UPCOMING: { tone: 'info', icon: 'Hourglass' },
  PUBLISHED: { tone: 'ok', icon: 'CircleCheck' },
  SUPERSEDED: { tone: 'neutral', icon: 'Lock' },
  REJECTED: { tone: 'danger', icon: 'CircleX' },
  WITHDRAWN: { tone: 'neutral', icon: 'Undo2' },
} as const satisfies Record<VersionLook, BadgeLook>

/** Which look a version gets: in effect and upcoming are kinds of PUBLISHED */
export function versionLook(v: { readonly status: string; readonly inEffect: boolean; readonly upcoming: boolean }): VersionLook {
  if (v.status === 'PUBLISHED') return v.inEffect ? 'IN_EFFECT' : v.upcoming ? 'UPCOMING' : 'PUBLISHED'
  return (v.status in LOOK ? v.status : 'DRAFT') as VersionLook
}

export function VersionStatus({ look, label, className }: { look: VersionLook; label: string; className?: string }) {
  return <StatusBadge look={LOOK[look]} label={label} className={cn('text-base md:text-sm', className)} />
}
