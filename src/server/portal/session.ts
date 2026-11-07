import { timingSafeEqual } from 'node:crypto'
import { MS_PER_MINUTE, MS_PER_SECOND } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { supplierSettingsOf } from '@/lib/org-settings'
import { PORTAL_SESSION_TOUCH_MS } from '@/lib/portal-limits'
import { makeCtx, type Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { sha256Hex } from './crypto'
import { portalPath, type PortalOrg } from './org'

// The portal's own session (BR-PORTAL ข้อ 03 · ADR-007 · ADR-183): cookie bcs_portal under /portal/<org>, a random id
// whose sha256 is PortalSession.sessionHash; never Better Auth, and Better Auth's cookies are never read here. The
// session keeps the contact only: the actor (supplierId, applicationId) is rebuilt from SupplierContact on every
// request, because a contact moves from the application to the supplier when it is approved. A session idle past
// supplier.sessionIdleMinutes or past expiresAt is no session (portal-session-sweep marks it later).

export const PORTAL_SESSION_COOKIE = 'bcs_portal'
/** The CSRF token the pages put in a hidden field or the x-bcs-portal-csrf header (NFR-SEC-06); its hash is on the session */
export const PORTAL_CSRF_COOKIE = 'bcs_portal_csrf'
export const PORTAL_CSRF_HEADER = 'x-bcs-portal-csrf'
/** Between the link and the code: `<challengeId>.<link token>`, so the code is tried only where the link was used */
export const PORTAL_PENDING_COOKIE = 'bcs_portal_otp'

export interface CookieOptions {
  readonly httpOnly: boolean
  readonly secure: boolean
  readonly sameSite: 'lax'
  readonly path: string
  readonly maxAge?: number
}

/** The options of every portal cookie: only under the organization's path, Secure on https */
export function portalCookieOptions(org: PortalOrg, options: { readonly httpOnly?: boolean; readonly maxAgeMs?: number } = {}): CookieOptions {
  return {
    httpOnly: options.httpOnly ?? true,
    secure: getEnv().APP_URL.startsWith('https://'),
    sameSite: 'lax',
    path: portalPath(org),
    ...(options.maxAgeMs !== undefined ? { maxAge: Math.floor(options.maxAgeMs / MS_PER_SECOND) } : {}),
  }
}

export interface PortalContact {
  readonly id: string
  readonly nameTh: string
  readonly email: string
  readonly locale: string
  readonly supplierId: string | null
  readonly applicationId: string | null
  readonly privacyNoticeVersion: string | null
}

export interface PortalSessionState {
  readonly sessionId: string
  readonly csrfTokenHash: string
  readonly contact: PortalContact
  readonly ctx: Ctx
}

const CLOSED_APPLICATION = new Set(['REJECTED', 'EXPIRED', 'CANCELLED'])

/**
 * Whether a contact may use the portal at all: ACTIVE and allowed, of a supplier that is not INACTIVE, or of an
 * application that is not closed (BR-PORTAL ข้อ 03).
 */
export function contactMayEnter(contact: {
  readonly status: string
  readonly portalEnabled: boolean
  readonly supplier: { readonly status: string } | null
  readonly application: { readonly status: string } | null
}): boolean {
  if (contact.status !== 'ACTIVE' || !contact.portalEnabled) return false
  if (contact.supplier) return contact.supplier.status !== 'INACTIVE'
  return contact.application !== null && !CLOSED_APPLICATION.has(contact.application.status)
}

export const CONTACT_SELECT = {
  id: true,
  nameTh: true,
  email: true,
  locale: true,
  status: true,
  portalEnabled: true,
  supplierId: true,
  applicationId: true,
  privacyNoticeVersion: true,
  supplier: { select: { status: true } },
  application: { select: { status: true } },
} as const

/** The context of a portal request: the contact as the actor, channel PORTAL (BR-PORTAL ข้อ 03 · ข้อ 06) */
export function portalCtx(organizationId: string, contact: Pick<PortalContact, 'id' | 'supplierId' | 'applicationId'>, now: Date, requestId?: string): Ctx {
  return makeCtx({
    organizationId,
    actor: {
      type: 'SUPPLIER',
      supplierContactId: contact.id,
      ...(contact.supplierId ? { supplierId: contact.supplierId } : {}),
      ...(!contact.supplierId && contact.applicationId ? { applicationId: contact.applicationId } : {}),
    },
    channel: 'PORTAL',
    now,
    ...(requestId ? { requestId } : {}),
  })
}

/**
 * The session the cookie names in this organization, or null: unknown, revoked, past its end, idle too long, or its
 * contact may no longer enter. A live one has lastSeenAt moved forward at most once a minute.
 */
export async function readPortalSession(org: PortalOrg, sessionId: string | undefined, now: Date): Promise<PortalSessionState | null> {
  if (!sessionId) return null
  const db = forTenant(org.organizationId)
  const session = await db.portalSession.findUnique({
    where: { organizationId_sessionHash: { organizationId: org.organizationId, sessionHash: sha256Hex(sessionId) } },
    select: { id: true, csrfTokenHash: true, lastSeenAt: true, expiresAt: true, revokedAt: true, contact: { select: CONTACT_SELECT } },
  })
  if (!session || session.revokedAt || session.expiresAt.getTime() <= now.getTime()) return null
  const settings = await db.organization.findUniqueOrThrow({ where: { id: org.organizationId }, select: { settings: true } })
  if (now.getTime() - session.lastSeenAt.getTime() >= supplierSettingsOf(settings.settings).sessionIdleMinutes * MS_PER_MINUTE) return null
  if (!contactMayEnter(session.contact)) return null
  if (now.getTime() - session.lastSeenAt.getTime() >= PORTAL_SESSION_TOUCH_MS) {
    await db.portalSession.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastSeenAt: now } })
  }
  const { contact } = session
  return {
    sessionId: session.id,
    csrfTokenHash: session.csrfTokenHash,
    contact: { id: contact.id, nameTh: contact.nameTh, email: contact.email, locale: contact.locale, supplierId: contact.supplierId, applicationId: contact.applicationId, privacyNoticeVersion: contact.privacyNoticeVersion },
    ctx: portalCtx(org.organizationId, contact, now),
  }
}

const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/**
 * CSRF of a POST (BR-PORTAL ข้อ 03 · NFR-SEC-06): the header Origin is APP_URL's origin and, with a session, the token
 * sent hashes to the session's csrfTokenHash. Before a session exists (asking for a link, using it, the code) only
 * the Origin is checked: there is no session to bind a token to yet.
 */
export function csrfOk(input: { readonly origin: string | null; readonly token?: string | null; readonly csrfTokenHash?: string }): boolean {
  if (!input.origin || input.origin !== new URL(getEnv().APP_URL).origin) return false
  if (input.csrfTokenHash === undefined) return true
  return Boolean(input.token) && sameHex(sha256Hex(input.token!), input.csrfTokenHash)
}
