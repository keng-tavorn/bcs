import { routeChatMessage, type ChatAction, type ChatReply } from '@/core/chat-intake'
import type { Result } from '@/core/result'
import { isLineApiError, LINE_REPLY_TOKEN_TTL_MS, type LineMessage } from '@/integrations/line'
import { logger } from '@/lib/logger'
import type { ChatIntakeSettings } from '@/lib/s17-settings'
import { makeCtx, type Ctx } from '@/server/context'
import { liffLink, type LineEventOutcome, type LineMessageContext, type LineMessageHandler, type LineMessageRequest } from './webhook'

// Asking through the LINE chat, the chat side (S17-06 · BR-LINE-10, BR-LINE-15 · FR-LINE-301 AC1 AC2 AC7), plugged into
// the webhook by src/server/services/chat-intake/line-message.ts, which passes the service (src/server/line may not import
// services). For one message of a 1:1 chat in the active mode:
//  1. an organization that does not ask through the chat (a UAT sandbox never does): skipped as before S17, and the text
//     the webhook kept, if any, is thrown away;
//  2. a LINE user linked to nobody: the reply that asks them to link first (never pushed), and the text is thrown away;
//  3. a linked member: chat_intake.receive as that member on channel LINE_CHAT, with LINE's webhookEventId as the key, so
//     a run of the event again (the line-webhook job) replays the stored answer instead of adding the message twice;
//  4. the answer the command chose goes by the reply token while it is fresh — read the clock now, after the command ran —
//     and only the LIFF button goes by push: when the token expired, or LINE refused the reply, and the draft never had the
//     button (the command says so: pushAllowed), with the event's id as LINE's retry key, so a retry never pushes twice.
// Answers carry nothing the member typed, no items, prices or supplier names (BR-NOTI-01, BR-LINE-06). Logs name the
// organization, the event and codes only: never the text, the LINE user id or the reply token (NFR-SEC-09).

/** What chat_intake.receive answers (src/server/services/chat-intake/receive.ts) */
export interface ChatReceiveResult {
  readonly action: ChatAction
  readonly reply: ChatReply
  readonly via: 'REPLY' | 'PUSH' | null
  /** The draft the message went to, or the open one an image could not join; null when none */
  readonly intakeId: string | null
  /** The answer carries the LIFF button and the draft never had it before: the one push it may get (BR-LINE-15) */
  readonly pushAllowed: boolean
}

export interface ChatIntakeLineDeps {
  /** settings.chatIntake as the chat reads it (chatIntakeSettingsFor: a sandbox never asks through the chat) */
  readonly settingsOf: (organizationId: string) => Promise<ChatIntakeSettings>
  /** chat_intake.receive */
  readonly receive: (ctx: Ctx, input: { readonly lineWebhookEventId: string }, options: { readonly idempotencyKey: string }) => Promise<Result<ChatReceiveResult>>
  /** Deletes the text the webhook kept for a message nobody will take (BR-LINE-11) */
  readonly discardText: (organizationId: string, eventId: string) => Promise<void>
}

/** Codes another try may fix (§4.3 step 6): the event goes to the line-webhook job */
const TRANSIENT: ReadonlySet<string> = new Set(['RATE_LIMITED', 'INTERNAL'])
/** LINE's limits of a buttons template without a title or picture: its text and an action's label */
const BUTTONS_TEXT_MAX = 160
const BUTTON_LABEL_MAX = 20

const text = (lines: readonly string[]): LineMessage => ({ type: 'text', text: lines.join('\n') })

function buttons(altText: string, lines: readonly string[], label: string, uri: string): LineMessage {
  const body = lines.join('\n')
  if (body.length > BUTTONS_TEXT_MAX || label.length > BUTTON_LABEL_MAX) throw new Error('a chat answer is over LINE’s limits of a buttons template')
  return { type: 'template', altText, template: { type: 'buttons', text: body, actions: [{ type: 'uri', label, uri }] } }
}

const REVIEW_LABEL = 'ตรวจและส่งคำขอ'
const REVIEW_ALT = 'ตรวจและส่งคำขอใน BCS · Review and send your request in BCS'

/** The texts of each answer, Thai then English: the sender's language is not known (§10.3: short, polite, neutral) */
export function chatAnswerMessages(reply: ChatReply, links: { readonly liffId: string | null; readonly intakeId: string | null }): LineMessage[] {
  const intakeUrl = links.liffId && links.intakeId ? liffLink(links.liffId, `/requests/new?intake=${links.intakeId}`) : null
  const withButton = (lines: readonly string[], fallback: readonly string[]): LineMessage[] => [intakeUrl ? buttons(REVIEW_ALT, lines, REVIEW_LABEL, intakeUrl) : text([...lines, ...fallback])]
  const noLiff = ['เปิดเมนู "ขอซื้อ" เพื่อตรวจและส่ง', 'Open "Request" in the menu to review and send.']
  switch (reply) {
    case 'INTAKE_LINK':
      return withButton(['รับเรื่องแล้ว แตะปุ่มเพื่อเลือกประเภท ตรวจ และส่งคำขอ', 'Received. Tap the button to choose a type, review and send.'], noLiff)
    case 'INTAKE_LINK_SAME':
      return withButton(['เพิ่มในคำขอที่กำลังร่างแล้ว แตะปุ่มเพื่อตรวจและส่ง', 'Added to the request you are drafting. Tap to review and send.'], noLiff)
    case 'ADD_IN_LIFF':
      return withButton(['รูปในคำขอนี้ครบจำนวนแล้ว แนบรูปเพิ่มได้ในหน้าคำขอ', 'This request has all the photos the chat takes. Attach more on its page.'], noLiff)
    case 'TEXT_OR_PHOTO_HINT':
      return [text(['ขอซื้อทางแชทได้ด้วยข้อความหรือรูปถ่ายเท่านั้น', '', 'To ask for something here, send a text or a photo.'])]
    case 'LINK_PROMPT': {
      const linkUrl = links.liffId ? liffLink(links.liffId, '/link') : null
      const lines = ['ผูกบัญชี BCS ก่อน จึงจะขอซื้อทางแชทได้', 'Link your BCS account first to ask through the chat.']
      return [linkUrl ? buttons('ผูกบัญชี BCS · Link your BCS account', lines, 'ผูกบัญชี', linkUrl) : text([...lines, 'แตะ "ผูกบัญชี" ที่เมนูด้านล่าง · Tap "Link account" in the menu below.'])]
    }
    case 'RATE_LIMIT_NOTICE':
      return [text(['ส่งข้อความถี่เกินไป ข้อความต่อจากนี้จะยังไม่ถูกรับไว้สักพัก ขอซื้อได้จากเมนู "ขอซื้อ"', '', 'Too many messages: new ones are not taken for a while. Use "Request" in the menu instead.'])]
    case 'NONE':
      return []
  }
}

type Answered = 'REPLIED' | 'PUSHED' | 'NOT_ANSWERED'

async function answer(request: LineMessageRequest, context: LineMessageContext, messages: LineMessage[], pushAllowed: boolean, via: 'REPLY' | 'PUSH'): Promise<Answered> {
  const log = logger.child({ organizationId: request.organizationId, eventId: request.eventId })
  const fresh = request.replyToken !== null && context.clock.now().getTime() - request.receivedAt.getTime() < LINE_REPLY_TOKEN_TTL_MS
  if (via === 'REPLY' && fresh) {
    try {
      await context.channel.api.replyMessage(request.replyToken!, messages)
      return 'REPLIED'
    } catch (error) {
      log.warn({ ...(isLineApiError(error) ? { reason: error.reason, status: error.status } : { reason: 'UNEXPECTED' }) }, 'LINE did not take the reply to a chat message')
    }
  }
  // BR-LINE-15: a push counts against the quota, so only the LIFF button of a draft that never had it
  if (!pushAllowed) return 'NOT_ANSWERED'
  try {
    await context.channel.api.pushMessage(request.lineUserId, messages, { retryKey: request.eventId })
    return 'PUSHED'
  } catch (error) {
    if (isLineApiError(error) && !error.permanent) throw error
    log.warn({ ...(isLineApiError(error) ? { reason: error.reason, status: error.status } : { reason: 'UNEXPECTED' }) }, 'LINE refused the push of the button of a chat draft')
    return 'NOT_ANSWERED'
  }
}

const outcome = (notes: readonly string[]): LineEventOutcome => (notes.length > 0 ? { status: 'PROCESSED', reason: notes.join(',') } : { status: 'PROCESSED' })

export function chatIntakeMessageHandler(deps: ChatIntakeLineDeps): LineMessageHandler {
  return async (request, context) => {
    const settings = await deps.settingsOf(request.organizationId)
    if (!settings.enabled) {
      await deps.discardText(request.organizationId, request.eventId)
      return { status: 'SKIPPED', reason: 'NOT_HANDLED' }
    }
    const now = context.clock.now()
    const replyTokenExpired = request.replyToken === null || now.getTime() - request.receivedAt.getTime() >= LINE_REPLY_TOKEN_TTL_MS
    if (!request.memberId) {
      await deps.discardText(request.organizationId, request.eventId)
      const route = routeChatMessage({
        settings,
        source: 'user',
        mode: 'active',
        sender: 'UNLINKED',
        messageType: request.messageType ?? '',
        textChars: 0,
        now,
        openIntake: null,
        sentLastHour: 0,
        limitNoticeSentThisHour: false,
        replyTokenExpired,
      })
      const messages = chatAnswerMessages(route.reply, { liffId: context.channel.liffId, intakeId: null })
      const answered = messages.length > 0 && route.via ? await answer(request, context, messages, false, route.via) : 'NOT_ANSWERED'
      return outcome(['NOT_LINKED', ...(answered === 'REPLIED' ? [] : [answered])])
    }

    const ctx = makeCtx({ organizationId: request.organizationId, actor: { type: 'USER', memberId: request.memberId }, channel: 'LINE_CHAT', now, requestId: request.eventId })
    const result = await deps.receive(ctx, { lineWebhookEventId: request.eventId }, { idempotencyKey: `line-message:${request.webhookEventId}` })
    if (!result.ok) {
      if (TRANSIENT.has(result.error.code)) throw new Error(`taking a chat message did not finish (${result.error.code}); the line-webhook job tries the event again`)
      return { status: 'PROCESSED', reason: result.error.code }
    }
    const taken = result.data
    const refused = taken.action === 'OPEN_NEW' || taken.action === 'APPEND' ? [] : [taken.action]
    const messages = chatAnswerMessages(taken.reply, { liffId: context.channel.liffId, intakeId: taken.intakeId })
    if (messages.length === 0 || !taken.via) return outcome(refused)
    const answered = await answer(request, context, messages, taken.pushAllowed, taken.via)
    return outcome([...refused, ...(answered === 'REPLIED' ? [] : [answered])])
  }
}
