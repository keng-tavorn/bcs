'use client'

import { Button } from '../button'
import { useLiff } from '../liff-provider'

// Back to the LINE chat after a task is decided (§9.4): the LIFF window closes and the member is where the card was.
// Inside the LINE app only — elsewhere (a browser, LIFF_MOCK) there is no chat to go back to.

export function BackToChat({ label }: { readonly label: string }) {
  const { inClient, mocked, closeWindow } = useLiff()
  if (!inClient || mocked) return null
  return (
    <Button variant="secondary" className="w-full" onClick={closeWindow}>
      {label}
    </Button>
  )
}
