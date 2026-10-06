// What the server action of /settings/notifications answers the page (FR-LINE-006 AC3): the saved setting, or the
// error code the page explains in its own words (§9.9 rule 7).

export type DigestOutcome = { readonly ok: true; readonly digest: boolean } | { readonly ok: false; readonly code: string; readonly requestId?: string }

export type SetDigestAction = (digest: boolean, idempotencyKey: string) => Promise<DigestOutcome>

export type DigestErrorKey = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'BUSY' | 'INTERNAL' | 'FAILED'

export function digestErrorKey(failure: Extract<DigestOutcome, { ok: false }>): DigestErrorKey {
  switch (failure.code) {
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
    case 'INTERNAL':
      return failure.code
    case 'RATE_LIMITED':
      return 'BUSY'
    default:
      return 'FAILED'
  }
}
