'use client'

import { useTranslations } from 'next-intl'
import { cn } from '../cn'

// The steps of a form (a real sequence, so they are numbered, §9.9): the request form and the new-supplier form. Wide
// screens list them all and any step that may be opened is a button; on phones the step's own heading says which step
// of how many it is, and the buttons at the end of each step move on. The current step is marked by weight, a border
// and aria-current, never by colour alone.

export function Stepper<T extends string>({
  steps,
  current,
  onSelect,
  label,
  canOpen,
}: {
  steps: ReadonlyArray<{ id: T; label: string }>
  current: T
  onSelect: (id: T) => void
  /** The list's name for screen readers; the request form's own by default */
  label?: string
  /** Steps that may not be opened yet are shown but cannot be pressed (default: every step may be opened) */
  canOpen?: (id: T) => boolean
}) {
  const t = useTranslations('requestForm.steps')
  return (
    <nav aria-label={label ?? t('label')} className="hidden sm:block">
      <ol className="flex flex-wrap gap-2">
        {steps.map((s, i) => {
          const here = s.id === current
          const open = canOpen ? canOpen(s.id) : true
          return (
            <li key={s.id}>
              <button
                type="button"
                aria-current={here ? 'step' : undefined}
                disabled={!here && !open}
                onClick={() => onSelect(s.id)}
                className={cn(
                  'inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-left transition-colors duration-150 disabled:cursor-not-allowed',
                  here ? 'border-2 border-primary font-semibold text-ink' : 'border-line text-ink-muted hover:bg-surface hover:text-ink disabled:hover:bg-transparent disabled:hover:text-ink-muted',
                )}
              >
                <span className="tabular">{t('number', { n: i + 1 })}</span>
                <span>{s.label}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
