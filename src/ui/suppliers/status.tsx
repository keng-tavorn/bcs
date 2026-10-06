import { CircleCheck, CircleSlash, Info, ShieldCheck, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../cn'

// Supplier states as an icon and words, never colour alone (NFR-A11Y-03). Labels arrive translated.

const STATUS_LOOK = {
  ACTIVE: { Icon: CircleCheck, tone: 'text-primary' },
  INACTIVE: { Icon: CircleSlash, tone: 'text-ink-muted' },
} as const

/** "ใช้งานอยู่" / "เลิกใช้แล้ว" */
export function SupplierStatusLabel({ status, label, className }: { status: keyof typeof STATUS_LOOK; label: string; className?: string }) {
  const { Icon, tone } = STATUS_LOOK[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-medium', className)}>
      <Icon className={cn('size-4 shrink-0', tone)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
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
