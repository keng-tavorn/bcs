'use client'

import { useEffect, useState } from 'react'
import type { PreviewRequestInput, PreviewView } from './types'
import type { FormOutcome } from './outcome'

export type PreviewAction = (input: PreviewRequestInput) => Promise<FormOutcome<{ preview: PreviewView }>>

const PREVIEW_DELAY_MS = 400

/**
 * The budget line's balance and the expected approval route for the form as it is now (FR-INT-004 AC1, FR-DOA-003 AC2),
 * asked of the server shortly after the amount, the lines or the budget line change. The last answer stays on screen
 * until the next one arrives; an answer for older input is dropped.
 */
export function usePreview(action: PreviewAction, input: PreviewRequestInput | null): { readonly preview: PreviewView | null; readonly loading: boolean; readonly failed: boolean } {
  const key = input ? JSON.stringify(input) : ''
  const [answer, setAnswer] = useState<{ key: string; preview: PreviewView | null; failed: boolean } | null>(null)
  useEffect(() => {
    if (!key) return
    let current = true
    const timer = setTimeout(() => {
      action(JSON.parse(key) as PreviewRequestInput)
        .then((r) => {
          if (current) setAnswer({ key, preview: r.ok ? r.preview : null, failed: !r.ok })
        })
        .catch(() => {
          if (current) setAnswer({ key, preview: null, failed: true })
        })
    }, PREVIEW_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [action, key])
  return { preview: answer?.preview ?? null, loading: answer?.key !== key, failed: answer?.key === key && answer.failed }
}
