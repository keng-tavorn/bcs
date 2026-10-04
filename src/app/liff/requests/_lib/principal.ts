import { cookies, headers } from 'next/headers'
import { cache } from 'react'
import { resolveSession } from '@/server/auth/session'
import { memberPrincipal, type Principal } from '@/server/authz'
import { withHeldCookies } from '../../../_lib/held-cookies'

// The read checks of the LIFF request pages are the workspace's (src/app/(workspace)/_tracking/access.ts): a page asks
// request.view before it reads a request, with the member and the roles of the session — the requester and followers
// (OWN), everyone who had a task on it (ASSIGNED), and the organization-wide roles. liffPage() (src/app/liff/_lib/
// session.ts) hands the member but not the roles, so this reads the same session once more for them, after liffPage
// already refused a stale LIFF session; a session that now stands for another member gives no roles (fewer rights, never
// more). The services check every action again (BR-AUTH-05).
// TODO(needs): liffPage could return the roles it already read; this then becomes `memberPrincipal(page.member.id, page.roles)`.

export const liffPrincipalOf = cache(async (memberId: string): Promise<Principal> => {
  const [incoming, jar] = await Promise.all([headers(), cookies()])
  const state = await resolveSession(withHeldCookies(incoming, jar.getAll()), { channel: 'LIFF' })
  return memberPrincipal(memberId, state.kind === 'member' && state.member.id === memberId ? state.roles : [])
})

/** The language of the screen's data (request type names, members' names): the page's language, Thai unless English */
export const screenOf = (locale: string): 'th' | 'en' => (locale === 'en' ? 'en' : 'th')
