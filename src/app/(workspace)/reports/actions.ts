'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { scheduleReport } from '@/server/services/reports/screens'
import { toInsightFailure, type ScheduleOutcome } from '@/ui/insight/outcome'
import { getSession } from '../../_lib/session'

// Browser-facing adapter of the report schedule form (FR-VIS-002 AC1). It checks the session; scheduleReport and
// createReportSchedule check report.schedule, the report, the cadence and the recipients and record the event
// (BR-AUTH-05). The idempotencyKey comes from the form (spec §4.3), so the same submission twice makes one schedule.

const NO_SESSION: ScheduleOutcome = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: ScheduleOutcome = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }

export async function createScheduleAction(input: { reportCode: string; cadence: string; format: string; recipientMemberIds: string[] }, idempotencyKey: string): Promise<ScheduleOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return NO_SESSION
  if (!z.uuid().safeParse(idempotencyKey).success) return BAD_KEY
  const result = await scheduleReport(ctx, input, { idempotencyKey })
  if (!result.ok) return toInsightFailure(result.error)
  revalidatePath('/reports')
  return { ok: true }
}
