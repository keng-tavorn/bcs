import { MS_PER_SECOND } from '@/lib/constants'
import type { QrDrawing } from './qr'

// What the server actions of /settings/line answer the page (FR-LINE-001 AC1 AC3): success with what the page shows, or
// the error code with the reason the page explains in its own words (§9.9 rule 7). Never the raw message.

/**
 * A one-time link code as the page holds it: in this page's memory only — never in a URL of BCS, a log or a cookie
 * (it is a bearer secret for its few minutes: whoever opens it first links their LINE account to this member).
 */
export interface LinkCodeView {
  /** The LIFF page that links in LINE (LINE's address, the code in its query): the QR's content and the link itself */
  readonly url: string
  /** When the code stops working, in the reader's language */
  readonly expiresAtText: string
  /** How long the code still worked when the server answered: the countdown runs from this, not from the device clock */
  readonly remainingMs: number
  readonly qr: QrDrawing
}

export interface LineLinkFailure {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly requestId?: string
}

export type IssueLinkCodeOutcome = ({ readonly ok: true } & LinkCodeView) | LineLinkFailure
export type LinkStatusOutcome = { readonly ok: true; readonly linked: boolean } | LineLinkFailure
export type UnlinkLineOutcome = { readonly ok: true } | LineLinkFailure

export type IssueLinkCodeAction = () => Promise<IssueLinkCodeOutcome>
export type LinkStatusAction = () => Promise<LinkStatusOutcome>
export type UnlinkLineAction = (idempotencyKey: string) => Promise<UnlinkLineOutcome>

export function toLineLinkFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): LineLinkFailure {
  const d = error.details ?? {}
  return {
    ok: false,
    code: error.code,
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    ...(typeof d.requestId === 'string' ? { requestId: d.requestId } : {}),
  }
}

export type LineLinkErrorKey = 'LINE_NOT_ENABLED' | 'ALREADY_LINKED' | 'NOT_LINKED' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'BUSY' | 'INTERNAL' | 'FAILED'

/** Message key under lineLink.errors for a refused action */
export function lineLinkErrorKey(failure: LineLinkFailure): LineLinkErrorKey {
  if (failure.code === 'INVALID_STATE_TRANSITION' && (failure.reason === 'LINE_NOT_ENABLED' || failure.reason === 'ALREADY_LINKED' || failure.reason === 'NOT_LINKED')) {
    return failure.reason
  }
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

const SECONDS_PER_MINUTE = 60

/** "9:05": minutes and seconds left, rounded up so it never shows 0:00 while the code still works */
export function countdownText(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / MS_PER_SECOND))
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, '0')}`
}
