// The idempotencyKey of one submission of the LIFF decision page (spec §4.3 step 1, FR-PLT-012): the deciding commands
// take a uuid and nothing else (src/app/(workspace)/_tracking/commands.ts: z.uuid()), and a key they refuse is refused
// for good — every retry would send another key they refuse. crypto.randomUUID makes one where it exists; an older
// WebView of the LINE app has none (iOS before 15.4, Android System WebView before 92), and there a version-4 uuid is
// made from 128 random bits of crypto.getRandomValues, which every WebView has (FR-LINE-003 AC1: iOS and Android). The
// workspace's forms use the uuid package, which a LIFF page's first JavaScript cannot carry (§9.4).
// TODO(needs): once src/ui/liff/submission-key.ts makes a version-4 uuid without crypto.randomUUID too, ./send.tsx goes
// back to useLiffSubmissionKey and this file goes.

/** A random version-4 uuid (RFC 9562), with or without crypto.randomUUID */
export function newDecisionKey(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  const b = cryptoApi.getRandomValues(new Uint8Array(16))
  // The version (4) and the variant (10xx) bits
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
