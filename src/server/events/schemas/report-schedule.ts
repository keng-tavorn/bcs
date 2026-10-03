import { z } from 'zod'
import { defineEvents } from '../registry'

// Report schedules (FR-VIS-002 AC1, NEW-24): a report emailed to members on a cron

defineEvents('ReportSchedule', {
  'report_schedule.created': {
    schema: z.object({ reportCode: z.string().min(1), cron: z.string().min(1), recipientCount: z.number().int().min(1), format: z.enum(['xlsx', 'csv']) }),
  },
})
