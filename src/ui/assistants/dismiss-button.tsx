'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Button } from '../shadcn/button'

// "ไม่ใช่เรื่องนี้" (NEW-121 · ADR-078): sets the suggestion aside for this member, then the card is read again without it.
// The focus goes to the card's list, so a keyboard does not land on nothing; a failure is said beside the button,
// never in a toast alone (§9.9).

export function DismissButton({ suggestionKey, label, text, failed, focusAfter, dismiss }: { suggestionKey: string; label: string; text: string; failed: string; focusAfter: string; dismiss: (key: string) => Promise<{ readonly ok: boolean }> }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        aria-label={label}
        disabled={pending}
        aria-busy={pending || undefined}
        className="min-h-11 text-ink-muted lg:min-h-9"
        onClick={() =>
          start(async () => {
            setError(false)
            const outcome = await dismiss(suggestionKey).catch(() => ({ ok: false }))
            if (!outcome.ok) return setError(true)
            document.getElementById(focusAfter)?.focus()
            router.refresh()
          })
        }
      >
        {text}
      </Button>
      {error ? (
        <p role="alert" className="basis-full text-base text-danger-ink md:text-sm">
          {failed}
        </p>
      ) : null}
    </>
  )
}
