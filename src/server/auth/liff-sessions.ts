import { systemDb } from '@/server/db/system'
import { isLiffSessionToken, LIFF_SESSION_TOKEN_PREFIX } from './liff'

// A LIFF session stands for the LINE link it was opened with (liff.ts: a LINE login only, no password). resolveSession
// checks on every request that the member still has *a* live LINE link, not that it is the one the session was opened
// with: a member who moves their link to a new phone would leave the old phone signed in as them, and so would unlinking
// on the web and linking another LINE account later. Until the session itself records its link (a Session column, or
// the link's id in the token: the S5-03 owner's change), two rules close that, for the LIFF pages — the only place a
// LIFF session opens anything:
//  - endMemberLiffSessions: when a LIFF page ends or makes a link of the member (src/server/services/liff), every LIFF
//    session of the member's sign-in identity ends at once. Nothing is lost by the LINE app that is still linked: the
//    gate of its next page signs in again with a fresh ID token, without a question. A password (web) session is kept.
//  - liffSessionStandsForMember: a LIFF page (src/app/liff/_lib/session.ts) accepts a LIFF session for a member only
//    while none of the member's LINE links ended after the session was opened; otherwise the session may stand on the
//    link that ended, and it is ended. This also covers links ended elsewhere (the web settings, then a QR code from the
//    new phone), which the first rule never sees. Both times come from the server's own clock: when the session was
//    opened (Better Auth) and when the link ended (the unlink command's ctx.now, real time), never from the browser.
// Session rows are Better Auth's identity table, shared by every organization (forTenant refuses it), so these live in
// the auth layer, as resolveSession's own clean-up does. Nothing here logs a token.

/**
 * Ends every LIFF session (token prefix LIFF_SESSION_TOKEN_PREFIX) of the sign-in identity of the member `memberId` of
 * `organizationId`, after a LINE link of theirs ended or was made. Returns how many ended. Password sessions stay.
 */
export async function endMemberLiffSessions(organizationId: string, memberId: string): Promise<number> {
  const member = await systemDb.member.findFirst({ where: { id: memberId, organizationId }, select: { userId: true } })
  if (!member?.userId) return 0
  const { count } = await systemDb.session.deleteMany({ where: { userId: member.userId, token: { startsWith: LIFF_SESSION_TOKEN_PREFIX } } })
  return count
}

/**
 * Whether the session `sessionId` may act as the member on a LIFF page. A password session may (nothing here concerns
 * it); a LIFF session only while none of the member's LINE links ended at or after the moment it was opened. A LIFF
 * session that fails this is ended here (its row deleted), so it opens nothing anywhere afterwards.
 */
export async function liffSessionStandsForMember(sessionId: string, member: { readonly id: string; readonly organizationId: string }): Promise<boolean> {
  const session = await systemDb.session.findUnique({ where: { id: sessionId }, select: { token: true, createdAt: true } })
  // Ended in the meantime (signed out, replaced by a renewal): nothing stands
  if (!session) return false
  if (!isLiffSessionToken(session.token)) return true
  const endedSince = await systemDb.channelIdentity.findFirst({
    where: { organizationId: member.organizationId, memberId: member.id, channel: 'LINE', unlinkedAt: { gte: session.createdAt } },
    select: { id: true },
  })
  if (!endedSince) return true
  await systemDb.session.deleteMany({ where: { id: sessionId, token: { startsWith: LIFF_SESSION_TOKEN_PREFIX } } })
  return false
}
