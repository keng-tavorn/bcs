import { systemClock } from '@/lib/clock'
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_LIFF_MS, SESSION_IDLE_WEB_MS, SESSION_TOUCH_AFTER_MS } from '@/lib/constants'
import { makeCtx, type Ctx } from '@/server/context'
import { systemDb } from '@/server/db/system'
import { STORED_ROLES, type StoredRole } from '@/server/authz/permissions'
import { auth } from './auth'

// Resolves the signed-in member from the request (spec §4.3 step 3). Session limits run on real time — the
// "security clock" — so e2e time travel of business time never signs anybody out (FR-AUTH-003 AC1):
// web idle 30 min / absolute 12 h, LIFF idle 15 min. Expired sessions are deleted, not just ignored.

export const ORG_COOKIE = 'bcs-org'

export interface SessionMember {
  readonly id: string
  readonly organizationId: string
  readonly organizationName: string
  readonly displayNameTh: string
  readonly displayNameEn: string | null
  readonly email: string
}

export type SessionState =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'no-membership'; readonly userId: string }
  | {
      readonly kind: 'needs-2fa-setup' | 'member'
      readonly userId: string
      readonly sessionId: string
      readonly member: SessionMember
      readonly roles: readonly StoredRole[]
    }

export type SessionChannel = 'WEB' | 'LIFF' | 'PWA'

function readCookie(headers: Headers, name: string): string | undefined {
  const raw = headers.get('cookie') ?? ''
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

/** FR-AUTH-002 AC1: anyone with a role besides REQUESTER (or, from S2, a DOA-referenced position) needs TOTP. */
export function requiresTwoFactor(roles: readonly StoredRole[], holdsDoaPosition: boolean): boolean {
  return roles.length > 0 || holdsDoaPosition
}

type ValidatedSession =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'valid'; readonly userId: string; readonly sessionId: string; readonly twoFactorEnabled: boolean }

/** Session limits on real time (FR-AUTH-003 AC1): expired sessions are deleted; activity is recorded at most every few minutes. */
async function validateSession(headers: Headers, opts: { channel?: SessionChannel; now?: Date }): Promise<ValidatedSession> {
  const result = await auth.api.getSession({ headers })
  if (!result) return { kind: 'anonymous' }
  const { session, user } = result
  const now = (opts.now ?? systemClock.now()).getTime()
  const createdAt = new Date(session.createdAt).getTime()
  const lastActive = session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : createdAt
  const idleLimit = opts.channel === 'LIFF' ? SESSION_IDLE_LIFF_MS : SESSION_IDLE_WEB_MS
  if (now - createdAt >= SESSION_ABSOLUTE_MS || now - lastActive >= idleLimit) {
    await systemDb.session.deleteMany({ where: { id: session.id } })
    return { kind: 'expired' }
  }
  if (now - lastActive >= SESSION_TOUCH_AFTER_MS) {
    await systemDb.session.update({ where: { id: session.id }, data: { lastActiveAt: new Date(now) } })
  }
  return { kind: 'valid', userId: user.id, sessionId: session.id, twoFactorEnabled: Boolean(user.twoFactorEnabled) }
}

export async function resolveSession(headers: Headers, opts: { channel?: SessionChannel; now?: Date } = {}): Promise<SessionState> {
  const validated = await validateSession(headers, opts)
  if (validated.kind !== 'valid') return validated
  const { userId, sessionId } = validated
  const members = await systemDb.member.findMany({
    where: { userId, status: 'ACTIVE', organization: { status: 'ACTIVE' } },
    include: { organization: { select: { legalNameTh: true, displayName: true } } },
    orderBy: { createdAt: 'asc' },
  })
  if (members.length === 0) return { kind: 'no-membership', userId }
  const preferred = readCookie(headers, ORG_COOKIE)
  const member = members.find((m) => m.organizationId === preferred) ?? members[0]!
  const roles = (
    await systemDb.roleAssignment.findMany({ where: { memberId: member.id, organizationId: member.organizationId, revokedAt: null }, select: { role: true } })
  )
    .map((r) => r.role)
    .filter((r): r is StoredRole => (STORED_ROLES as readonly string[]).includes(r))
  // TODO(S2-15): include holders of DOA-referenced positions (FR-AUTH-002 AC1) once positions are loaded.
  const needsSetup = requiresTwoFactor(roles, false) && !validated.twoFactorEnabled
  return {
    kind: needsSetup ? 'needs-2fa-setup' : 'member',
    userId,
    sessionId,
    member: {
      id: member.id,
      organizationId: member.organizationId,
      organizationName: member.organization.displayName ?? member.organization.legalNameTh,
      displayNameTh: member.displayNameTh,
      displayNameEn: member.displayNameEn,
      email: member.email,
    },
    roles,
  }
}

export type PlatformSessionState =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'not-platform-admin'; readonly userId: string }
  | {
      readonly kind: 'needs-2fa-setup' | 'platform-admin'
      readonly userId: string
      readonly sessionId: string
      readonly platformAdminId: string
      readonly displayName: string
    }

/**
 * The BCS team (PLATFORM_ADMIN, §2.2) signs in like everyone else; an active PlatformAdmin row for the identity makes
 * the session a platform session. TOTP is always required: platform admins switch customers' modules (BR-AUTH-08).
 */
export async function resolvePlatformSession(headers: Headers, opts: { now?: Date } = {}): Promise<PlatformSessionState> {
  const validated = await validateSession(headers, opts)
  if (validated.kind !== 'valid') return validated
  const admin = await systemDb.platformAdmin.findFirst({ where: { userId: validated.userId, active: true } })
  if (!admin) return { kind: 'not-platform-admin', userId: validated.userId }
  return {
    kind: validated.twoFactorEnabled ? 'platform-admin' : 'needs-2fa-setup',
    userId: validated.userId,
    sessionId: validated.sessionId,
    platformAdminId: admin.id,
    displayName: admin.displayName,
  }
}

/** Context for platform services acting on one customer organization (no business data, BR-AUTH-08). */
export function platformCtx(state: PlatformSessionState, organizationId: string, now: Date): Ctx | null {
  if (state.kind !== 'platform-admin') return null
  return makeCtx({ organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: state.platformAdminId }, channel: 'WEB', now })
}

/** Context for services; only a fully set-up member gets one (2FA enforced before any work, FR-AUTH-002 AC1). */
export function ctxFromSession(state: SessionState, channel: SessionChannel, now: Date): Ctx | null {
  if (state.kind !== 'member') return null
  return makeCtx({ organizationId: state.member.organizationId, actor: { type: 'USER', memberId: state.member.id }, channel, now })
}
