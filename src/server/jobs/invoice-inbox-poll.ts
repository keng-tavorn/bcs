import { systemClock } from '@/lib/clock'
import { getEnv } from '@/lib/env'
import { pollingCron } from '@/lib/job-cadence'
import { inngest } from '@/server/inngest'
import { pollAllInvoiceInboxes } from '@/server/services/ap/inbox'

// Job invoice-inbox-poll (ADR-123, FR-AP-101 AC2): every 5 minutes, the inbox of every organization with PAY on and an
// inbox address is read as SYSTEM (src/server/services/ap/inbox.ts); the same Message-ID is never kept twice, so a run
// that overlaps another or is retried makes nothing twice. Tests call pollAllInvoiceInboxes directly.

/** Every five minutes at the spec cadence; every 30 minutes on staging (ADR-054) */
export const INVOICE_INBOX_POLL_CRON = '*/5 * * * *'

export const invoiceInboxPoll = inngest.createFunction({ id: 'invoice-inbox-poll', retries: 0, triggers: [{ cron: pollingCron(INVOICE_INBOX_POLL_CRON, getEnv().APP_ENV) }] }, async ({ step }) =>
  step.run('poll', () => pollAllInvoiceInboxes(systemClock.now())),
)
