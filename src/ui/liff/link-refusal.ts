import type { ActionFailure } from '../tasks/outcome'

// The words of a refused link, unlink or check on /liff/link (FR-LINE-001, §9.9 rule 7): the error code of the LINE link
// service (src/server/services/line-link, POST /api/liff/link) or of the LIFF service (src/server/services/liff) and its
// reason, as a message key under liff.link.refused — expired, used, someone else's, rate limited and the rest. Never
// the service's developer message, the code or a token.

export const LINK_REFUSAL_KEYS = [
  'TOKEN_EXPIRED',
  'UNLINKED_SINCE',
  'TOKEN_USED',
  'TOKEN_INVALID',
  'ACCOUNT_LINKED_TO_ANOTHER_MEMBER',
  'MEMBER_LINKED_TO_ANOTHER_ACCOUNT',
  'ALREADY_LINKED',
  'LINE_NOT_ENABLED',
  'FORBIDDEN',
  'SIGN_IN_WITH_PASSWORD',
  'RATE_LIMITED',
  'RATE_LIMITED_LATER',
  'ID_TOKEN_INVALID',
  'EXTERNAL_SERVICE_ERROR',
  'NOT_LINKED',
  'LINK_CHANGED',
  'UNAUTHENTICATED',
  'FAILED',
] as const
export type LinkRefusalKey = (typeof LINK_REFUSAL_KEYS)[number]

/** A refusal as the link answers it: POST /api/liff/link's body, or a server action's ActionFailure */
export interface LinkRefusal {
  readonly code: string
  readonly reason?: string
  readonly field?: string
  /** RATE_LIMITED: when to try again (ISO) */
  readonly time?: string
}

/** What checkThisLineAction answers: whether the member's link is to the LINE account the page is open in */
export type ThisLineOutcome = { readonly ok: true; readonly link: 'this' | 'other' | 'none' } | ActionFailure

/** INVALID_STATE_TRANSITION reasons of src/server/services/line-link/refusals.ts and the LIFF service with their own words */
const STATE_REASONS: ReadonlySet<string> = new Set(['LINE_NOT_ENABLED', 'ALREADY_LINKED', 'ACCOUNT_LINKED_TO_ANOTHER_MEMBER', 'MEMBER_LINKED_TO_ANOTHER_ACCOUNT', 'NOT_LINKED', 'LINK_CHANGED'])

/** When a RATE_LIMITED refusal may be tried again, or null when it did not say (or said something that is not a time) */
export function retryTimeOf(refusal: LinkRefusal): Date | null {
  if (!refusal.time) return null
  const time = new Date(refusal.time)
  return Number.isNaN(time.getTime()) ? null : time
}

export function linkRefusalKey(refusal: LinkRefusal): LinkRefusalKey {
  const { code, reason, field } = refusal
  switch (code) {
    case 'TOKEN_EXPIRED':
      return reason === 'UNLINKED_SINCE' ? 'UNLINKED_SINCE' : 'TOKEN_EXPIRED'
    // The same code sent again with another LINE account is the same request with other input: the code is spent
    case 'TOKEN_USED':
    case 'IDEMPOTENCY_CONFLICT':
      return 'TOKEN_USED'
    case 'TOKEN_INVALID':
      return 'TOKEN_INVALID'
    case 'VALIDATION_FAILED':
      return field === 'idToken' ? 'ID_TOKEN_INVALID' : field === 'code' ? 'TOKEN_INVALID' : 'FAILED'
    case 'INVALID_STATE_TRANSITION':
      return reason && STATE_REASONS.has(reason) ? (reason as LinkRefusalKey) : 'FAILED'
    case 'FORBIDDEN':
      // Another site's page (CROSS_SITE) is not the person's doing
      if (reason === 'CROSS_SITE') return 'FAILED'
      return reason === 'PASSWORD_SIGN_IN_REQUIRED' ? 'SIGN_IN_WITH_PASSWORD' : 'FORBIDDEN'
    case 'RATE_LIMITED':
      return retryTimeOf(refusal) ? 'RATE_LIMITED' : 'RATE_LIMITED_LATER'
    case 'UNAUTHENTICATED':
      return reason === 'ID_TOKEN_INVALID' ? 'ID_TOKEN_INVALID' : 'UNAUTHENTICATED'
    case 'EXTERNAL_SERVICE_ERROR':
      return 'EXTERNAL_SERVICE_ERROR'
    default:
      return 'FAILED'
  }
}
