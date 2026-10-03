import { COMMAND_LOCK_TIMEOUT_MS, COMMAND_STATEMENT_TIMEOUT_MS } from '@/lib/constants'
import type { TenantTx } from '../tenant'

// Raw SQL lives only here (spec §4.8).

/**
 * Bounds every wait of the current transaction: a lock wait (FOR UPDATE, the idempotency advisory lock) fails
 * with SQLSTATE 55P03 after `lockTimeoutMs`, any statement with 57014 after `statementTimeoutMs`. Prisma's own
 * transaction timeout only closes the transaction on the client; it does not interrupt a waiting statement.
 * set_config(..., true) equals SET LOCAL: it ends with the transaction, so it is safe behind a
 * transaction-mode connection pooler.
 */
export async function setTransactionTimeouts(
  tx: TenantTx,
  lockTimeoutMs: number = COMMAND_LOCK_TIMEOUT_MS,
  statementTimeoutMs: number = COMMAND_STATEMENT_TIMEOUT_MS,
): Promise<void> {
  const lock = `${Math.max(1, Math.trunc(lockTimeoutMs))}ms`
  const statement = `${Math.max(1, Math.trunc(statementTimeoutMs))}ms`
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${lock}, true), set_config('statement_timeout', ${statement}, true)`
}
