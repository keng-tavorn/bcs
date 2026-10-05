import { z } from 'zod'
import { systemClock, type Clock } from '@/lib/clock'
import { logger } from '@/lib/logger'
import { describeError } from '@/server/errors/describe'
import { dispatchOutbox, type OutboxSender } from '@/server/events/outbox'
import { LINE_WEBHOOK_JOB_MAX_EVENTS } from './constants'

// The hand-over to the line-webhook job: what an outbox row of `bcs/line.webhook_received` carries, and telling Inngest.

/** The payload of `bcs/line.webhook_received` (written by store.ts, read by the job in src/server/jobs/line-webhook.ts) */
export const LineWebhookQueuePayload = z.object({
  organizationId: z.uuid(),
  /** LineWebhookEvent ids in the order LINE sent the events; the job processes the ones still QUEUED in this order */
  eventIds: z.array(z.uuid()).min(1).max(LINE_WEBHOOK_JOB_MAX_EVENTS),
  /**
   * The job waits until then before it starts: one of the events was still running inline when the webhook answered, so
   * the job leaves it alone until that request has surely ended (LINE_WEBHOOK_REQUEST_ENDED_MS after the arrival)
   */
  notBefore: z.iso.datetime({ offset: true }).optional(),
  /** Which run of the job this is: absent for the first; the failure handler starts the next ones (LINE_WEBHOOK_JOB_ROUNDS) */
  round: z.number().int().nonnegative().optional(),
})
export type LineWebhookQueuePayload = z.infer<typeof LineWebhookQueuePayload>

type Log = Pick<typeof logger, 'warn'>

/** Sends the job its outbox rows now; what is not confirmed in time the outbox-sweeper sends. Never rejects. */
export async function tellLineWebhookJob(outboxIds: readonly string[], sender: OutboxSender | null, log: Log = logger): Promise<void> {
  if (outboxIds.length === 0) return
  try {
    await dispatchOutbox(outboxIds, sender, systemClock.now(), { log })
  } catch (error) {
    log.warn({ error: describeError(error) }, 'LINE webhook: handing events to the line-webhook job is left to the outbox-sweeper')
  }
}

/**
 * The clock of one delivery or one job run. Real time; or, when a test gives the instant to start from, that instant
 * moved on by the real time elapsed since — so a handler that reads the time again (is the reply token still fresh?)
 * sees the time it really is, not the time the run started.
 */
export function webhookClock(start: Date | undefined): Clock {
  if (!start) return systemClock
  const at = start.getTime()
  const startedAt = performance.now()
  return { now: () => new Date(at + Math.round(performance.now() - startedAt)) }
}
