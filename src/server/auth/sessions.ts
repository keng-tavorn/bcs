import { systemClock } from '@/lib/clock'
import { systemDb } from '@/server/db/system'
import { isLiffSessionToken, liffSessionIdentityId, liffSessionLinkIdsOf, sessionPastItsLimits } from './liff'

// The signed-in devices of one identity (FR-AUTH-003 AC3). Signing one out is a member command
// (revokeOwnSession in src/server/services/members) so it is recorded as an event.
// Only sessions that would still be accepted now are listed (FR-AUTH-003 AC1, on the security clock as resolveSession
// runs it): within the absolute 12 hours, and within the idle limit of what they may still open — a password session
// the web's 30 minutes (the workspace takes it as long as that), a LIFF session the LIFF 15 minutes and only while the
// LINE link it was opened with stands (src/server/auth/liff.ts: sessionPastItsLimits, the same rule a LIFF sign-in
// uses to tell an ended session from a live one). An ended session waits in the table until its next request or the
// next clean-up deletes it; it is no signed-in device. Listing writes nothing.

export interface DeviceSessionDto {
  readonly id: string
  readonly createdAt: string
  readonly lastActiveAt: string | null
  readonly userAgent: string | null
  readonly ipAddress: string | null
  readonly current: boolean
}

/**
 * The live sessions of the identity, newest first; `currentSessionId` (the request's own, which resolveSession has just
 * accepted) is always among them. `now` is the security clock; real time unless a test gives its own.
 */
export async function listMySessions(userId: string, currentSessionId: string, now: Date = systemClock.now()): Promise<DeviceSessionDto[]> {
  const rows = (await systemDb.session.findMany({ where: { userId, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } })).filter(
    (s) => s.id === currentSessionId || !sessionPastItsLimits(s, now),
  )
  // A LIFF session stands only while the LINE link its token names stands (asked once, for all of them)
  const links = rows.some((s) => s.id !== currentSessionId && isLiffSessionToken(s.token)) ? await liffSessionLinkIdsOf(userId) : new Set<string>()
  const live = rows.filter((s) => s.id === currentSessionId || !isLiffSessionToken(s.token) || links.has(liffSessionIdentityId(s.token) ?? ''))
  return live.map((s) => ({
    id: s.id,
    createdAt: s.createdAt.toISOString(),
    lastActiveAt: s.lastActiveAt?.toISOString() ?? null,
    userAgent: s.userAgent,
    ipAddress: s.ipAddress,
    current: s.id === currentSessionId,
  }))
}
