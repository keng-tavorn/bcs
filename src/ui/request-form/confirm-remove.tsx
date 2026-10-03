'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from '../form/button'
import { cn } from '../cn'

// Taking something off the request — a line, a quotation, a file — asks once, right next to it, in words that say what
// goes and what follows from it (§9.9: nothing that cannot be easily undone happens without a confirmation). The button
// that removes is outlined in danger, never a plain link beside "open"; in the question the removal and "keep it" look
// apart and sit apart. Focus moves to the question, and back to the button when the requester keeps the item.

export function ConfirmRemove({
  label,
  question,
  detail,
  confirmLabel,
  keepLabel,
  onConfirm,
  disabled,
  className,
}: {
  /** The button: says what it removes ("ลบรายการที่ 2") */
  label: string
  question: string
  /** What follows from removing it (budget given back, a file going with a quotation) */
  detail?: ReactNode
  confirmLabel: string
  keepLabel: string
  onConfirm: () => void
  disabled?: boolean
  className?: string
}) {
  const [asking, setAsking] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const kept = useRef(false)
  const id = useId()
  useEffect(() => {
    if (asking) box.current?.querySelector<HTMLElement>('[data-question]')?.focus()
    else if (kept.current) box.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [asking])
  return (
    <div ref={box} className={cn('min-w-0', className)}>
      {asking ? (
        <div role="group" aria-labelledby={`${id}-question`} className="flex flex-col gap-2 border-l-4 border-danger bg-surface px-3 py-2.5">
          <p id={`${id}-question`} data-question tabIndex={-1} className="font-medium text-ink outline-none">
            {question}
          </p>
          {detail ? <p className="text-ink">{detail}</p> : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
            <Button
              variant="danger"
              className="self-start"
              onClick={() => {
                kept.current = false
                setAsking(false)
                onConfirm()
              }}
            >
              {confirmLabel}
            </Button>
            <Button
              variant="secondary"
              className="self-start"
              onClick={() => {
                kept.current = true
                setAsking(false)
              }}
            >
              {keepLabel}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="danger" disabled={disabled} onClick={() => setAsking(true)}>
          {label}
        </Button>
      )}
    </div>
  )
}
