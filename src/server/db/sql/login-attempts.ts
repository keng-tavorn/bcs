import type { PrismaClient } from '../generated/client'

// Raw SQL lives only here (spec §4.8).

type RawClient = Pick<PrismaClient, '$executeRaw'>

/**
 * Serializes the sign-in attempts of one account inside the current transaction (NFR-SEC-05): the next attempt
 * waits until this one's failure count and reservation are committed, so parallel guesses are all counted. The
 * wait is bounded (SQLSTATE 55P03 after `lockTimeoutMs`), so a stuck attempt cannot hold the account's sign-in.
 * set_config(..., true) equals SET LOCAL: it ends with the transaction, safe behind a transaction-mode pooler.
 */
export async function lockLoginAccount(tx: RawClient, email: string, lockTimeoutMs: number): Promise<void> {
  const timeout = `${Math.max(1, Math.trunc(lockTimeoutMs))}ms`
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${timeout}, true)`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'bcs.login:' + email}, 0))`
}
