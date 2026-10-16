import { COMMAND_LOCK_TIMEOUT_MS, COMMAND_TX_MAX_WAIT_MS, REPORT_STATEMENT_TIMEOUT_MS, REPORT_TX_TIMEOUT_MS } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { setTransactionTimeouts } from '@/server/db/sql/timeouts'
import { forTenant, type TenantTx } from '@/server/db/tenant'

/**
 * The transaction of a report or a dashboard over a period: it reads only, so it may take longer than a command
 * (REPORT_TX_TIMEOUT_MS), Postgres stops a stuck statement first (REPORT_STATEMENT_TIMEOUT_MS) so no report holds its
 * pooled connection longer, and every query of it reads one snapshot (Repeatable Read: a decision made while the report
 * runs is in all of its figures or in none)
 */
export const reportTx = <T,>(ctx: Pick<Ctx, 'organizationId'>, run: (tx: TenantTx) => Promise<T>) =>
  forTenant(ctx.organizationId).$transaction(
    async (tx) => {
      await setTransactionTimeouts(tx, COMMAND_LOCK_TIMEOUT_MS, REPORT_STATEMENT_TIMEOUT_MS)
      return run(tx)
    },
    { isolationLevel: 'RepeatableRead', maxWait: COMMAND_TX_MAX_WAIT_MS, timeout: REPORT_TX_TIMEOUT_MS },
  )
