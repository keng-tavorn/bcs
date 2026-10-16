'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { Button } from '../button'

// "ลองใหม่" of a /liff/home part that could not load (FR-LINE-302 AC3): asks the server for the page again (a GET, nothing
// changes); the parts that loaded stay as they are until the new page comes. The only client code of /liff/home besides
// its links (BR-LINE-18).

export function LiffRetryButton({ label }: { readonly label: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <Button type="button" variant="secondary" disabled={pending} onClick={() => start(() => router.refresh())}>
      {label}
    </Button>
  )
}
