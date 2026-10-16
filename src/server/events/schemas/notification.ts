import { z } from 'zod'
import { defineEvents } from '../registry'

// Notifications read by their recipient (FR-NOTI-001 AC1, NEW-16). The aggregate is the recipient's notification box,
// keyed by their member id; one event per action, with how many were marked.

defineEvents('Notification', {
  'notification.read': { schema: z.object({ count: z.number().int().positive(), all: z.boolean() }) },
  // NEW-34 (FR-LINE-006 AC1, S5-07): the daily summary the job daily-digest sent the member, with the counts it reported
  // — counts only, no document, item or person (BR-NOTI-01). scope: ORG for EXECUTIVE, DEPT for a department head.
  'notification.digest_sent': {
    schema: z.object({
      date: z.iso.date(),
      pending: z.number().int().nonnegative(),
      overdue: z.number().int().nonnegative(),
      // S6-18: BUDGET for BUDGET_ADMIN (budget lines only)
      scope: z.enum(['ORG', 'DEPT', 'BUDGET']).nullable(),
      scopePending: z.number().int().nonnegative(),
      scopeOverdue: z.number().int().nonnegative(),
      lowBudgetLines: z.number().int().nonnegative(),
      updates: z.number().int().nonnegative(),
    }),
  },
})
