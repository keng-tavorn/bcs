import { COMMAND_TX_MAX_WAIT_MS, REPORT_TX_TIMEOUT_MS } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'

/** The transaction of a report: it reads only, so it may take longer than a command (REPORT_TX_TIMEOUT_MS) */
export const reportTx = <T,>(ctx: Pick<Ctx, 'organizationId'>, run: (tx: TenantTx) => Promise<T>) =>
  forTenant(ctx.organizationId).$transaction(run, { maxWait: COMMAND_TX_MAX_WAIT_MS, timeout: REPORT_TX_TIMEOUT_MS })
