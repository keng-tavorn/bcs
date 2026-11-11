'use client'

import { useState } from 'react'

// A file field of the portal's forms (S7-18 · §9.9: no English in a Thai screen): the browser's own file input writes
// "Choose File · No file chosen" in the browser's language, so the portal draws its own button and the chosen file's
// name in the reader's words, as the workspace's import forms do. The real input stays in the form (its value posts with
// the form, which works without this script) and keeps the keyboard focus, read by a screen reader with the label of
// its PortalField; the button only shows where to press and draws the focus ring the input has. Words come from the page
// (the server's translation), so the portal sends no messages to the browser for it.

export interface PortalFileInputProps {
  readonly id: string
  readonly name: string
  readonly accept: string
  readonly required?: boolean
  readonly describedBy?: string
  /** "เลือกไฟล์" */
  readonly chooseLabel: string
  /** "ยังไม่ได้เลือกไฟล์" */
  readonly noneLabel: string
}

export function PortalFileInput({ id, name, accept, required = false, describedBy, chooseLabel, noneLabel }: PortalFileInputProps) {
  const [chosen, setChosen] = useState<string | null>(null)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <input id={id} name={name} type="file" required={required} accept={accept} aria-describedby={describedBy} className="peer sr-only" onChange={(e) => setChosen(e.target.files?.[0]?.name ?? null)} />
      <label
        htmlFor={id}
        aria-hidden="true"
        className="inline-flex h-11 cursor-pointer items-center justify-center rounded-md border border-input bg-bg px-4 font-medium text-ink hover:bg-surface peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-focus-visible:outline-solid"
      >
        {chooseLabel}
      </label>
      <span className="min-w-0 break-all text-ink-muted">{chosen ?? noneLabel}</span>
    </div>
  )
}
