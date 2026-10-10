import { StatusBadge, type BadgeLook } from '../document/badges'
import { cn } from '../cn'

// On/off of a module (or of a request type) as a status badge of §9.10: a tone, an icon and words, never colour alone
// (NFR-A11Y-03). The label arrives translated.
const ON: BadgeLook = { tone: 'ok', icon: 'CircleCheck' }
const OFF: BadgeLook = { tone: 'neutral', icon: 'Ban' }

export function ModuleState({ enabled, label, className }: { enabled: boolean; label: string; className?: string }) {
  return <StatusBadge look={enabled ? ON : OFF} label={label} className={cn('text-base md:text-sm', className)} />
}
