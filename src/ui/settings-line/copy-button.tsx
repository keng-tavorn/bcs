'use client'

import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../form/button'

// Copies one value to the clipboard (a webhook URL, a link to open in LINE) and says so in words next to the button. A
// browser that refuses the clipboard gets the words to copy by hand instead (the value is on the page beside it).
export function CopyButton({ value, label, copiedLabel, failedLabel }: { value: string; label: string; copiedLabel: string; failedLabel: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button variant="secondary" onClick={copy}>
        {state === 'copied' ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
        {label}
      </Button>
      <p role="status" className="text-base text-ink-muted md:text-sm">
        {state === 'copied' ? copiedLabel : state === 'failed' ? failedLabel : ''}
      </p>
    </div>
  )
}
