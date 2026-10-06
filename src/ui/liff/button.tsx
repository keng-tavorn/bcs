import type { ButtonHTMLAttributes } from 'react'
import { cn } from './cn'

// The buttons of LIFF pages: the workspace's src/ui/form/button.tsx — the same variants and look, words that say what
// will happen (§9.9 rule 7), 44 px tall for touch (§9.4) — with classes that never conflict, joined without
// tailwind-merge (./cn.ts: some 8.6 KB gzip less in a LIFF page's first JavaScript). The variants carry no height
// or side padding of their own: the button gives the 44 px height and the side padding unless it is drawn as a link, or
// the caller's className sets them itself — h-auto with min-h-11 and some padding, for words that may wrap. A className
// adds nothing else that one of these classes sets (tests/unit/liff-classes.test.tsx draws every LIFF use of it beside
// the workspace's button and compares their classes). Like the workspace's, its look changes at once, with no colour
// transition: a button drawn disabled until the page's script runs comes on when the script starts, which nobody did
// (§9.9: a transition only shows the result of what the person did).

const BASE = 'inline-flex items-center justify-center gap-2 rounded-md font-medium disabled:cursor-not-allowed'

// Disabled: the words stay readable (§9.9, 4.5:1 or more) — the secondary text on the light surface inside a quiet rule.
// Pointed at, the main button keeps its --primary fill and underlines its words (only the tokens of §9.9 as colours)
const VARIANTS = {
  primary:
    'bg-primary text-primary-foreground underline-offset-4 hover:underline disabled:bg-surface disabled:text-ink-muted disabled:no-underline disabled:ring-1 disabled:ring-line disabled:ring-inset',
  secondary: 'border border-input bg-bg text-ink hover:bg-surface disabled:border-line disabled:bg-surface disabled:text-ink-muted',
  // Actions that take something away (deactivate, switch off): outlined in danger so it never looks like the main action
  danger: 'border border-danger bg-bg text-danger hover:bg-surface disabled:border-line disabled:bg-surface disabled:text-ink-muted',
  link: 'h-auto px-0 text-primary underline underline-offset-4 hover:no-underline disabled:text-ink-muted',
} as const

/** A className that gives the button its own height (h-auto, h-12, …), or its own side padding (px-…, p-…) */
const OWN_HEIGHT = /(?:^|\s)h-/
const OWN_PADDING = /(?:^|\s)px?-/

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: keyof typeof VARIANTS
}

export function Button({ variant = 'primary', className, type = 'button', ...props }: ButtonProps) {
  const own = className ?? ''
  const link = variant === 'link'
  return <button type={type} className={cn(BASE, link || OWN_HEIGHT.test(own) ? null : 'h-11', link || OWN_PADDING.test(own) ? null : 'px-4', VARIANTS[variant], className)} {...props} />
}
