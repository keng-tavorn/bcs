import { LINE_POSTBACK_DATA_MAX_LENGTH } from '@/integrations/line'
import { findLinkedMemberId } from './identity'
import type { LineEventContext, LineEventOutcome, LineWebhookChannel, RecordedLineEvent } from './types'

// Postbacks (§9.3, BR-TOK-02): a button of a BCS card sends `v=1&a=<action>&…` — for an approval `v=1&a=approve&k=<tokenId>`
// and nothing else. The dispatcher reads the version and the action and hands the event to the handler registered for
// that action (S5-05 registers `approve`). It resolves who tapped: the member linked to the LINE user id of the event —
// the signed webhook says who it is, never a browser (BR-LINE-01) — and the handler checks that this is the member the
// token was issued to (BR-TOK-02). Data that is not of this form, or an action nobody handles, is skipped.

/** An action name: lower case, as in `approve` */
const ACTION = /^[a-z][a-z0-9_]{0,31}$/
export const LINE_POSTBACK_VERSION = '1'

export interface ParsedLinePostback {
  readonly action: string
  /** Every key of the data, `v` and `a` included; a key given twice makes the data invalid */
  readonly params: ReadonlyMap<string, string>
}

/** The action and parameters of postback data, or null when it is not `v=1&a=<action>[&…]` within LINE's limit. */
export function parseLinePostbackData(data: string): ParsedLinePostback | null {
  if (data.length === 0 || data.length > LINE_POSTBACK_DATA_MAX_LENGTH) return null
  const params = new Map<string, string>()
  for (const [key, value] of new URLSearchParams(data)) {
    // `a=approve&a=reject` could be read either way: refused rather than guessed
    if (params.has(key)) return null
    params.set(key, value)
  }
  const action = params.get('a') ?? ''
  if (params.get('v') !== LINE_POSTBACK_VERSION || !ACTION.test(action)) return null
  return { action, params }
}

export interface LinePostbackRequest {
  readonly organizationId: string
  /** LineWebhookEvent.id */
  readonly eventId: string
  /** LINE's id of the event: the idempotency key of a command run for it (§4.3 step 1) */
  readonly webhookEventId: string
  /** From the signed webhook (source.userId of a 1:1 chat) */
  readonly lineUserId: string
  /** The ACTIVE member this LINE user is linked to in the organization, under the channel's provider; null when none */
  readonly memberId: string | null
  readonly action: string
  readonly params: ReadonlyMap<string, string>
  /** null when LINE sent none; works once, within LINE_REPLY_TOKEN_TTL_MS of receivedAt (BR-LINE-07: reply before push) */
  readonly replyToken: string | null
  readonly receivedAt: Date
  /** LINE delivers this event again: it was not recorded before (a recorded one never reaches a handler, BR-LINE-04) */
  readonly redelivery: boolean
}

export interface LinePostbackContext extends LineEventContext {
  readonly channel: LineWebhookChannel
}

/**
 * Handles one action. Returns how it ended; throws only when it should be tried again (the event is then handed to the
 * line-webhook job, or the job's step is retried), so it must be idempotent — a command it runs uses the event's
 * webhookEventId or the token as its idempotency key. It must also stay correct when it runs twice at once: an event
 * still running inline when the webhook answers is handed to the job too, which takes it only after the request has
 * surely ended (LINE_WEBHOOK_REQUEST_ENDED_MS), but a request that outlives that would still be running.
 * Reply or push (BR-LINE-07): reply while context.clock.now() is within LINE_REPLY_TOKEN_TTL_MS of receivedAt — read the
 * clock when answering, not context.now, which is when processing started — and push otherwise.
 */
export type LinePostbackHandler = (request: LinePostbackRequest, context: LinePostbackContext) => Promise<LineEventOutcome>

const handlers = new Map<string, LinePostbackHandler>()

/**
 * Registers the handler of one action, from the module that owns the action (one module per action). Registering the
 * action again replaces its handler, as src/server/events/registry.ts does for event types: a module evaluated again
 * (development reload) registers again. Returns the removal of this handler, which leaves a later one in place.
 */
export function registerLinePostbackHandler(action: string, handler: LinePostbackHandler): () => void {
  if (!ACTION.test(action)) throw new TypeError(`"${action}" is not a postback action name (lower case letters, digits and _)`)
  handlers.set(action, handler)
  return () => {
    if (handlers.get(action) === handler) handlers.delete(action)
  }
}

/** The actions that have a handler now */
export function linePostbackActions(): string[] {
  return [...handlers.keys()].sort()
}

export async function dispatchLinePostback(
  channel: LineWebhookChannel,
  event: RecordedLineEvent,
  lineUserId: string,
  context: LineEventContext,
): Promise<LineEventOutcome> {
  const parsed = event.payload.postbackData === null ? null : parseLinePostbackData(event.payload.postbackData)
  if (!parsed) return { status: 'SKIPPED', reason: 'POSTBACK_INVALID' }
  const handler = handlers.get(parsed.action)
  if (!handler) return { status: 'SKIPPED', reason: 'POSTBACK_UNKNOWN_ACTION' }
  const memberId = await findLinkedMemberId(channel.organizationId, channel.providerId, lineUserId)
  return handler(
    {
      organizationId: channel.organizationId,
      eventId: event.id,
      webhookEventId: event.webhookEventId,
      lineUserId,
      memberId,
      action: parsed.action,
      params: parsed.params,
      replyToken: event.payload.replyToken,
      receivedAt: event.receivedAt,
      redelivery: event.payload.redelivery,
    },
    { ...context, channel },
  )
}
