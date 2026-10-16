import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { fetchChatImage, pendingChatImages, type ChatImageOutcome } from '@/server/services/chat-intake'

// Job `chat-intake-image` (S17-06 · BR-LINE-14 · FR-LINE-301 AC3): a photo sent in the chat is fetched from LINE here,
// never in the webhook. A run takes the images of one draft still PENDING, one step each, so an image fetched stays
// fetched when a later one throws; LINE's 5xx and the network throw and Inngest tries the run again. One run at a time
// per draft. What still waits when the retries are over is given up by the hourly chat-intake-sweep (TIMEOUT).
export const CHAT_INTAKE_IMAGE_EVENTS = ['chat_intake.opened', 'chat_intake.message_added'] as const
export const CHAT_INTAKE_IMAGE_RETRIES = 4

const Payload = z.object({ organizationId: z.uuid(), aggregateId: z.uuid() })

export interface ChatIntakeImageStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>
}

/** One run, called directly by tests with their own step */
export async function chatIntakeImageRun(event: { data: unknown }, step: ChatIntakeImageStep): Promise<{ readonly images: readonly ChatImageOutcome[] } | { readonly ignored: 'NOT_A_DRAFT_EVENT' }> {
  const payload = Payload.safeParse(event.data)
  if (!payload.success) return { ignored: 'NOT_A_DRAFT_EVENT' }
  const { organizationId, aggregateId } = payload.data
  const items = await step.run('pending', () => pendingChatImages(organizationId, aggregateId))
  const images: ChatImageOutcome[] = []
  for (const itemId of items) images.push(await step.run(`image-${itemId}`, () => fetchChatImage(organizationId, itemId, systemClock.now())))
  return { images }
}

export const chatIntakeImage = inngest.createFunction(
  {
    id: 'chat-intake-image',
    retries: CHAT_INTAKE_IMAGE_RETRIES,
    concurrency: { limit: 1, key: 'event.data.aggregateId' },
    // Only a message that is an image (event data: { kind })
    triggers: CHAT_INTAKE_IMAGE_EVENTS.map((e) => ({ event: `bcs/${e}` as const, if: "event.data.data.kind == 'IMAGE'" })),
  },
  async ({ event, step }) => chatIntakeImageRun(event, { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> }),
)
