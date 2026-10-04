import { useCallback, useState } from 'react'

// The idempotencyKeys of the LIFF request pages (spec §4.3; FR-PLT-012 AC2): the services, the server actions and the
// autosave route take a uuid only (z.uuid()). LIFF pages run in a secure context (https in LINE, localhost on this
// machine), where crypto.randomUUID exists; where it does not (an older iOS WebView in LINE), a version-4 uuid is made
// from 128 random bits, with the version and variant bits set, so the key is still a uuid. The workspace's forms use the
// uuid package, which the first JavaScript of a LIFF page cannot carry (§9.4).

export function newUuid(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  const b = cryptoApi.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The key of one submission: the same while it is sent again after no answer came back, a new one after next() */
export function useRequestKey(): { readonly key: string; readonly next: () => void } {
  const [key, setKey] = useState(newUuid)
  const next = useCallback(() => setKey(newUuid()), [])
  return { key, next }
}
