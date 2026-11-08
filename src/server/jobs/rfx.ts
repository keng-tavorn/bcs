import { z } from 'zod'
import { systemClock, type Clock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { closeRfxAt, linkInvitesOfApplication, remindRfxAt, rfxReminderAt } from '@/server/services/sourcing/rfx'
import { timerStep, type TimerStep } from './approval-task-sla'

// The jobs of S10-04 (docs/sub-specs/S10.md "job Inngest ใหม่"): rfx-close sleeps until the RFx's closesAt and closes it,
// rfx-reminder writes once one business day before, and rfx-invite-link moves the invites of an approved application to
// its supplier. A later close (rfx.extended or rfx.amended) starts a new run with the new time and cancels the old one;
// every command reads the latest state first, so a run that slips past its cancel does nothing.

const RfxTimeEvent = z.object({ eventId: z.uuid().optional(), organizationId: z.uuid(), aggregateId: z.uuid(), data: z.object({ closesAt: z.string() }).loose() })
const SAME_RFX = 'async.data.aggregateId == event.data.aggregateId'
const TRIGGERS = [{ event: 'bcs/rfx.opened' }, { event: 'bcs/rfx.extended' }, { event: 'bcs/rfx.amended' }] as const
const CANCEL_ON = [
  { event: 'bcs/rfx.extended', if: SAME_RFX },
  { event: 'bcs/rfx.amended', if: SAME_RFX },
  { event: 'bcs/rfx.cancelled', if: SAME_RFX },
  { event: 'bcs/rfx.closed', if: SAME_RFX },
]

export function rfxCloseHandler(clock: Clock) {
  return async (event: { data: unknown }, step: TimerStep) => {
    const payload = RfxTimeEvent.safeParse(event.data)
    if (!payload.success) return { closed: false, reason: 'IGNORED' }
    const { organizationId, aggregateId, data } = payload.data
    await step.sleepUntil('until-close', data.closesAt)
    return step.run('close', () => closeRfxAt(organizationId, aggregateId, data.closesAt, clock.now()))
  }
}

export const rfxClose = inngest.createFunction({ id: 'rfx-close', triggers: [...TRIGGERS], cancelOn: CANCEL_ON }, async ({ event, step }) => rfxCloseHandler(systemClock)(event, timerStep(step)))

export function rfxReminderHandler(clock: Clock) {
  return async (event: { data: unknown }, step: TimerStep) => {
    const payload = RfxTimeEvent.safeParse(event.data)
    if (!payload.success) return { reminded: 0 }
    const { eventId, organizationId, aggregateId, data } = payload.data
    const at = await step.run('plan', () => rfxReminderAt(organizationId, data.closesAt))
    await step.sleepUntil('until-reminder', at)
    return { reminded: await step.run('remind', () => remindRfxAt(organizationId, aggregateId, data.closesAt, clock.now(), eventId ?? data.closesAt)) }
  }
}

export const rfxReminder = inngest.createFunction({ id: 'rfx-reminder', triggers: [...TRIGGERS], cancelOn: CANCEL_ON }, async ({ event, step }) => rfxReminderHandler(systemClock)(event, timerStep(step)))

const ApprovedEvent = z.object({ organizationId: z.uuid(), aggregateId: z.uuid(), data: z.object({ supplierId: z.uuid() }).loose() })

export const rfxInviteLink = inngest.createFunction({ id: 'rfx-invite-link', triggers: [{ event: 'bcs/supplier_application.approved' }] }, async ({ event, step }) => {
  const payload = ApprovedEvent.safeParse(event.data)
  if (!payload.success) return 'IGNORED'
  return step.run('link', () => linkInvitesOfApplication(payload.data.organizationId, payload.data.aggregateId, payload.data.data.supplierId, systemClock.now()))
})
