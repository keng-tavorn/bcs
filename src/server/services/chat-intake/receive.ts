import { z } from 'zod'
import { clipCodePoints, codePoints, routeChatMessage } from '@/core/chat-intake'
import { LINE_REPLY_TOKEN_TTL_MS } from '@/integrations/line'
import { MS_PER_HOUR } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { chatIntakeSettingsFor } from '@/lib/s17-settings'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { EventDraft } from '@/server/events/append'
import type { ChatReceiveResult } from '@/server/line/chat-intake'
import { StoredLineEvent } from '@/server/line/webhook'
import { defineCommand, runCommand, type CommandFailure, type CommandOutcome } from '../_pipeline'

// chat_intake.receive (S17-06 · BR-LINE-10, BR-LINE-11, BR-LINE-15 · FR-LINE-301 AC1 AC2 · golden chat-intake): one text
// or image a linked member sent in a 1:1 chat opens a draft or joins their open one. Sent by that member on channel
// LINE_CHAT (src/server/line/chat-intake.ts builds the ctx from the signed webhook) with LINE's webhookEventId as the key,
// so a redelivered or retried event replays the first answer and never adds the message twice (INV-PLT-01); the item's
// unique LINE message id stops a message that came under another event id. In one transaction:
//  - the event must be a message of a 1:1 chat whose sender is linked to this member now (BR-LINE-01);
//  - the member's row is locked, so their messages are taken one at a time: the open draft, the counts of the last hour
//    and linkSentAt are read and written in order;
//  - the text the webhook kept (LineInboundMessage) is taken out and deleted — it lives nowhere else but the draft;
//  - routeChatMessage decides; a refused message (another type, an image over maxImages, more than hourlyLimit an hour)
//    writes chat_intake.message_refused on the member and keeps nothing;
//  - the answer's LIFF button is recorded (linkSentAt) when the answer carries it: a later message whose reply token
//    expired then gets no push (BR-LINE-15). pushAllowed tells the chat side whether this answer may be pushed when the
//    reply cannot go: only the button of a draft that never had it.
// The time of a message is when LINE says the member sent it (its timestamp; when it was received if LINE's is later or
// missing): the window, lastMessageAt and expiry follow what the member did, not when a retry of the job took it.
// What counts toward hourlyLimit: the messages taken (chat_intake.opened, chat_intake.message_added) and the ones refused
// with an answer for their type or the image limit, in the hour before now; messages refused for sending too often do not
// count, so the chat takes messages again an hour after the ones that filled the limit.

const ReceiveInput = z.strictObject({ lineWebhookEventId: z.uuid() })

const fail = (code: 'FORBIDDEN' | 'NOT_FOUND' | 'MODULE_DISABLED' | 'INVALID_STATE_TRANSITION', message: string): CommandFailure => ({ ok: false, error: { code, message } })
const TAKEN_EVENTS = ['chat_intake.opened', 'chat_intake.message_added'] as const
const REFUSED = 'chat_intake.message_refused'
const LINKS: ReadonlySet<string> = new Set(['INTAKE_LINK', 'INTAKE_LINK_SAME'])

export const receiveChatMessageCommand = defineCommand({
  name: 'chat_intake.receive',
  capability: 'request.create',
  input: ReceiveInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<ChatReceiveResult>> {
    if (ctx.actor.type !== 'USER') return fail('FORBIDDEN', 'a chat message comes from a member')
    const memberId = ctx.actor.memberId
    const allowed = await authorize(tx, ctx, 'request.create', { ownerMemberIds: [memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const row = await tx.lineWebhookEvent.findFirst({ where: { id: input.lineWebhookEventId, type: 'message' }, select: { id: true, payload: true, receivedAt: true } })
    const stored = row ? StoredLineEvent.safeParse(row.payload) : null
    if (!row || !stored?.success || stored.data.source !== 'user' || stored.data.mode !== 'active' || !stored.data.userId) return fail('NOT_FOUND', 'no such chat message')
    const event = stored.data
    const senderId = stored.data.userId
    // BR-LINE-01: the member is the one the signed webhook's LINE user is linked to now
    const provider = await tx.lineChannelConfig.findFirst({ select: { providerId: true } })
    const linked = provider ? await tx.channelIdentity.findFirst({ where: { channel: 'LINE', providerKey: provider.providerId, memberId, externalUserId: senderId, unlinkedAt: null }, select: { id: true } }) : null
    if (!linked) return fail('FORBIDDEN', 'the message was sent by someone else')
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { kind: true, settings: true } })
    const settings = chatIntakeSettingsFor(org)
    if (!settings.enabled) return fail('MODULE_DISABLED', 'the organization does not ask through the chat')

    await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [memberId])
    const inbound = await tx.lineInboundMessage.findFirst({ where: { lineWebhookEventId: row.id }, select: { id: true, text: true } })
    if (inbound) await tx.lineInboundMessage.delete({ where: { id: inbound.id } })
    const messageType = event.messageType ?? ''
    const kind: 'TEXT' | 'IMAGE' | null = messageType === 'text' ? 'TEXT' : messageType === 'image' ? 'IMAGE' : null
    const lineMessageId = event.messageId ?? null
    if (kind && !lineMessageId) return fail('NOT_FOUND', 'the message has no id to keep it by')
    if (lineMessageId && (await tx.chatIntakeItem.findFirst({ where: { lineMessageId }, select: { id: true } }))) return fail('INVALID_STATE_TRANSITION', 'the message was taken already')

    const now = ctx.now
    const sentAt = event.occurredAt ? new Date(event.occurredAt) : null
    const messageAt = sentAt && sentAt <= row.receivedAt ? sentAt : row.receivedAt
    const hourAgo = new Date(now.getTime() - MS_PER_HOUR)
    const [taken, refused, noticed, open] = await Promise.all([
      tx.event.count({ where: { type: { in: [...TAKEN_EVENTS] }, actorMemberId: memberId, occurredAt: { gt: hourAgo } } }),
      tx.event.count({ where: { type: REFUSED, aggregateId: memberId, occurredAt: { gt: hourAgo }, NOT: { data: { path: ['reason'], equals: 'RATE_LIMITED' } } } }),
      tx.event.count({ where: { type: REFUSED, aggregateId: memberId, occurredAt: { gt: hourAgo }, AND: [{ data: { path: ['reason'], equals: 'RATE_LIMITED' } }, { data: { path: ['notified'], equals: true } }] } }),
      tx.chatIntake.findFirst({
        where: { memberId, status: 'OPEN' },
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        select: { id: true, text: true, textTruncated: true, imageCount: true, lastMessageAt: true, linkSentAt: true, version: true },
      }),
    ])
    const typed = kind === 'TEXT' ? (inbound?.text ?? '') : ''
    const route = routeChatMessage({
      settings,
      source: 'user',
      mode: 'active',
      sender: 'LINKED_ACTIVE',
      messageType,
      textChars: codePoints(typed),
      now: messageAt,
      // The text so far and the line break the next piece needs: what the next piece has left is maxTextChars minus both
      openIntake: open ? { lastMessageAt: open.lastMessageAt, images: open.imageCount, textChars: open.text ? codePoints(open.text) + 1 : 0, linkSent: open.linkSentAt !== null } : null,
      sentLastHour: taken + refused,
      limitNoticeSentThisHour: noticed > 0,
      replyTokenExpired: event.replyToken === null || now.getTime() - row.receivedAt.getTime() >= LINE_REPLY_TOKEN_TTL_MS,
    })

    const refuse = (reason: 'UNSUPPORTED' | 'LIMIT_IMAGES' | 'RATE_LIMITED', intakeId: string | null): CommandOutcome<ChatReceiveResult> => ({
      ok: true,
      result: { action: route.action, reply: route.reply, via: route.via, intakeId, pushAllowed: false },
      events: [{ type: REFUSED, aggregateType: 'Member', aggregateId: memberId, data: { reason, notified: route.reply !== 'NONE' } }],
    })
    switch (route.action) {
      case 'RATE_LIMITED':
      case 'UNSUPPORTED':
        return refuse(route.action, null)
      case 'LIMIT_IMAGES':
        return refuse('LIMIT_IMAGES', open?.id ?? null)
      case 'IGNORE':
      case 'LINK_PROMPT':
        // Not for a linked member of an organization that asks through the chat; kept for the exhaustive switch
        return fail('NOT_FOUND', 'the chat does not take this message')
      case 'OPEN_NEW':
      case 'APPEND':
        break
    }
    if (!kind || !lineMessageId) return fail('NOT_FOUND', 'the chat does not take this message')

    // The kept piece: all of it, or a start of whole characters within what is left (BR-LINE-10)
    const piece = kind === 'TEXT' ? (route.textTruncated ? clipCodePoints(typed, route.keptChars ?? 0) : typed) : ''
    const carriesLink = LINKS.has(route.reply)
    const expiresAt = (at: Date) => new Date(at.getTime() + settings.expireHours * MS_PER_HOUR)
    const item = { kind, lineMessageId, fetchStatus: kind === 'IMAGE' ? ('PENDING' as const) : ('NOT_NEEDED' as const), receivedAt: row.receivedAt }
    const events: EventDraft[] = []
    let intakeId: string
    let pushAllowed: boolean
    if (route.action === 'OPEN_NEW' || !open) {
      intakeId = newId()
      await tx.chatIntake.create({
        data: {
          id: intakeId,
          organizationId: ctx.organizationId,
          memberId,
          status: 'OPEN',
          text: piece.length > 0 ? piece : null,
          textTruncated: route.textTruncated ?? false,
          messageCount: 1,
          imageCount: kind === 'IMAGE' ? 1 : 0,
          openedAt: messageAt,
          lastMessageAt: messageAt,
          expiresAt: expiresAt(messageAt),
          linkSentAt: carriesLink ? now : null,
        },
      })
      await tx.chatIntakeItem.create({ data: { organizationId: ctx.organizationId, intakeId, seq: 1, ...item } })
      events.push({ type: 'chat_intake.opened', aggregateType: 'ChatIntake', aggregateId: intakeId, data: { kind } })
      pushAllowed = carriesLink
    } else {
      intakeId = open.id
      const last = await tx.chatIntakeItem.findFirst({ where: { intakeId }, orderBy: { seq: 'desc' }, select: { seq: true } })
      const seq = (last?.seq ?? 0) + 1
      const lastMessageAt = open.lastMessageAt > messageAt ? open.lastMessageAt : messageAt
      await tx.chatIntake.update({
        where: { id: intakeId },
        data: {
          ...(piece.length > 0 ? { text: open.text ? `${open.text}\n${piece}` : piece } : {}),
          textTruncated: open.textTruncated || (route.textTruncated ?? false),
          messageCount: { increment: 1 },
          ...(kind === 'IMAGE' ? { imageCount: { increment: 1 } } : {}),
          lastMessageAt,
          expiresAt: expiresAt(lastMessageAt),
          ...(carriesLink ? { linkSentAt: now } : {}),
          version: { increment: 1 },
        },
      })
      await tx.chatIntakeItem.create({ data: { organizationId: ctx.organizationId, intakeId, seq, ...item } })
      events.push({ type: 'chat_intake.message_added', aggregateType: 'ChatIntake', aggregateId: intakeId, data: { seq, kind } })
      pushAllowed = carriesLink && open.linkSentAt === null
    }
    return { ok: true, result: { action: route.action, reply: route.reply, via: route.via, intakeId, pushAllowed }, events }
  },
})

export function receiveChatMessage(ctx: Ctx, input: { readonly lineWebhookEventId: string }, options: { readonly idempotencyKey: string }) {
  return runCommand(ctx, receiveChatMessageCommand, input, options)
}
