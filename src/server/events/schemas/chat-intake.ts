import { z } from 'zod'
import { defineEvents } from '../registry'

// Asking through the LINE chat (S17-06 · BR-LINE-10 to BR-LINE-15 · §10.2). The aggregate is the ChatIntake draft. The
// data is codes and numbers only: never the text the member typed, a file name or the LINE user id (BR-LINE-11,
// NFR-SEC-09); the event's actor is the member who wrote (channel LINE_CHAT) or the system job.
const kind = z.enum(['TEXT', 'IMAGE'])
defineEvents('ChatIntake', {
  // A message opened a new draft (the first one, or one after windowMinutes)
  'chat_intake.opened': { schema: z.strictObject({ kind }) },
  // A message within windowMinutes was added to the open draft
  'chat_intake.message_added': { schema: z.strictObject({ seq: z.number().int().positive(), kind }) },
  // Job chat-intake-image fetched an image of the draft from LINE, or could not (fileId when stored)
  'chat_intake.image_fetched': { schema: z.strictObject({ seq: z.number().int().positive(), status: z.enum(['STORED', 'FAILED']), fileId: z.uuid().optional() }) },
  // S17-07: the owner picked a type in LIFF; the request draft was made by request.create_draft's logic (BR-LINE-12)
  'chat_intake.drafted': {
    schema: z.strictObject({ requestId: z.uuid(), requestTypeCode: z.string().min(1), images: z.number().int().nonnegative(), aiAssisted: z.boolean() }),
  },
  // S17-07: "ไม่ใช่คำขอ" - the owner closed the draft in LIFF
  'chat_intake.dismissed': { schema: z.strictObject({}) },
  // S17-08: job chat-intake-ai linked the Intake Agent's reading of the draft as it stands (BR-LINE-13)
  'chat_intake.ai_requested': { schema: z.strictObject({ agentActionId: z.uuid() }) },
  // Nobody used the draft for expireHours (job chat-intake-sweep)
  'chat_intake.expired': { schema: z.strictObject({ reason: z.literal('IDLE') }) },
  // The typed text of a closed draft was cleared after textRetentionDays (BR-LINE-11, OQ-162), and its photos no document took
  'chat_intake.purged': { schema: z.strictObject({ textRemoved: z.boolean(), filesRemoved: z.number().int().nonnegative(), fileIds: z.array(z.uuid()) }) },
})
defineEvents('Member', {
  // A message the chat took but did not add (a sticker, an 11th image, more than hourlyLimit an hour): its text is not
  // kept; `notified` says the member was answered (the notice of sending too often goes once an hour)
  'chat_intake.message_refused': { schema: z.strictObject({ reason: z.enum(['UNSUPPORTED', 'LIMIT_IMAGES', 'RATE_LIMITED']), notified: z.boolean() }) },
})
