import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { getEnv } from '@/lib/env'
import { pollingCron } from '@/lib/job-cadence'
import { inngest } from '@/server/inngest'
import { sendSupplierNotice, SUPPLIER_NOTICE_EVENT, sweepSupplierNotices } from '@/server/notifications/supplier-notices'
// The e-mails of S9 register their templates when loaded (ADR-135)
import '@/server/notifications/supplier-templates-pay'

// Job supplier-notice-send (ADR-126, BR-AP-08): an e-mail to a supplier is sent after the command that wrote it commits —
// at once from the outbox event, and by a sweep for notices nothing sent yet (the decision of an approval writes its
// notice without an outbox draft). sendSupplierNotice claims a notice before it sends, so the event and the sweep never
// send one twice; an e-mail provider that cannot be reached throws, and Inngest retries the step.

export const SupplierNoticeRequested = z.object({ organizationId: z.uuid(), noticeId: z.uuid() })

/** Every five minutes at the spec cadence; every 30 minutes on staging (ADR-054) */
export const SUPPLIER_NOTICE_SWEEP_CRON = '*/5 * * * *'

export const supplierNoticeSend = inngest.createFunction({ id: 'supplier-notice-send', triggers: [{ event: SUPPLIER_NOTICE_EVENT }] }, async ({ event, step }) => {
  const { organizationId, noticeId } = SupplierNoticeRequested.parse(event.data)
  return step.run('send', () => sendSupplierNotice(organizationId, noticeId, systemClock.now()))
})

export const supplierNoticeSweep = inngest.createFunction({ id: 'supplier-notice-sweep', retries: 0, triggers: [{ cron: pollingCron(SUPPLIER_NOTICE_SWEEP_CRON, getEnv().APP_ENV) }] }, async ({ step }) =>
  step.run('sweep', () => sweepSupplierNotices(systemClock.now())),
)
