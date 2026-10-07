import { systemClock } from '@/lib/clock'
import { getEnv } from '@/lib/env'
import { outboxStallAlertAfterMs, pollingCron } from '@/lib/job-cadence'
import { sweepOutbox } from '@/server/events/outbox'
import { inngest, inngestSender } from '@/server/inngest'

// Job `outbox-sweeper` (spec §4.6, FR-PLT-012 AC3): every minute, send outbox rows still unsent after 30 seconds
// and retries that are due — so anything written while Inngest was down goes out within 2 minutes of its return.
// A run isolates bad messages by bisection, dead-letters a message Inngest keeps refusing, and raises an alert
// when nothing could be delivered for OUTBOX_STALL_ALERT_AFTER_MS (NFR-OBS-02; see sweepOutbox).
// One Inngest execution per run: the work is idempotent (FOR UPDATE SKIP LOCKED claims, Outbox.id as the event
// id), so it needs no step.run, and no Inngest retries (each would be another execution): the next minute's run
// is the retry. The route's maxDuration covers one run (src/app/api/inngest/route.ts).
// On staging it runs every 30 minutes and its stall alert waits that much longer (ADR-054, src/lib/job-cadence.ts).
export const OUTBOX_SWEEPER_CRON = '* * * * *'

export const outboxSweeper = inngest.createFunction(
  { id: 'outbox-sweeper', retries: 0, triggers: [{ cron: pollingCron(OUTBOX_SWEEPER_CRON, getEnv().APP_ENV) }] },
  async () => sweepOutbox(inngestSender, systemClock.now(), { stallAlertAfterMs: outboxStallAlertAfterMs(getEnv().APP_ENV) }),
)
