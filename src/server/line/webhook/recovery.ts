import { logger } from '@/lib/logger'
import { listLineChannelOrganizationIds } from '@/server/db/lookups'
import { describeError } from '@/server/errors/describe'
import { getDefaultOutboxSender, type OutboxSender } from '@/server/events/outbox'
import { LINE_WEBHOOK_JOB_ROUNDS, LINE_WEBHOOK_ROUND_DELAY_MS } from './constants'
import { tellLineWebhookJob, type LineWebhookQueuePayload } from './queue'
import { giveUpLineWebhookEvents, recoverStaleLineWebhookEvents, requeueLineWebhookEvents } from './store'

// No LINE event is lost in silence (BR-LINE-05, FR-LINE-005 AC3): what the webhook recorded is finished by the request,
// by a run of the line-webhook job, or given up with an alert. Two things make sure of it besides the request itself:
//  - a run of the job that Inngest gave up (its retries used up) hands its events to another run, a few times, then gives
//    them up (the job's failure handler: settleFailedLineWebhookRun);
//  - the line-webhook sweep (every few minutes) hands the job what a request dropped — still RECEIVED after the request
//    surely ended: cut by the platform, a failed hand-over, a stopped server — and gives up what waited a whole day.

export interface LineWebhookRunSettlement {
  /** The run that was to come next */
  readonly round: number
  /** Events handed to that run */
  readonly requeued: number
  /** Events given up (FAILED, GAVE_UP) because that was the last run */
  readonly gaveUp: number
}

/**
 * After Inngest gave up a run of the line-webhook job: the events of the run still QUEUED get the next run,
 * LINE_WEBHOOK_ROUND_DELAY_MS × its number later, until LINE_WEBHOOK_JOB_ROUNDS runs were tried; then they are given up —
 * FAILED with error GAVE_UP and an alert — rather than left waiting.
 */
export async function settleFailedLineWebhookRun(payload: LineWebhookQueuePayload, now: Date, options: { readonly sender?: OutboxSender | null } = {}): Promise<LineWebhookRunSettlement> {
  const sender = options.sender === undefined ? getDefaultOutboxSender() : options.sender
  const log = logger.child({ organizationId: payload.organizationId, job: 'line-webhook' })
  const next = (payload.round ?? 0) + 1
  if (next < LINE_WEBHOOK_JOB_ROUNDS) {
    const again = await requeueLineWebhookEvents(payload.organizationId, payload.eventIds, { round: next, notBefore: new Date(now.getTime() + LINE_WEBHOOK_ROUND_DELAY_MS * next) })
    if (again.queued.length > 0) log.warn({ round: next, events: again.queued.length }, 'a run of the line-webhook job failed; its events get another run later')
    await tellLineWebhookJob(again.outboxIds, sender, log)
    return { round: next, requeued: again.queued.length, gaveUp: 0 }
  }
  const gaveUp = await giveUpLineWebhookEvents(payload.organizationId, payload.eventIds, now)
  if (gaveUp.length > 0) log.error({ alert: true, events: gaveUp.length, runs: LINE_WEBHOOK_JOB_ROUNDS }, 'LINE webhook events were given up: every run of the line-webhook job failed')
  return { round: next, requeued: 0, gaveUp: gaveUp.length }
}

export interface LineWebhookSweepResult {
  readonly organizations: number
  /** Events their request dropped, handed to the job */
  readonly recovered: number
  /** Events still waiting a day after they arrived, given up */
  readonly gaveUp: number
  /** Organizations the sweep could not look at this time (the next run tries again) */
  readonly failed: number
}

/**
 * The line-webhook sweep: in every organization with a LINE channel — or the ones given, for tests — hands the job what a
 * request dropped and gives up what waited a day (store.ts recoverStaleLineWebhookEvents). One organization failing does
 * not stop the others.
 */
export async function sweepLineWebhookEvents(
  now: Date,
  options: { readonly organizationIds?: readonly string[]; readonly sender?: OutboxSender | null } = {},
): Promise<LineWebhookSweepResult> {
  const sender = options.sender === undefined ? getDefaultOutboxSender() : options.sender
  const organizationIds = options.organizationIds ?? (await listLineChannelOrganizationIds())
  let recovered = 0
  let gaveUp = 0
  let failed = 0
  for (const organizationId of organizationIds) {
    const log = logger.child({ organizationId, job: 'line-webhook-sweep' })
    try {
      const swept = await recoverStaleLineWebhookEvents(organizationId, now)
      recovered += swept.handedOver.length
      gaveUp += swept.gaveUp.length
      if (swept.handedOver.length > 0) log.warn({ events: swept.handedOver.length }, 'LINE webhook events their request dropped were handed to the line-webhook job')
      if (swept.gaveUp.length > 0) log.error({ alert: true, events: swept.gaveUp.length }, 'LINE webhook events were given up: no run of the line-webhook job finished them within a day')
      await tellLineWebhookJob(swept.outboxIds, sender, log)
    } catch (error) {
      failed++
      log.error({ error: describeError(error) }, 'the line-webhook sweep could not look at this organization; its next run tries again')
    }
  }
  return { organizations: organizationIds.length, recovered, gaveUp, failed }
}
