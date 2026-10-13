import { systemClock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { completeBacktestRun } from '@/server/services/backtest'

// Job `backtest-run` (spec §4.6, FR-DOA-103 AC3, S6-07 · ADR-111): the 90-day backtest of a draft whose window holds
// more documents than a page waits for, computed reading only and written to its BacktestRun once.
export const backtestRun = inngest.createFunction(
  { id: 'backtest-run', triggers: [{ event: 'bcs/backtest.requested' }] },
  async ({ event, step }) => {
    const payload = event.data as { organizationId: string; aggregateId: string }
    return step.run('compute', () => completeBacktestRun(payload.organizationId, payload.aggregateId, systemClock.now()))
  },
)
