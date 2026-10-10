import { CircleCheck, Info, ShieldCheck, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../cn'
import { StatusBadge, type BadgeLook } from '../document/badges'

// Supplier states as an icon and words, never colour alone (NFR-A11Y-03). Labels arrive translated.

/** A supplier's status as a badge of §9.10 (S16-10): in use in the tone of "ready", no longer used in the neutral one */
const STATUS_LOOK: Readonly<Record<'ACTIVE' | 'INACTIVE', BadgeLook>> = {
  ACTIVE: { tone: 'ok', icon: 'CircleCheck' },
  INACTIVE: { tone: 'neutral', icon: 'Ban' },
}

/** "ใช้งานอยู่" / "เลิกใช้แล้ว" */
export function SupplierStatusLabel({ status, label, className }: { status: keyof typeof STATUS_LOOK; label: string; className?: string }) {
  return <StatusBadge look={STATUS_LOOK[status]} label={label} className={cn('text-base md:text-sm', className)} />
}

const FLAG_LOOK: Readonly<Record<'ok' | 'warn' | 'info' | 'checked', { Icon: LucideIcon; tone: string }>> = {
  ok: { Icon: CircleCheck, tone: 'text-primary' },
  warn: { Icon: TriangleAlert, tone: 'text-warn' },
  info: { Icon: Info, tone: 'text-info' },
  checked: { Icon: ShieldCheck, tone: 'text-primary' },
}

/** One fact with an icon that says the same as its words (a missing Express code, how the identity was checked) */
export function Flag({ kind, children, className }: { kind: keyof typeof FLAG_LOOK; children: ReactNode; className?: string }) {
  const { Icon, tone } = FLAG_LOOK[kind]
  return (
    <span className={cn('inline-flex items-start gap-1.5 text-ink', className)}>
      <Icon className={cn('mt-[0.3em] size-4 shrink-0', tone)} aria-hidden="true" />
      <span>{children}</span>
    </span>
  )
}
