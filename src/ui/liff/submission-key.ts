'use client'

import { useCallback, useState } from 'react'

// The idempotencyKey of one submission on a LIFF page (spec §4.3 step 1; FR-PLT-012 AC2): the same submission sent again
// reuses it, so the command runs once; call next() once an answer arrives. The commands, the server actions and the
// autosave route take a uuid and nothing else (z.uuid(): the version and variant of RFC 9562), and a key they refuse is
// refused for good — every retry would send another key of the same kind. So the key is a uuid on every WebView of the
// LINE app (FR-LINE-003 AC1: iOS and Android): crypto.randomUUID makes one where it exists; an older WebView has none (iOS
// before 15.4, Android System WebView before 92, and any page outside a secure context), and there a version-4 uuid
// (RFC 4122 §4.4) is made from 128 random bits of crypto.getRandomValues, which every WebView has, with its version and
// variant bits set. The workspace's useSubmissionKey (src/ui/form/submission-key.ts) does the same with the uuid package,
// which the first JavaScript of a LIFF page cannot carry (§9.4: 200 KB gzip).

/** A random version-4 uuid, with or without crypto.randomUUID: the idempotencyKey of one LIFF submission */
export function newLiffKey(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
  // The version (0100: random) in the high four bits of byte 6, the variant (10: RFC 4122) in the high two bits of byte 8
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The key of one submission: the same while it is sent again after no answer came back, a new one after next() */
export function useLiffSubmissionKey(): { readonly key: string; readonly next: () => void } {
  const [key, setKey] = useState(newLiffKey)
  const next = useCallback(() => setKey(newLiffKey()), [])
  return { key, next }
}
