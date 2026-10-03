'use client'

import { useTranslations } from 'next-intl'
import { cn } from '../cn'
import type { StepId } from './outcome'

// The steps of the form (a real sequence, so they are numbered, §9.9). Wide screens list them all and any step can be
// opened; on phones the step's own heading says which step of how many it is, and the buttons at the end of each step
// move on. The current step is marked by weight, a border and aria-current, never by colour alone.

export function Stepper({ steps, current, onSelect }: { steps: ReadonlyArray<{ id: StepId; label: string }>; current: StepId; onSelect: (id: StepId) => void }) {
  const t = useTranslations('requestForm.steps')
  return (
    <nav aria-label={t('label')} className="hidden sm:block">
      <ol className="flex flex-wrap gap-2">
        {steps.map((s, i) => {
          const here = s.id === current
          return (
            <li key={s.id}>
              <button
                type="button"
                aria-current={here ? 'step' : undefined}
                onClick={() => onSelect(s.id)}
                className={cn(
                  'inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-left transition-colors duration-150',
                  here ? 'border-2 border-primary font-semibold text-ink' : 'border-line text-ink-muted hover:bg-surface hover:text-ink',
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
