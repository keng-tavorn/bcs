import { COMMAND_LOCK_TIMEOUT_MS, LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS } from '@/lib/constants'
import { lockLoginAccount } from '@/server/db/sql/login-attempts'
import { systemDb } from '@/server/db/system'

// Sign-in lockout (FR-AUTH-001 AC3, NFR-SEC-05): 5 failed attempts (a wrong password or a wrong second-step code)
// within 15 minutes for the same account or from the same IP lock further attempts until the oldest of those
// failures leaves the window. Only failures count, so a presenter signing in as several demo users from one phone
// is not locked out.
// The check and the count are one step per account: before the password or code is checked, the attempt is
// reserved as a failure in the same transaction that counts the account's failures, under a lock on the account.
// Parallel guesses for one account therefore see each other, and at most 5 are ever checked. The reservation is
// settled when the check is done: a success when the password or code was right. The per-IP count reads settled
// attempts only, so people signing in at the same moment behind one office address never lock each other out
// while their checks are running; an attempt that never settles (the server stopped) stays a failure of its account.

export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function clientIp(headers: Headers | undefined | null): string {
  const forwarded = headers?.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || headers?.get('x-real-ip')?.trim() || 'unknown'
}

export type LockReason = 'ACCOUNT' | 'IP'
export type LoginVerdict = { allowed: true; attemptId: string } | { allowed: false; reason: LockReason; retryAt: Date }

/**
 * When the failures of one scope drop below the limit again: the window after the LOGIN_FAILURE_LIMIT-th most
 * recent failure. null while the scope is under the limit.
 */
function lockedUntil(recentFailures: ReadonlyArray<{ createdAt: Date }>): Date | null {
  const oldestCounted = recentFailures.length >= LOGIN_FAILURE_LIMIT ? recentFailures[LOGIN_FAILURE_LIMIT - 1] : undefined
  return oldestCounted ? new Date(oldestCounted.createdAt.getTime() + LOGIN_FAILURE_WINDOW_MS) : null
}

/** Checks both limits and, when the attempt may go ahead, reserves it as a failure of the account (see above). */
export async function beginLoginAttempt(email: string, ip: string, now: Date): Promise<LoginVerdict> {
  const since = new Date(now.getTime() - LOGIN_FAILURE_WINDOW_MS)
  const recent = { success: false, createdAt: { gte: since } }
  const newestFirst = { orderBy: { createdAt: 'desc' as const }, take: LOGIN_FAILURE_LIMIT, select: { createdAt: true } }
  return systemDb.$transaction(async (tx) => {
    if (email) await lockLoginAccount(tx, email, COMMAND_LOCK_TIMEOUT_MS)
    const byAccount = email ? await tx.authAttempt.findMany({ where: { email, ...recent }, ...newestFirst }) : []
    const accountUntil = lockedUntil(byAccount)
    if (accountUntil) return { allowed: false, reason: 'ACCOUNT', retryAt: accountUntil }
    const byIp = ip !== 'unknown' ? await tx.authAttempt.findMany({ where: { ip, pending: false, ...recent }, ...newestFirst }) : []
    const ipUntil = lockedUntil(byIp)
    if (ipUntil) return { allowed: false, reason: 'IP', retryAt: ipUntil }
    const reserved = await tx.authAttempt.create({ data: { email, ip, success: false, pending: true, createdAt: now }, select: { id: true } })
    return { allowed: true, attemptId: reserved.id }
  })
}

/** Settles a reserved attempt once its password or code was checked. */
export async function settleLoginAttempt(attemptId: string, success: boolean): Promise<void> {
  await systemDb.authAttempt.update({ where: { id: attemptId }, data: { pending: false, success } })
}

/** IP kept in audit events: enough to correlate attempts without storing the full address (PDPA). */
export function ipPrefix(ip: string): string {
  if (ip.includes('.')) return ip.split('.').slice(0, 3).join('.') + '.x'
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::x'
  return ip
}
