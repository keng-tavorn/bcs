import { cn } from '../cn'
import { shareWidth } from './format'

// The share of the planned amount already held (reserved + committed + actual) as a thin bar beside its percent. It only
// repeats the number next to it, so screen readers skip it; the fill is the main colour, and the warning colour when the
// line runs low — the warning itself is said in words with an icon (LowBadge). The track is the rule colour (--line):
// only the tokens of §9.9.
export function HeldMeter({ heldBp, low, className }: { heldBp: number | null; low: boolean; className?: string }) {
  if (heldBp === null) return null
  return (
    <div aria-hidden="true" className={cn('h-1.5 w-full overflow-hidden rounded-full bg-line', className)}>
      <div className={cn('h-full rounded-full', low ? 'bg-warn' : 'bg-primary')} style={{ width: `${shareWidth(heldBp)}%` }} />
    </div>
  )
}
