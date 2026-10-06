import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { runDueReportSchedules } from '@/server/services/reports'
import { activeOrganizationIds } from '@/server/services/requests/stale-drafts'

// Job `report-schedules` (FR-VIS-002 AC1): every five minutes, every schedule whose cron has a slot due runs once for
// that slot and its file is emailed to its recipients.
export const REPORT_SCHEDULES_CRON = 'TZ=Asia/Bangkok */5 * * * *'

export const reportSchedules = inngest.createFunction({ id: 'report-schedules', triggers: [{ cron: REPORT_SCHEDULES_CRON }] }, async ({ step }) => {
  const organizations = await step.run('organizations', () => activeOrganizationIds())
  let sent = 0
  for (const organizationId of organizations) sent += await step.run(`schedules-${organizationId}`, () => runDueReportSchedules(organizationId, systemClock.now()))
  return { organizations: organizations.length, sent }
})
