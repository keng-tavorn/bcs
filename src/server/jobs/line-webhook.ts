import { systemClock, type Clock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import {
  LINE_WEBHOOK_JOB_RETRIES,
  LINE_WEBHOOK_QUEUE_EVENT,
  LineWebhookQueuePayload,
  processQueuedLineWebhookEvents as processQueued,
  receiveLineWebhook as receive,
  settleFailedLineWebhookRun,
  sweepLineWebhookEvents,
  type LineWebhookAnswer,
  type LineWebhookDeps,
  type LineWebhookJobResult,
  type LineWebhookRequest,
  type ReceiveLineWebhookOptions,
} from '@/server/line/webhook'
import { openLineChannel } from '@/server/services/line-channel'

// Jobs `line-webhook` and `line-webhook-sweep` (spec §4.6, BR-LINE-05, FR-LINE-005 AC3) and the webhook's way in.
// Processing a LINE event is one piece of work with two entries: inline in POST /api/webhooks/line/<channelKey> while the
// time budget lasts, and here for the events the request handed over (`bcs/line.webhook_received`). This file joins the
// two layers the work needs: src/server/line (the webhook itself) and the channel opener of
// src/server/services/line-channel — the route may not import src/server/line, and src/server/line may not import
// services (eslint.config.mjs).
//  - line-webhook: one run per hand-over. It waits first when the hand-over says so (an event in it was still running
//    inline when the webhook answered: its request must have ended), then processes the events still QUEUED, in order.
//    Inngest retries a run LINE_WEBHOOK_JOB_RETRIES times; when it gives up, the failure handler starts the next run for
//    what is still waiting, and after the last run gives it up with an alert (src/server/line/webhook/recovery.ts).
//  - line-webhook-sweep: every few minutes, hands the job what a request dropped and gives up what waited a day.
//
// Postback actions (S5-05 `approve`, and later ones) register their handler with registerLinePostbackHandler at the top
// level of the module that owns the action, and that module is imported here for its side effect, so both entries know
// it. A handler that runs a command lives in src/server/services (src/server/line may not import services). Add one
// `import '<handler module>'` line per action below. Follow hooks (registerLineFollowHook) are imported the same way.
import '@/server/services/approvals/line-postback'
import '@/server/services/line-link/follow'

export { LINE_WEBHOOK_BODY_MAX_BYTES } from '@/server/line/webhook'

const deps: LineWebhookDeps = { openChannel: openLineChannel }

/** The webhook route's entry: checks, records and processes one delivery (src/server/line/webhook/receive.ts) */
export function receiveLineWebhook(request: LineWebhookRequest, options: ReceiveLineWebhookOptions = {}): Promise<LineWebhookAnswer> {
  return receive(request, deps, options)
}

/** The job's handler (organizationId, ids, now), called directly by tests */
export function processQueuedLineWebhookEvents(organizationId: string, eventIds: readonly string[], now: Date): Promise<LineWebhookJobResult> {
  return processQueued(organizationId, eventIds, now, deps)
}

/** The two step tools a run uses; Inngest's step satisfies it, and tests drive it with their own */
export interface LineWebhookJobStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>
  sleepUntil(id: string, at: string): Promise<unknown>
}

/**
 * One run of line-webhook. The wait comes from the payload only (never from the clock), so every replay of the run takes
 * the same steps.
 */
export function lineWebhookRun(clock: Clock) {
  return async (event: { data: unknown }, step: LineWebhookJobStep): Promise<LineWebhookJobResult> => {
    const payload = LineWebhookQueuePayload.parse(event.data)
    if (payload.notBefore) await step.sleepUntil('until-request-ended', payload.notBefore)
    return step.run('process', () => processQueuedLineWebhookEvents(payload.organizationId, payload.eventIds, clock.now()))
  }
}

/** Inngest's step as the run's step tools: every result the handlers return is plain JSON already */
function jobStep(step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>; sleepUntil: (id: string, at: string) => Promise<unknown> }): LineWebhookJobStep {
  return {
    run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T>,
    sleepUntil: (id, at) => step.sleepUntil(id, at),
  }
}

export const lineWebhook = inngest.createFunction(
  {
    id: 'line-webhook',
    retries: LINE_WEBHOOK_JOB_RETRIES,
    triggers: [{ event: LINE_WEBHOOK_QUEUE_EVENT }],
    // Inngest gave up this run: the next run for what still waits, or the end with an alert after the last one
    onFailure: async ({ event, step }) => {
      const payload = LineWebhookQueuePayload.safeParse(event.data.event.data)
      if (!payload.success) return { ignored: 'NOT_A_HAND_OVER' }
      return step.run('after-failed-run', () => settleFailedLineWebhookRun(payload.data, systemClock.now()))
    },
  },
  async ({ event, step }) => lineWebhookRun(systemClock)(event, jobStep(step)),
)

/** Every five minutes: what a request dropped reaches the job within LINE_WEBHOOK_REQUEST_ENDED_MS and one period */
export const LINE_WEBHOOK_SWEEP_CRON = '*/5 * * * *'

// One execution per run and no retries, like the outbox-sweeper: the next run is the retry, and the work is idempotent
// (conditional updates; a row moved meanwhile is left alone)
export const lineWebhookSweep = inngest.createFunction({ id: 'line-webhook-sweep', retries: 0, triggers: [{ cron: LINE_WEBHOOK_SWEEP_CRON }] }, async () =>
  sweepLineWebhookEvents(systemClock.now()),
)
