import { z } from 'zod'
import { defineEvents } from '../registry'

// The 90-day backtest of a draft run by the job backtest-run (S6-07 · FR-DOA-103 AC3 · ADR-111): asked with more
// documents than a page waits for, then done or failed. Read only: the run writes its own result and no business data.

const run = { subjectType: z.enum(['DOA_VERSION', 'WORKFLOW_VERSION']), subjectId: z.uuid(), documentCount: z.number().int().nonnegative() }

defineEvents('BacktestRun', {
  'backtest.requested': { schema: z.object(run) },
  'backtest.completed': { schema: z.object({ ...run, status: z.enum(['DONE', 'FAILED']), changed: z.number().int().nonnegative().nullable() }) },
})
