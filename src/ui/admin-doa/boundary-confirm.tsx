'use client'

import { CircleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId } from 'react'

// The tick that the boundary table was checked (FR-DOA-009 AC3, BR-DOA-08 (ช)): which rule and approver each amount at
// a band edge goes to. A link jumps to the table (on wide screens it sits beside the send; on phones the send follows
// the page's content, the table included). The error arrives in the caller's words (before sending, or before
// approving) and is announced with the box, with an icon and words (NFR-A11Y-03).

export function BoundaryConfirm({ tableId, checked, onChange, error }: { tableId: string; checked: boolean; onChange: (checked: boolean) => void; error?: string }) {
  const t = useTranslations('adminDoa.detail')
  const id = useId()
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 font-semibold">{t('boundaryConfirmTitle')}</legend>
      <a href={`#${tableId}`} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {t('boundaryConfirmLink')}
      </a>
      <label className="flex min-h-11 items-start gap-3 py-1">
        <input
          type="checkbox"
          checked={checked}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange(event.currentTarget.checked)}
          className="mt-1 size-5 shrink-0 accent-[var(--primary)]"
        />
        <span>{t('boundaryConfirm')}</span>
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
