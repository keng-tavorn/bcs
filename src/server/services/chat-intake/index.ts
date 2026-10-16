import { chatIntakeSettingsFor, type ChatIntakeSettings } from '@/lib/s17-settings'
import { forTenant } from '@/server/db/tenant'
import { discardLineInboundText } from '@/server/line/webhook'

// Asking through the LINE chat (S17-06 · FR-LINE-301 · BR-LINE-10 to BR-LINE-15 · ADR-162): the chat side. A linked
// member's text or photo opens or joins a draft (./receive.ts), its photos are fetched from LINE in a job (./images.ts),
// and an hourly sweep expires drafts and clears what was typed (./sweep.ts). ./line-message.ts plugs the chat into the
// webhook. The draft becomes a request only in LIFF (S17-07); nothing is ever sent from the chat.

export { CHAT_IMAGE_GIVE_UP_MS, CHAT_IMAGE_JOB, chatImagePrefix, fetchChatImage, giveUpChatImages, pendingChatImages, storeChatImageCommand, type ChatImageFailure, type ChatImageOutcome } from './images'
export { receiveChatMessage, receiveChatMessageCommand } from './receive'
export { CHAT_SWEEP_JOB, expireChatIntakesCommand, LINE_INBOUND_TEXT_MAX_AGE_MS, purgeChatIntakesCommand, runChatIntakeSweep, type ChatIntakeSweepResult } from './sweep'

/** settings.chatIntake of an organization as the chat reads it: a UAT sandbox never asks through the chat (ADR-174) */
export async function chatIntakeSettingsOfOrganization(organizationId: string): Promise<ChatIntakeSettings> {
  const org = await forTenant(organizationId).organization.findUniqueOrThrow({ where: { id: organizationId }, select: { kind: true, settings: true } })
  return chatIntakeSettingsFor(org)
}

/** Whether the organization asks through the chat now: only then does the webhook keep a message's text (BR-LINE-11) */
export async function asksThroughChat(organizationId: string): Promise<boolean> {
  return (await chatIntakeSettingsOfOrganization(organizationId)).enabled
}

/** Deletes the text the webhook kept for a message nobody will take (off, or a LINE user linked to nobody) */
export const discardChatText = discardLineInboundText
