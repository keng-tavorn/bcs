import { cookies, headers } from 'next/headers'
import { cache } from 'react'
import { resolveSession } from '@/server/auth/session'
import type { SignedInSession } from '@/server/auth/session-rotation'
import type { StoredRole } from '@/server/authz/permissions'
import { withHeldCookies } from '../../../_lib/held-cookies'

// The session a LIFF task page or one of its server actions stands on, beside what liffPage() (src/app/liff/_lib/
// session.ts) hands over — the member and the service context — which leaves out the session's own id and the member's
// roles:
//  - the session's id and sign-in identity, which a decision with the PIN gives a new id to (NFR-SEC-04). An action reads
//    them once, at its start — with liffPage, before any PIN is checked — and the step-up uses those (./step-up.ts): a
//    lookup after the PIN would find nothing when another tab's step-up changed the token meanwhile, and the right PIN
//    would decide nothing;
//  - the member's roles, which say what the reader of a purchase order may see beside it (the supplier's address, the
//    source requests they may open, src/app/(workspace)/procurement/pos/_parts/access.ts).
// The session is the one of the cookies Next.js holds now (src/app/_lib/held-cookies.ts), with the LIFF idle limit, and
// it must still stand for the member liffPage resolved — otherwise nothing (fewer rights, never more). The services check
// every action again (BR-AUTH-05).
// TODO(needs): liffPage could return sessionId, userId and roles, which it reads already; this lookup then goes.

export interface LiffSignedIn extends SignedInSession {
  readonly roles: readonly StoredRole[]
}

/** The request's headers with its cookies as Next.js holds them now */
export async function currentHeaders(): Promise<Headers> {
  const [incoming, jar] = await Promise.all([headers(), cookies()])
  return withHeldCookies(incoming, jar.getAll())
}

/** The session of this request, for `memberId` (the member liffPage resolved); null when it stands for nobody or someone else */
export const liffSignedIn = cache(async (memberId: string): Promise<LiffSignedIn | null> => {
  const state = await resolveSession(await currentHeaders(), { channel: 'LIFF' })
  return state.kind === 'member' && state.member.id === memberId ? { sessionId: state.sessionId, userId: state.userId, roles: state.roles } : null
})
