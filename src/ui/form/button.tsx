import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../cn'

// Buttons say what will happen (§9.9 rule 7). 44 px tall for touch; transitions only show the result of an action.
// A button that cannot be pressed now keeps its words readable (§9.9: contrast 4.5:1 or more, no exception for a
// disabled control): the secondary text on the light surface, inside a quiet rule, not the button faded out. Pointed
// at, the main button keeps its --primary fill and underlines its words: every colour on the screen is a token of §9.9.
const VARIANTS = {
  primary:
    'bg-primary text-primary-foreground underline-offset-4 hover:underline disabled:bg-surface disabled:text-ink-muted disabled:no-underline disabled:ring-1 disabled:ring-line disabled:ring-inset',
  secondary: 'border border-input bg-bg text-ink hover:bg-surface disabled:border-line disabled:bg-surface disabled:text-ink-muted',
  // Actions that take something away (deactivate, switch off): outlined in danger so it never looks like the main action
  danger: 'border border-danger bg-bg text-danger hover:bg-surface disabled:border-line disabled:bg-surface disabled:text-ink-muted',
  link: 'h-auto px-0 text-primary underline underline-offset-4 hover:no-underline disabled:text-ink-muted',
} as const

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: keyof typeof VARIANTS
}

export function Button({ variant = 'primary', className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn('inline-flex h-11 items-center justify-center gap-2 rounded-md px-4 font-medium transition-colors duration-150 disabled:cursor-not-allowed', VARIANTS[variant], className)}
      {...props}
    />
  )
}
