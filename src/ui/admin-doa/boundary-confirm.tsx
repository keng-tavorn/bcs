'use client'

import { CircleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId } from 'react'
// Joined without tailwind-merge (§9.4): a DOA version's LIFF decision draws the tick on its first screen, and no two of
// its classes set the same thing (tests/unit/liff-classes.test.tsx)
import { cn } from '../liff/cn'

// The tick that the boundary table was checked (FR-DOA-009 AC3, BR-DOA-08 (ช)): which rule and approver each amount at
// a band edge goes to. A link jumps to the table (on wide screens it sits beside the send; on phones the send follows
// the page's content, the table included). The error arrives in the caller's words (before sending, or before
// approving) and is announced with the box, with an icon and words (NFR-A11Y-03). The drafter's send uses the words of
// the DOA pages; the approver's decision brings its own (`texts`), and `compact` keeps only the tick below the lg
// breakpoint, for an approve bar fixed to the bottom of a phone: the legend is still read out, and the table it would
// link to is on the page above the bar.

export interface BoundaryConfirmTexts {
  /** The legend of the group */
  readonly title: string
  /** The link to the table */
  readonly link: string
  /** What ticking the box says */
  readonly label: string
}

export interface BoundaryConfirmProps {
  readonly tableId: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly error?: string | undefined
  /** The caller's words; the drafter's send (adminDoa.detail) by default */
  readonly texts?: BoundaryConfirmTexts
  /** Below the lg breakpoint, only the tick (the legend stays for screen readers) */
  readonly compact?: boolean
}

export function BoundaryConfirm({ tableId, checked, onChange, error, texts, compact = false }: BoundaryConfirmProps) {
  const t = useTranslations('adminDoa.detail')
  const id = useId()
  const words = texts ?? { title: t('boundaryConfirmTitle'), link: t('boundaryConfirmLink'), label: t('boundaryConfirm') }
  return (
    <fieldset className={cn('flex flex-col', compact ? 'gap-1 lg:gap-2' : 'gap-2')}>
      <legend className={compact ? 'sr-only lg:not-sr-only lg:mb-1 lg:font-semibold' : 'mb-1 font-semibold'}>{words.title}</legend>
      <a
        href={`#${tableId}`}
        className={cn('min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline', compact ? 'hidden lg:inline-flex' : 'inline-flex')}
      >
        {words.link}
      </a>
      <label className={cn('flex min-h-11 items-start gap-3', compact ? 'py-0.5 lg:py-1' : 'py-1')}>
        <input
          type="checkbox"
          checked={checked}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange(event.currentTarget.checked)}
          className="mt-1 size-5 shrink-0 accent-[var(--primary)]"
        />
        <span>{words.label}</span>
      </label>
      {error ? (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </fieldset>
  )
}
