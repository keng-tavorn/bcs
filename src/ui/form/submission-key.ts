'use client'

import { useCallback, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

/**
 * The idempotencyKey of one form submission (spec §4.3 step 1: a UUID the client creates when the form opens). Sending
 * the same submission again (a double click, a retry after the answer was lost) reuses it, so the command runs once
 * (INV-PLT-01). Once an answer arrives, call next(): the following submission is a new command with a new key
 * (FR-PLT-012 AC2). uuid works on plain-http addresses too, where crypto.randomUUID is missing.
 */
export function useSubmissionKey(): { readonly key: string; readonly next: () => void } {
  const [key, setKey] = useState(() => uuidv4())
  const next = useCallback(() => setKey(uuidv4()), [])
  return { key, next }
}
