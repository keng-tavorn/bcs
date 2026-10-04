'use client'

import { useCallback, useState } from 'react'

// The idempotencyKey of one submission on a LIFF page (spec §4.3 step 1; FR-PLT-012 AC2): the same submission sent again
// reuses it, so the command runs once; call next() once an answer arrives. The workspace's useSubmissionKey
// (src/ui/form/submission-key.ts) does the same with the uuid package, which a LIFF page cannot afford in its first
// JavaScript (§9.4: 200 KB gzip); LIFF pages always run in a secure context (https in LINE, localhost on this machine),
// where crypto.randomUUID exists, and anywhere else 128 random bits do the same job.

function newKey(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return Array.from(cryptoApi.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function useLiffSubmissionKey(): { readonly key: string; readonly next: () => void } {
  const [key, setKey] = useState(newKey)
  const next = useCallback(() => setKey(newKey()), [])
  return { key, next }
}
