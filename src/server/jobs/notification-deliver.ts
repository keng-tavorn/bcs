import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { deliverNotification } from '@/server/notifications/deliver'

// Job `notification-deliver` (spec §4.6, §4.7 rule 2): every IMMEDIATE notification a command wrote is sent once, by
// LINE or e-mail (FR-NOTI-002 AC1). A provider that could not be reached throws, and Inngest retries.
export const notificationDeliver = inngest.createFunction(
  { id: 'notification-deliver', triggers: [{ event: 'bcs/notification.requested' }] },
  async ({ event, step }) => {
    const payload = event.data as { organizationId: string; notificationId: string }
    return step.run('deliver', () => deliverNotification(payload.organizationId, payload.notificationId, systemClock.now()))
  },
)
