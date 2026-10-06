import { z } from 'zod'
import { systemClock, type Clock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { deliverNotification, LINE_DELIVERY_MAX_TRIES, type DeliveryOptions, type DeliveryOutcome } from '@/server/notifications/deliver'
import { openLineChannel } from '@/server/services/line-channel'

// Job `notification-deliver` (spec §4.6, §4.7 rule 2): every IMMEDIATE notification a command wrote is sent once, by
// LINE or e-mail (FR-NOTI-002 AC1). The first try runs at once. When LINE could not answer for now, the try says when
// to try again (a backoff that stops at LINE_DELIVERY_GIVE_UP_MS after the first try), and the run sleeps until then and
// tries again with the time of the first try; past it the try sends the e-mail, so an approval task LINE cannot
// deliver reaches its recipient by e-mail within LINE_FALLBACK_WITHIN_MS (FR-LINE-007 AC3). Every try reads the
// notification and, for a notice about an approval task, the task again: once the task no longer waits (decided,
// cancelled, moved, or waiting for the requester's answer) the try sends nothing and answers SKIPPED TASK_CLOSED, and the
// run ends there (FR-NOTI-003 AC3). The waits come from the tries' own answers (memoized steps), so every replay of a run
// takes the same steps. An e-mail provider that could not be reached throws inside its step, and Inngest retries that
// step.

export const NotificationRequested = z.object({ organizationId: z.uuid(), notificationId: z.uuid() })

/** The step tools a run uses; Inngest's step satisfies it, and tests drive it with a fake clock */
export interface DeliveryStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>
  sleepUntil(id: string, at: string): Promise<unknown>
}

export interface NotificationDeliverDeps {
  readonly openChannel: NonNullable<DeliveryOptions['openChannel']>
}

const defaultDeps: NotificationDeliverDeps = { openChannel: openLineChannel }

/** One run: the first try, then a try after each RETRY answer at the time it gave (at most LINE_DELIVERY_MAX_TRIES) */
export function notificationDeliverRun(clock: Clock, deps: NotificationDeliverDeps = defaultDeps) {
  return async (event: { data: unknown }, step: DeliveryStep): Promise<DeliveryOutcome> => {
    const { organizationId, notificationId } = NotificationRequested.parse(event.data)
    let outcome = await step.run('deliver', () => deliverNotification(organizationId, notificationId, clock.now(), { openChannel: deps.openChannel }))
    for (let attempt = 2; outcome.status === 'RETRY' && attempt <= LINE_DELIVERY_MAX_TRIES; attempt++) {
      const previous = outcome
      await step.sleepUntil(`wait-${attempt}`, previous.retryAt)
      outcome = await step.run(`deliver-${attempt}`, () =>
        deliverNotification(organizationId, notificationId, clock.now(), {
          openChannel: deps.openChannel,
          firstLineTryAt: new Date(previous.firstTryAt),
          lineTry: attempt,
          lastLineFailure: previous.reason,
        }),
      )
    }
    return outcome
  }
}

export const notificationDeliver = inngest.createFunction({ id: 'notification-deliver', triggers: [{ event: 'bcs/notification.requested' }] }, async ({ event, step }) =>
  notificationDeliverRun(systemClock)(event, {
    run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T>,
    sleepUntil: (id, at) => step.sleepUntil(id, at),
  }),
)
