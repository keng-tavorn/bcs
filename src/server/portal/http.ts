import { systemClock } from '@/lib/clock'
import { getEnv } from '@/lib/env'
import { newId } from '@/lib/ids'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import type { PortalRequestMeta } from './commands'
import { resolvePortalOrg, type PortalOrg } from './org'
import { csrfOk, PORTAL_CSRF_HEADER, PORTAL_SESSION_COOKIE, readPortalSession, type PortalSessionState } from './session'

// What every route handler of /portal/[org]/api/* needs from its request (BR-PORTAL ข้อ 01 ข้อ 03): the organization of
// the path, the portal's own cookies (never Better Auth's), who asks (IP and user agent, hashed by the commands) and the
// business clock. A request whose organization does not exist or has no SUPPLIER is answered as not found.

export function cookiesOf(request: Request): Map<string, string> {
  const jar = new Map<string, string>()
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0) jar.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()))
  }
  return jar
}

const clientIp = (headers: Headers) => headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip')?.trim() || 'unknown'

export interface PortalRequest {
  readonly org: PortalOrg
  readonly meta: PortalRequestMeta
  readonly cookies: Map<string, string>
}

export async function portalRequest(request: Request, orgCode: string): Promise<PortalRequest | null> {
  const org = await resolvePortalOrg(orgCode)
  if (!org) return null
  return {
    org,
    meta: { ip: clientIp(request.headers), userAgent: request.headers.get('user-agent') ?? '', now: systemClock.now(), requestId: newId() },
    cookies: cookiesOf(request),
  }
}

/** Origin of the request is the app's own (every POST · NFR-SEC-06) */
export const sameOrigin = (request: Request): boolean => csrfOk({ origin: request.headers.get('origin') })

/**
 * The session of a POST that needs one, with its CSRF token checked (header x-bcs-portal-csrf or form field csrf):
 * 'NONE' without a live session of this organization (answered 404, BR-PORTAL ข้อ 03), 'CSRF' with a bad or missing
 * token or origin (answered FORBIDDEN reason CSRF, with the event portal_session.csrf_rejected).
 */
export async function postSession(request: Request, req: PortalRequest, formToken: string | null, route: string): Promise<PortalSessionState | 'NONE' | 'CSRF'> {
  const state = await readPortalSession(req.org, req.cookies.get(PORTAL_SESSION_COOKIE), req.meta.now)
  if (!state) return 'NONE'
  const token = request.headers.get(PORTAL_CSRF_HEADER) ?? formToken
  if (csrfOk({ origin: request.headers.get('origin'), token, csrfTokenHash: state.csrfTokenHash })) return state
  await forTenant(req.org.organizationId).$transaction((tx) =>
    appendEvents(tx, state.ctx, [
      { type: 'portal_session.csrf_rejected', aggregateType: 'SupplierContact', aggregateId: state.contact.id, data: { contactId: state.contact.id, sessionId: state.sessionId, route } },
    ]),
  )
  return 'CSRF'
}

/** An absolute URL of the app for a redirect */
export const appUrl = (path: string): URL => new URL(path, getEnv().APP_URL)
