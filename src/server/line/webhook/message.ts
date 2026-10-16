import { findLinkedMemberId } from './identity'
import type { LineEventContext, LineEventOutcome, LineWebhookChannel, RecordedLineEvent } from './types'

// Messages of a 1:1 chat in the active mode (S17-06 · BR-LINE-10): the webhook hands them to the one handler that owns
// the chat (asking through the chat, src/server/services/chat-intake registers it). Without a handler a message is
// skipped as before S17. The dispatcher resolves who wrote — the member linked to the LINE user of the signed webhook
// (BR-LINE-01) — and passes the message's kind and id only: the text waits in LineInboundMessage (BR-LINE-11).

export interface LineMessageRequest {
  readonly organizationId: string
  /** LineWebhookEvent.id: the key of the message's text in LineInboundMessage */
  readonly eventId: string
  /** LINE's id of the event: the idempotency key of the command run for it (§4.3 step 1) */
  readonly webhookEventId: string
  /** From the signed webhook (source.userId of a 1:1 chat) */
  readonly lineUserId: string
  /** The ACTIVE member this LINE user is linked to in the organization, under the channel's provider; null when none */
  readonly memberId: string | null
  /** LINE's message type: text, image, sticker, … (null when LINE sent none we keep) */
  readonly messageType: string | null
  /** null when LINE sent none; works once, within LINE_REPLY_TOKEN_TTL_MS of receivedAt (BR-LINE-07: reply before push) */
  readonly replyToken: string | null
  readonly receivedAt: Date
}

export interface LineMessageContext extends LineEventContext {
  readonly channel: LineWebhookChannel
}

/**
 * Handles one message. Returns how it ended; throws only when it should be tried again (the event then goes to the
 * line-webhook job), so it must be idempotent: a command it runs uses the event's webhookEventId as its key, and a push
 * the event's id as LINE's retry key.
 */
export type LineMessageHandler = (request: LineMessageRequest, context: LineMessageContext) => Promise<LineEventOutcome>

let messageHandler: LineMessageHandler | null = null

/**
 * Registers the handler of chat messages, from the module that owns the chat. Registering again replaces it (a module
 * evaluated again in development registers again). Returns the removal of this handler, which leaves a later one.
 */
export function registerLineMessageHandler(handler: LineMessageHandler): () => void {
  messageHandler = handler
  return () => {
    if (messageHandler === handler) messageHandler = null
  }
}

export async function dispatchLineMessage(channel: LineWebhookChannel, event: RecordedLineEvent, lineUserId: string, context: LineEventContext): Promise<LineEventOutcome> {
  const handler = messageHandler
  if (!handler) return { status: 'SKIPPED', reason: 'NOT_HANDLED' }
  const memberId = await findLinkedMemberId(channel.organizationId, channel.providerId, lineUserId)
  return handler(
    {
      organizationId: channel.organizationId,
      eventId: event.id,
      webhookEventId: event.webhookEventId,
      lineUserId,
      memberId,
      messageType: event.payload.messageType,
      replyToken: event.payload.replyToken,
      receivedAt: event.receivedAt,
    },
    { ...context, channel },
  )
}
