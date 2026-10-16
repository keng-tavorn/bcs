import { z } from 'zod'
import { LINE_POSTBACK_DATA_MAX_LENGTH, LINE_USER_ID_IN_PATH } from '@/integrations/line'

// What BCS reads and keeps of a LINE webhook (FR-LINE-005, BR-LINE-04, PDPA). The body is parsed only after its
// x-line-signature was checked on the raw bytes (BR-LINE-03, receive.ts). Each event keeps only what processing needs:
// its kind, who sent it (a 1:1 chat's LINE user id), whether LINE delivers it again, the reply token, the postback data,
// the message type and id. Stickers, locations, group ids and anything else LINE sends are dropped here and never
// stored or logged. The text of a 1:1 chat's text message is kept apart (ParsedLineEvent.inbound), never in the stored
// event: the webhook writes it to LineInboundMessage only for an organization that asks through the chat (S17-06 ·
// BR-LINE-11), where it waits until processed.

/** LINE's webhookEventId is a ULID; anything that could not be a key of ours is refused */
const WEBHOOK_EVENT_ID = /^[0-9A-Za-z]{1,64}$/
/** follow, unfollow, postback, message, join, memberJoined… */
const EVENT_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const REPLY_TOKEN_MAX_LENGTH = 256
const MESSAGE_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
/** LINE's message id: digits */
const LINE_MESSAGE_ID = /^[0-9]{1,32}$/

const RawEvent = z.object({
  type: z.string().regex(EVENT_TYPE),
  webhookEventId: z.string().regex(WEBHOOK_EVENT_ID),
  timestamp: z.number().int().nonnegative().optional(),
  mode: z.string().optional(),
  source: z.object({ type: z.string(), userId: z.string().optional() }).optional(),
  replyToken: z.string().min(1).max(REPLY_TOKEN_MAX_LENGTH).optional(),
  deliveryContext: z.object({ isRedelivery: z.boolean().optional() }).optional(),
  postback: z.object({ data: z.string() }).optional(),
  message: z.object({ type: z.string(), id: z.string().optional(), text: z.string().optional() }).optional(),
  follow: z.object({ isUnblocked: z.boolean().optional() }).optional(),
})

const RawBody = z.object({ destination: z.string().optional(), events: z.array(z.unknown()) })

/** The stored form of one event (LineWebhookEvent.payload), version 1 */
export const StoredLineEvent = z.object({
  v: z.literal(1),
  /** user = a 1:1 chat; BCS acts on those only */
  source: z.enum(['user', 'group', 'room', 'other']),
  /** The sender's LINE user id in a 1:1 chat; null otherwise or when it is not a LINE user id */
  userId: z.string().nullable(),
  /** standby: another channel answers this chat (LINE's module mode), so BCS must not */
  mode: z.enum(['active', 'standby', 'other']),
  /** LINE delivers the event again (deliveryContext.isRedelivery) */
  redelivery: z.boolean(),
  /** When it happened at LINE (ISO) */
  occurredAt: z.string().nullable(),
  /** Usable once, within a minute of the event (LINE_REPLY_TOKEN_TTL_MS) */
  replyToken: z.string().nullable(),
  /** postback.data when it is within LINE's limit; null otherwise */
  postbackData: z.string().nullable(),
  /** message.type only: the text of a message is never kept here */
  messageType: z.string().nullable(),
  /** S17-06: LINE's id of the message (a text or an image of a 1:1 chat): the key of its ChatIntakeItem and of its content; absent on events stored before */
  messageId: z.string().nullable().optional(),
  /** follow.isUnblocked: the user unblocked the account rather than adding it for the first time */
  unblocked: z.boolean().nullable(),
})
export type StoredLineEvent = z.infer<typeof StoredLineEvent>

/** A text or an image of a 1:1 chat (S17-06): what LineInboundMessage keeps until the message is processed */
export interface InboundLineMessage {
  readonly lineMessageId: string
  readonly kind: 'TEXT' | 'IMAGE'
  /** The typed text of a TEXT message; null for an image */
  readonly text: string | null
}

export interface ParsedLineEvent {
  readonly webhookEventId: string
  readonly type: string
  readonly payload: StoredLineEvent
  /** Only for a text or an image of a 1:1 chat with a usable message id */
  readonly inbound?: InboundLineMessage
}

export type ParsedLineWebhook =
  | { readonly ok: true; readonly events: readonly ParsedLineEvent[]; readonly unreadable: number }
  /** NOT_JSON: the bytes are not UTF-8 JSON · NOT_A_WEBHOOK: JSON without an events list */
  | { readonly ok: false; readonly reason: 'NOT_JSON' | 'NOT_A_WEBHOOK' }

const SOURCES = new Set(['user', 'group', 'room'])

function toStored(event: z.infer<typeof RawEvent>): StoredLineEvent {
  const sourceType = event.source?.type ?? ''
  const source = (SOURCES.has(sourceType) ? sourceType : 'other') as StoredLineEvent['source']
  const userId = source === 'user' && event.source?.userId && LINE_USER_ID_IN_PATH.test(event.source.userId) ? event.source.userId : null
  const mode = event.mode === undefined || event.mode === 'active' ? 'active' : event.mode === 'standby' ? 'standby' : 'other'
  const data = event.postback?.data
  const messageType = event.message?.type
  const messageId = event.message?.id
  // A timestamp beyond what a date can hold reads as no timestamp
  const occurred = event.timestamp === undefined ? null : new Date(event.timestamp)
  return {
    v: 1,
    source,
    userId,
    mode,
    redelivery: event.deliveryContext?.isRedelivery === true,
    occurredAt: occurred && !Number.isNaN(occurred.getTime()) ? occurred.toISOString() : null,
    replyToken: event.replyToken ?? null,
    postbackData: typeof data === 'string' && data.length <= LINE_POSTBACK_DATA_MAX_LENGTH ? data : null,
    messageType: messageType !== undefined && MESSAGE_TYPE.test(messageType) ? messageType : null,
    messageId: source === 'user' && messageId !== undefined && LINE_MESSAGE_ID.test(messageId) ? messageId : null,
    unblocked: event.follow ? event.follow.isUnblocked === true : null,
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * The events of a webhook body whose signature was already checked. An event without a usable webhookEventId cannot be
 * kept apart from a redelivery, so it is counted as unreadable and dropped (BR-LINE-04).
 */
export function parseLineWebhook(rawBody: Uint8Array): ParsedLineWebhook {
  let json: unknown
  try {
    json = JSON.parse(utf8.decode(rawBody))
  } catch {
    return { ok: false, reason: 'NOT_JSON' }
  }
  const body = RawBody.safeParse(json)
  if (!body.success) return { ok: false, reason: 'NOT_A_WEBHOOK' }
  const events: ParsedLineEvent[] = []
  let unreadable = 0
  for (const candidate of body.data.events) {
    const event = RawEvent.safeParse(candidate)
    if (!event.success) {
      unreadable++
      continue
    }
    const payload = toStored(event.data)
    const kind = event.data.type === 'message' && payload.messageId ? (payload.messageType === 'text' ? 'TEXT' : payload.messageType === 'image' ? 'IMAGE' : null) : null
    const inbound: InboundLineMessage | undefined = kind && payload.messageId ? { lineMessageId: payload.messageId, kind, text: kind === 'TEXT' ? (event.data.message?.text ?? '') : null } : undefined
    events.push({ webhookEventId: event.data.webhookEventId, type: event.data.type, payload, ...(inbound ? { inbound } : {}) })
  }
  return { ok: true, events, unreadable }
}
