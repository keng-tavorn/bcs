import { Inngest } from 'inngest'
import {
  OutboxRefusedError,
  OutboxUncertainError,
  OutboxUnavailableError,
  setDefaultOutboxSender,
  type OutboxMessage,
  type OutboxSender,
} from '@/server/events/outbox'

// One Inngest client for job functions (src/server/jobs). Inngest v4 reads INNGEST_DEV (local dev server),
// INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY from the environment.
// Inngest is only a timer and queue: business state stays in our database (ADR-006).
export const inngest = new Inngest({ id: 'bcs' })

// The outbox relay does not use inngest.send(): the SDK repeats a failed send up to 5 times with backoff inside
// one call, which multiplied requests, outlasted the relay's deadlines and hid the real cause (a refusal looked
// like an outage). The relay makes exactly one request per send to the Inngest Event API (POST /e/<event key>)
// and classifies the answer itself; retrying and isolating bad messages is the relay's job (outbox.ts).

// Answers that refuse the messages themselves: the relay splits the batch to find the bad one
const MESSAGE_REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 406, 409, 412, 413, 422])
// Answers that mean Inngest takes no event, whatever the content: event key or URL problems, rate limit
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 429])
// Connection failures before the request reaches Inngest, so the content cannot be the cause (DNS, refused or
// unreachable host, connect timeout, TLS). Anything else that ends a request (reset mid-request, no answer, 5xx)
// gives no verdict on the messages.
const CONNECT_FAILURE = /^(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENETDOWN|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$|CERT|TLS|SSL/
// The SDK's placeholder key for the local dev server, which accepts any key
const DEV_EVENT_KEY = 'NO_EVENT_KEY_SET'
const ANSWER_TEXT_MAX = 200

/** Error codes on a fetch failure and its causes (an AggregateError when several addresses were tried). */
function failureCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== 'object' || depth > 4) return []
  const e = error as { code?: unknown; cause?: unknown; errors?: unknown }
  return [
    ...(typeof e.code === 'string' ? [e.code] : []),
    ...failureCodes(e.cause, depth + 1),
    ...(Array.isArray(e.errors) ? e.errors.flatMap((inner: unknown) => failureCodes(inner, depth + 1)) : []),
  ]
}

function failureText(error: unknown, depth = 0): string {
  if (!(error instanceof Error) || depth > 4) return String(error)
  const inner = [error.cause, ...(error instanceof AggregateError ? error.errors : [])].filter((c) => c instanceof Error)
  const detail = inner.map((c) => failureText(c, depth + 1)).filter(Boolean)
  return [error.message, ...detail].filter(Boolean).join(': ')
}

/** The Event API's own error text, or the start of whatever else answered (a proxy page). */
function answerText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed.error === 'string') return parsed.error.slice(0, ANSWER_TEXT_MAX)
  } catch {
    // not JSON
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, ANSWER_TEXT_MAX)
}

/** Outbox sender to the Inngest Event API; baseUrl and isDev point tests at a fake event API. */
export function createInngestSender(options: { baseUrl?: string; isDev?: boolean } = {}): OutboxSender {
  // This client only resolves configuration the way inngest.send() would: mode, Event API URL, event key and the
  // SDK headers (including the branch environment, x-inngest-env)
  const config = new Inngest({
    id: 'bcs',
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.isDev === undefined ? {} : { isDev: options.isDev }),
  })
  return async (messages: readonly OutboxMessage[], sendOptions) => {
    const eventKey = config.eventKey
    if (config.mode === 'cloud' && !eventKey) throw new OutboxUnavailableError('INNGEST_EVENT_KEY is not set')
    // The event key is a secret and part of the URL: it never goes into an error text
    const hideKey = (text: string) => (eventKey ? text.split(eventKey).join('[REDACTED]') : text)
    const url = new URL(`e/${eventKey ?? DEV_EVENT_KEY}`, config.eventBaseUrl)
    let response: Response
    let body: string
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { ...config.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(messages.map((m) => ({ id: m.id, name: m.name, data: m.data }))),
        signal: sendOptions?.signal ?? null,
      })
      body = await response.text()
    } catch (error) {
      if (error instanceof OutboxUnavailableError || error instanceof OutboxUncertainError) throw error
      const text = hideKey(`could not reach Inngest: ${failureText(error)}`)
      if (failureCodes(error).some((code) => CONNECT_FAILURE.test(code))) throw new OutboxUnavailableError(text, { cause: error })
      throw new OutboxUncertainError(text, { cause: error })
    }
    let status = response.status
    if (response.ok) {
      // The Event API answers { ids, status: 200 }; anything else in a 2xx is a failure (as the SDK treats it)
      let answer: { status?: unknown; error?: unknown } | null = null
      try {
        answer = JSON.parse(body) as { status?: unknown; error?: unknown }
      } catch {
        answer = null
      }
      if (answer && answer.error === undefined && (answer.status === undefined || answer.status === 200)) return
      if (answer && typeof answer.status === 'number' && answer.status !== 200) status = answer.status
    }
    const text = hideKey(`Inngest API Error: ${status} ${answerText(body)}`.trim())
    if (MESSAGE_REFUSED_STATUSES.has(status)) throw new OutboxRefusedError(text)
    if (UNAVAILABLE_STATUSES.has(status)) throw new OutboxUnavailableError(text)
    throw new OutboxUncertainError(text)
  }
}

export const inngestSender: OutboxSender = createInngestSender()

setDefaultOutboxSender(inngestSender)
