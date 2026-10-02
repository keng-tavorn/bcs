import { systemClock } from '@/lib/clock'
import { sweepOutbox } from '@/server/events/outbox'
import { inngest, inngestSender } from '@/server/inngest'

// Job `outbox-sweeper` (spec §4.6, FR-PLT-012 AC3): every minute, re-send outbox rows still unsent after
// 30 seconds — so anything written while Inngest was down goes out within 2 minutes of its return.
export const OUTBOX_SWEEPER_CRON = '* * * * *'

export const outboxSweeper = inngest.createFunction(
  { id: 'outbox-sweeper', triggers: [{ cron: OUTBOX_SWEEPER_CRON }] },
  async ({ step }) => step.run('sweep', () => sweepOutbox(inngestSender, systemClock.now())),
)
