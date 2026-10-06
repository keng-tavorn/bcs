'use client'

import { cn } from '../cn'
import { Button, type ButtonProps } from '../form/button'
import { useHydrated } from '../form/hydrated'

/**
 * A button of a sign-in form that can be pressed only once the page's script runs: in the server's HTML it is disabled
 * (src/ui/form/hydrated.ts), so the browser itself never sends what was typed (NFR-SEC-09). It comes on at once when the
 * script starts, with no colour transition (the shared button has none either; transition-none holds even if one comes
 * back there or a caller's class adds one): nobody pressed anything, so nothing may change slowly
 * (§9.9: a transition only shows the result of what the person did), and halfway between the disabled look and its own
 * its words could not be read. Its other changes — pressed, and back once the answer comes — are at once too.
 */
export function ScriptButton({ disabled = false, className, ...button }: ButtonProps) {
  const hydrated = useHydrated()
  return <Button {...button} disabled={disabled || !hydrated} className={cn('transition-none', className)} />
}
