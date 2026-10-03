import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../cn'

// Buttons say what will happen (§9.9 rule 7). 44 px tall for touch; transitions only show the result of an action.
const VARIANTS = {
  primary: 'bg-primary text-primary-foreground hover:bg-[color-mix(in_oklab,var(--primary)_85%,black)]',
  secondary: 'border border-input bg-bg text-ink hover:bg-surface',
  // Actions that take something away (deactivate, switch off): outlined in danger so it never looks like the main action
  danger: 'border border-danger bg-bg text-danger hover:bg-surface',
  link: 'h-auto px-0 text-primary underline underline-offset-4 hover:no-underline',
} as const

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: keyof typeof VARIANTS
}

export function Button({ variant = 'primary', className, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex h-11 items-center justify-center gap-2 rounded-md px-4 font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  )
}
