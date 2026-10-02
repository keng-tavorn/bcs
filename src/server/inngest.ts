import { Inngest } from 'inngest'
import { setDefaultOutboxSender, type OutboxSender } from '@/server/events/outbox'

// One Inngest client for sending (outbox relay) and for job functions (src/server/jobs). Inngest v4 reads
// INNGEST_DEV (local dev server), INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY from the environment.
// Inngest is only a timer and queue: business state stays in our database (ADR-006).
export const inngest = new Inngest({ id: 'bcs' })

export const inngestSender: OutboxSender = async (messages) => {
  await inngest.send(messages.map((m) => ({ id: m.id, name: m.name, data: m.data as Record<string, unknown> })))
}

setDefaultOutboxSender(inngestSender)
