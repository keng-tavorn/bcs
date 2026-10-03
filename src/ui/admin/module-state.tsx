import { CircleCheck, CircleMinus } from 'lucide-react'
import { cn } from '../cn'

// On/off of a module as an icon and words, never colour alone (NFR-A11Y-03). The label arrives translated.
export function ModuleState({ enabled, label, className }: { enabled: boolean; label: string; className?: string }) {
  const Icon = enabled ? CircleCheck : CircleMinus
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5', className)}>
      <Icon className={cn('size-4 shrink-0', enabled ? 'text-primary' : 'text-ink-muted')} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}
