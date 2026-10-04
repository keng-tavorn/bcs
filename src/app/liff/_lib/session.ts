import { cookies, headers } from 'next/headers'
import { cache } from 'react'
import { systemClock } from '@/lib/clock'
import { auth } from '@/server/auth/auth'
import { isLiffSessionToken } from '@/server/auth/liff'
import { ctxFromSession, resolveSession, type SessionMember } from '@/server/auth/session'
import type { Ctx } from '@/server/context'
import { withHeldCookies } from '../../_lib/held-cookies'

// The session of a LIFF page (§9.4, ADR-046): a LIFF session (opened with the LINE ID token, accepted on LIFF pages only)
// or a web session (a password sign-in, in the LINE app or a browser), both with the LIFF idle limit of 15 minutes
// (FR-AUTH-003 AC1). A LIFF session acts only as the member of the LINE link it was opened with, and only while that very
// link stands: resolveSession checks it on every request and ends the session otherwise (src/server/auth/liff.ts), so a
// session of an old phone never comes back to life when the member links a new one. One lookup per request, shared by
// the layout and the page. Pages build their service context from it (channel LIFF) and render data only for kind
// "member"; anything else renders <LiffGate> and nothing of the page.
// `session` says which of the two it is: the bootstrap renews only a LIFF session with a new ID token (a password sign-in
// is never swapped for the session of the LINE account's owner), and ending the link of another LINE account from LIFF
// needs the password sign-in (src/server/services/liff).
// The cookies are read as Next.js holds them now (src/app/_lib/held-cookies.ts, as the workspace's getSession does): a
// server action that gave the browser a new session id — a PIN step-up of a password session, NFR-SEC-04 — renders its
// page again in the same request, and read from the request's Cookie header that page would find the session the action
// ended, show the gate, and the gate would sign in with LINE over the password session.

export type LiffSessionKind = 'liff' | 'web'

export type LiffPage =
  | { readonly kind: 'signed-out' }
  /** The role needs TOTP set up first (FR-AUTH-002 AC1): done on the web */
  | { readonly kind: 'needs-2fa-setup'; readonly session: LiffSessionKind }
  | { readonly kind: 'no-membership'; readonly session: LiffSessionKind }
  | { readonly kind: 'member'; readonly ctx: Ctx; readonly member: SessionMember; readonly session: LiffSessionKind }

/**
 * Whether the request's session cookie holds a session opened with a LIFF ID token (src/server/auth/liff.ts gives those
 * tokens their own prefix). Read only after resolveSession accepted the session, whose signature Better Auth checked;
 * only the prefix is looked at, and nothing of the cookie is kept or logged.
 */
async function sessionKindOf(requestHeaders: Headers): Promise<LiffSessionKind> {
  const name = (await auth.$context).authCookies.sessionToken.name
  for (const part of (requestHeaders.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key !== name) continue
    let token: string
    try {
      token = decodeURIComponent(value.join('='))
    } catch {
      return 'web'
    }
    return isLiffSessionToken(token) ? 'liff' : 'web'
  }
  return 'web'
}

export const liffPage = cache(async (): Promise<LiffPage> => {
  const [incoming, jar] = await Promise.all([headers(), cookies()])
  const requestHeaders = withHeldCookies(incoming, jar.getAll())
  const state = await resolveSession(requestHeaders, { channel: 'LIFF' })
  if (state.kind === 'anonymous' || state.kind === 'expired') return { kind: 'signed-out' }
  const session = await sessionKindOf(requestHeaders)
  if (state.kind === 'no-membership' || state.kind === 'needs-2fa-setup') return { kind: state.kind, session }
  const ctx = ctxFromSession(state, 'LIFF', systemClock.now())
  return ctx ? { kind: 'member', ctx, member: state.member, session } : { kind: 'signed-out' }
})

/** The member's name in the page's language (the English name when there is one) */
export function memberName(member: Pick<SessionMember, 'displayNameTh' | 'displayNameEn'>, locale: string): string {
  return locale === 'en' && member.displayNameEn ? member.displayNameEn : member.displayNameTh
}
