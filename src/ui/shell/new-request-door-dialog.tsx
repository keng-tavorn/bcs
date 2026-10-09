'use client'

import { useEffect, useEffectEvent, useState, type MouseEvent } from 'react'
import { NewRequestDialog } from '../request-form/new-request-dialog'
import type { CatalogEntry } from '../request-form/types'
import { NewRequestDoor } from './new-request-door'
import { onShellEvent } from './shell-events'

// The one door with its dialog (FR-INT-010 AC1): pressed, "ขอซื้อ / ขอจ้าง" opens "เริ่มคำขอใหม่" over the page. It stays a
// link to /requests/new (AC4) — before the page's script runs, or opened in a new tab, it leads to the catalogue page.
// The home's chip "เริ่มคำขอใหม่" opens this same dialog (shell-events.ts).

export function NewRequestDoorDialog({
  href,
  label,
  types,
  countDrafts,
}: {
  href: string
  label: string
  types: readonly CatalogEntry[]
  /** The member's open drafts, asked as the dialog opens (AC2) */
  countDrafts: () => Promise<number>
}) {
  const [open, setOpen] = useState(false)
  const [drafts, setDrafts] = useState<number | null>(null)
  function show() {
    setOpen(true)
    countDrafts().then(setDrafts, () => setDrafts(null))
  }
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    // A new tab or window is the catalogue page itself
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    show()
  }
  const onAsked = useEffectEvent((e: Event) => {
    e.preventDefault()
    show()
  })
  useEffect(() => onShellEvent('new-request', (e) => onAsked(e)), [])
  return (
    <>
      <NewRequestDoor href={href} label={label} onClick={onClick} />
      <NewRequestDialog open={open} onOpenChange={setOpen} types={types} drafts={drafts} />
    </>
  )
}
