'use client'

import { Download } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../cn'
import { Notice } from '../form/notice'

// Opens a stored file (FR-PLT-004 AC2): asks the server for a download address valid 5 minutes, after it checks who may
// have the file (an Express file: export.express; an invoice's file: invoiceConfirmation.record or audit.view), then
// goes there. Addresses are never put in the page, so a page left open never holds an expired one.

export function FileButton({
  fileId,
  label,
  busyLabel,
  failedText,
  open,
  className,
}: {
  fileId: string
  /** Says what happens and names the file ("ดาวน์โหลด express-….xlsx") */
  label: string
  busyLabel: string
  failedText: string
  open: (fileId: string) => Promise<string | null>
  className?: string
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function onOpen() {
    setBusy(true)
    setFailed(false)
    const url = await open(fileId).catch(() => null)
    setBusy(false)
    if (url) window.location.assign(url)
    else setFailed(true)
  }

  return (
    <span className={cn('flex flex-col gap-2', className)}>
      <button
        type="button"
        onClick={() => void onOpen()}
        disabled={busy}
        aria-busy={busy || undefined}
        className="inline-flex min-h-11 items-center gap-2 self-start font-medium text-primary underline underline-offset-4 hover:no-underline disabled:text-ink-muted"
      >
        <Download className="size-4 shrink-0" aria-hidden="true" />
        <span className="text-left break-words">{busy ? busyLabel : label}</span>
      </button>
      {failed ? <Notice tone="danger">{failedText}</Notice> : null}
    </span>
  )
}
