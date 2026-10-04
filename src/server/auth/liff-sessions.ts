import { systemDb } from '@/server/db/system'
import { isLiffSessionToken, liffSessionMemberIds } from './liff'

// A LIFF session stands for the LINE link it was opened with (liff.ts: a LINE login only, no password): its token names
// that ChannelIdentity, and resolveSession accepts it only as that link's member while that very link stands, so a member
// who moves their link to a new phone — from LIFF, or from the web settings and a QR code of the new phone — never
// leaves the old phone signed in, and the unlink command ends the member's LIFF sessions in its own transaction
// (src/server/db/sql/identity.ts). The post-commit clean-ups that stood in for that binding before are gone; what is
// left here is the LIFF page's own question (src/app/liff/_lib/session.ts), answered by the same rule as resolveSession:
// it is no longer needed for safety — resolveSession refuses such a session first — and is kept while that page asks it.
// Session rows are Better Auth's identity table, shared by every organization (forTenant refuses it), so this lives in
// the auth layer, as resolveSession's own clean-up does. Nothing here logs a token.

/**
 * Whether the session `sessionId` may act as the member on a LIFF page. A password session may (nothing here concerns
 * it); a LIFF session only while the LINE link its token names stands and is that member's (liffSessionMemberIds). A LIFF
 * session that fails this is ended here (its row deleted, by its id and this very token), so it opens nothing anywhere
 * afterwards. `member.organizationId` is not needed any more (the link names its member) and is kept for the callers.
 */
export async function liffSessionStandsForMember(sessionId: string, member: { readonly id: string; readonly organizationId: string }): Promise<boolean> {
  const session = await systemDb.session.findUnique({ where: { id: sessionId }, select: { token: true, userId: true } })
  // Ended in the meantime (signed out, replaced by a renewal): nothing stands
  if (!session) return false
  if (!isLiffSessionToken(session.token)) return true
  if ((await liffSessionMemberIds(session.userId, session.token)).has(member.id)) return true
  await systemDb.session.deleteMany({ where: { id: sessionId, token: session.token } })
  return false
}
