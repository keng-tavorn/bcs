import { z } from 'zod'
import { systemClock, type Clock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { applicationOfTrigger, applicationSlaStep, planApplicationSla } from '@/server/services/suppliers/application-sla'
import { timerStep, whenDue, type TimerStep } from './approval-task-sla'

// Job `supplier-application-sla` (S7-07 · BR-SUP ข้อ 12 · ADR-187 · spec §4.6): every activity of an application waiting
// for its supplier — invited (again), the first sign-in (drafted), a change, a return, an upload of its document, a
// sign-in of its contact — starts a run that reads the application as it stands, then sleeps until each of remindAt,
// escalateAt and expiresAt still to come and acts (services/suppliers/application-sla.ts). A newer activity, a submit,
// a cancel or an expiry of the same application cancels a run started by an event of the application itself; a run
// started by an upload or a sign-in ends at its first wake instead (the step answers STALE or CLOSED).

/** Answers of a step that end the run: the application moved on, is closed, or a newer run owns it */
const ENDS_RUN: ReadonlySet<string> = new Set(['CLOSED', 'STALE', 'NOT_FOUND', 'NO_CONTACT'])

export interface ApplicationSlaRun {
  readonly applicationId: string | null
  readonly done: readonly string[]
  /** Why the run ended before the expiry, when it did */
  readonly stopped: string | null
}

const Payload = z.object({ organizationId: z.uuid(), aggregateId: z.uuid(), data: z.record(z.string(), z.unknown()).optional() })

export function supplierApplicationSlaHandler(clock: Clock) {
  return async (event: { name: string; data: unknown }, step: TimerStep): Promise<ApplicationSlaRun> => {
    const payload = Payload.safeParse(event.data)
    if (!payload.success) return { applicationId: null, done: [], stopped: 'IGNORED' }
    const { organizationId } = payload.data
    const plan = await step.run('plan', async () => planApplicationSla(organizationId, await applicationOfTrigger(organizationId, event.name, payload.data)))
    if (!plan.applicationId || !plan.lastActivityAt || plan.timers.length === 0) return { applicationId: plan.applicationId, done: [], stopped: plan.status }
    const done: string[] = []
    for (const timer of plan.timers) {
      const r = await whenDue(step, timer.step, timer.at, () => applicationSlaStep(organizationId, plan.applicationId!, timer.step, plan.lastActivityAt!, clock.now()))
      if (r.done) done.push(timer.step)
      else if (r.reason && ENDS_RUN.has(r.reason)) return { applicationId: plan.applicationId, done, stopped: r.reason }
    }
    return { applicationId: plan.applicationId, done, stopped: null }
  }
}

const SAME_APPLICATION = 'async.data.aggregateId == event.data.aggregateId'

export const supplierApplicationSla = inngest.createFunction(
  {
    id: 'supplier-application-sla',
    triggers: [
      { event: 'bcs/supplier_application.invited' },
      { event: 'bcs/supplier_application.drafted' },
      { event: 'bcs/supplier_application.updated' },
      { event: 'bcs/supplier_application.returned' },
      { event: 'bcs/supplier_document.uploaded' },
      { event: 'bcs/portal_session.signed_in' },
    ],
    cancelOn: [
      { event: 'bcs/supplier_application.submitted', if: SAME_APPLICATION },
      { event: 'bcs/supplier_application.cancelled', if: SAME_APPLICATION },
      { event: 'bcs/supplier_application.expired', if: SAME_APPLICATION },
      { event: 'bcs/supplier_application.updated', if: SAME_APPLICATION },
    ],
  },
  async ({ event, step }) => supplierApplicationSlaHandler(systemClock)(event, timerStep(step)),
)
