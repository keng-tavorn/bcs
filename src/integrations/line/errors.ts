// Failures of a call to the LINE Messaging API, sorted the way the senders need them (§4.7 rule 2, NFR-AVL-03):
//  - permanent: LINE refused this request and the same request will be refused again — a bad request (400), a bad or
//    revoked channel access token (401), a call LINE does not allow (403), something that does not exist (404), and the
//    other 4xx answers. The sender stops retrying and uses e-mail instead.
//  - transient: LINE could not answer now — rate limit or monthly quota (429), an error of LINE (5xx), no connection, no
//    answer in time. The sender retries with backoff and falls back to e-mail when the time runs out.
// NOT CONFIRMED AT REAL LINE (check with the real channel in D-03): what a push to a user who blocked the OA, or never
// added it, answers. LINE's reference does not promise 403 for it, and LINE reports a block through the `unfollow`
// webhook event. The fake LINE server answers 403 for a "Ublocked…" user id so the e-mail fallback can be tested, but a
// sender must not count on a push failing: lineReachable = false comes from the unfollow event (BR-LINE-08, S5-08), a
// permanent failure is only a second signal.
// Like EmailSendError the error carries what a record needs — the HTTP status, LINE's own error message and details,
// LINE's request id — and never the request body (message text, PDPA) or the access token (NFR-SEC-09).

export type LineFailureKind = 'permanent' | 'transient'

export type LineFailureReason =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'CLIENT_ERROR'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'ABORTED'
  | 'BAD_RESPONSE'
  /** Refused before sending: a message over one of LINE's limits (./limits.ts) */
  | 'LIMIT_EXCEEDED'

/** The client method that failed; never the URL, which can hold a LINE user id */
export type LineOperation =
  | 'push'
  | 'reply'
  | 'botInfo'
  | 'getWebhookEndpoint'
  | 'setWebhookEndpoint'
  | 'testWebhookEndpoint'
  | 'createRichMenu'
  | 'uploadRichMenuImage'
  | 'setDefaultRichMenu'
  | 'getDefaultRichMenu'
  | 'cancelDefaultRichMenu'
  | 'linkRichMenu'
  | 'unlinkRichMenu'
  | 'bulkLinkRichMenu'
  | 'bulkUnlinkRichMenu'
  | 'getUserRichMenu'
  | 'listRichMenus'
  | 'deleteRichMenu'

export interface LineErrorDetail {
  readonly message: string
  readonly property: string | null
}

/** LINE's error texts are short; anything longer is cut so a record or a log line stays small */
const LINE_MESSAGE_MAX = 300
const DETAILS_MAX = 10

const STATUS_REASONS: Readonly<Record<number, LineFailureReason>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
}

/** Permanent or transient for an HTTP status of LINE: 408, 429 and 5xx are worth another try, every other 4xx is not. */
export function lineStatusFailure(status: number): { readonly kind: LineFailureKind; readonly reason: LineFailureReason } {
  if (status >= 500) return { kind: 'transient', reason: 'SERVER_ERROR' }
  if (status === 429) return { kind: 'transient', reason: 'RATE_LIMITED' }
  if (status === 408) return { kind: 'transient', reason: 'TIMEOUT' }
  return { kind: 'permanent', reason: STATUS_REASONS[status] ?? 'CLIENT_ERROR' }
}

const clean = (text: string, max: number) => text.replace(/\p{Cc}+/gu, ' ').trim().slice(0, max)

export class LineApiError extends Error {
  readonly kind: LineFailureKind
  readonly reason: LineFailureReason
  readonly operation: LineOperation
  /** HTTP status of LINE's answer; null when there was none (network, timeout, refused before sending) */
  readonly status: number | null
  /** LINE's `message`, e.g. "Authentication failed. Confirm that the access token in the authorization header is valid." */
  readonly lineMessage: string | null
  /** LINE's `details`: which property of the request was refused and why */
  readonly details: readonly LineErrorDetail[]
  /** x-line-request-id, for LINE support */
  readonly requestId: string | null

  constructor(init: {
    operation: LineOperation
    kind: LineFailureKind
    reason: LineFailureReason
    status?: number | null
    lineMessage?: string | null
    details?: readonly LineErrorDetail[]
    requestId?: string | null
  }) {
    const lineMessage = init.lineMessage ? clean(init.lineMessage, LINE_MESSAGE_MAX) : null
    super(`LINE ${init.operation} failed: ${init.status ?? init.reason}${lineMessage ? ` ${lineMessage}` : ''}`)
    this.name = 'LineApiError'
    this.kind = init.kind
    this.reason = init.reason
    this.operation = init.operation
    this.status = init.status ?? null
    this.lineMessage = lineMessage
    this.details = (init.details ?? []).slice(0, DETAILS_MAX).map((d) => ({ message: clean(d.message, LINE_MESSAGE_MAX), property: d.property ? clean(d.property, LINE_MESSAGE_MAX) : null }))
    this.requestId = init.requestId ?? null
  }

  /** LINE will refuse the same request again: do not retry, fall back to e-mail (bad token, bad request, refused call) */
  get permanent(): boolean {
    return this.kind === 'permanent'
  }
}

export function isLineApiError(error: unknown): error is LineApiError {
  return error instanceof LineApiError
}
