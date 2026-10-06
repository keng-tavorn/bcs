import { systemClock } from '@/lib/clock'
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_LIFF_MS, SESSION_IDLE_WEB_MS, SESSION_TOUCH_AFTER_MS } from '@/lib/constants'
import { makeCtx, type Ctx } from '@/server/context'
import { systemDb } from '@/server/db/system'
import { forTenant } from '@/server/db/tenant'
import { STORED_ROLES, type StoredRole } from '@/server/authz/permissions'
import { auth } from './auth'
import { isLiffSessionToken, liffSessionMemberIds } from './liff'

// Resolves the signed-in member from the request (spec §4.3 step 3). Session limits run on real time — the
// "security clock" — so e2e time travel of business time never signs anybody out (FR-AUTH-003 AC1):
// web idle 30 min / absolute 12 h, LIFF idle 15 min. Expired sessions are deleted, not just ignored. A request is
// activity of its session unless the caller says it is not (touch: false — a page asking by itself, such as the link
// status /settings/line polls for): then the session's idle clock is left as it was, and the limits still apply.

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

/** FR-AUTH-002 AC1: anyone with a role besides REQUESTER, or holding a position a DOA refers to, needs TOTP. */
export function requiresTwoFactor(roles: readonly StoredRole[], holdsDoaPosition: boolean): boolean {
  return roles.length > 0 || holdsDoaPosition
}

/**
 * FR-AUTH-002 AC1 (NFR-SEC-03): the member holds now a position that a rule of a DOA version in effect, to come or
 * awaiting approval names as approver — or such a rule names the member directly (the versions doaNamedApprovers of
 * src/server/doa/policy.ts reads, and tests compare the two). They can approve, so they set up TOTP before any work,
 * like members with roles. It runs on every request of a
 * member without a role and without TOTP, so it is two small indexed reads in the member's own organization: the
 * positions the member holds now, then whether one rule of those versions names one of them or the member
 * (DoaRule.steps holds [{ approver: { kind, position | memberId }, … }]; JSON containment finds the approver).
 */
export async function holdsDoaReferencedPosition(organizationId: string, memberId: string, now: Date): Promise<boolean> {
  const db = forTenant(organizationId)
  const held = await db.positionAssignment.findMany({
    where: { memberId, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
    select: { position: { select: { code: true } } },
  })
  const approvers = [{ kind: 'MEMBER', memberId }, ...[...new Set(held.map((h) => h.position.code))].map((position) => ({ position }))]
  const naming = await db.doaRule.count({
    where: {
      doaVersion: { is: { OR: [{ status: 'PENDING_APPROVAL' }, { status: 'PUBLISHED', OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }] } },
      OR: approvers.map((approver) => ({ steps: { array_contains: [{ approver }] } })),
    },
  })
  return naming > 0
}

export interface ResolveSessionOptions {
  /** Where the request comes from: LIFF pages accept LIFF sessions, with the LIFF idle limit; anything else does not */
  readonly channel?: SessionChannel
  /** The security clock; real time unless a test gives its own */
  readonly now?: Date
  /**
   * Whether the request is activity of its session (default true). False for a request a page makes by itself, without
   * the person doing anything — a status poll — so it never keeps an idle session alive (FR-AUTH-003 AC1): lastActiveAt
   * stays as it was, while the idle and absolute limits still apply and an expired session is still deleted.
   */
  readonly touch?: boolean
}

type ValidatedSession =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'expired' }
  | {
      readonly kind: 'valid'
      readonly userId: string
      readonly sessionId: string
      readonly twoFactorEnabled: boolean
      /** The token of a session opened from a LIFF ID token (it names the LINE link it stands on); null for any other */
      readonly liffToken: string | null
    }

/**
 * Session limits on real time (FR-AUTH-003 AC1): expired sessions are deleted; activity is recorded at most every
 * minute, and not at all for a request that is no activity (touch: false).
 */
async function validateSession(headers: Headers, opts: ResolveSessionOptions): Promise<ValidatedSession> {
  // Better Auth's own lookup; for a LIFF session the liffIdToken plugin (liff.ts) ends it first when its link is gone
  const result = await auth.api.getSession({ headers })
  if (!result) return { kind: 'anonymous' }
  const { session, user } = result
  // A session opened from a LIFF ID token is for LIFF pages only (§9.4, liff.ts): elsewhere it is no session, so a LINE
  // login never stands in for the password and TOTP the workspace asks for (FR-AUTH-002 AC1). It is kept for LIFF.
  const liff = isLiffSessionToken(session.token)
  if (liff && opts.channel !== 'LIFF') return { kind: 'anonymous' }
  const now = (opts.now ?? systemClock.now()).getTime()
  const createdAt = new Date(session.createdAt).getTime()
  const lastActive = session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : createdAt
  const idleLimit = opts.channel === 'LIFF' ? SESSION_IDLE_LIFF_MS : SESSION_IDLE_WEB_MS
  if (now - createdAt >= SESSION_ABSOLUTE_MS || now - lastActive >= idleLimit) {
    await systemDb.session.deleteMany({ where: { id: session.id } })
    return { kind: 'expired' }
  }
  if (opts.touch !== false && now - lastActive >= SESSION_TOUCH_AFTER_MS) {
    // updateMany: a session ended in the meantime (an unlink, a sign-out in another tab) is simply not there to update
    await systemDb.session.updateMany({ where: { id: session.id }, data: { lastActiveAt: new Date(now) } })
  }
  return { kind: 'valid', userId: user.id, sessionId: session.id, twoFactorEnabled: Boolean(user.twoFactorEnabled), liffToken: liff ? session.token : null }
}

export async function resolveSession(headers: Headers, opts: ResolveSessionOptions = {}): Promise<SessionState> {
  const validated = await validateSession(headers, opts)
  if (validated.kind !== 'valid') return validated
  const { userId, sessionId } = validated
  let members = await systemDb.member.findMany({
    where: { userId, status: 'ACTIVE', organization: { status: 'ACTIVE' } },
    include: { organization: { select: { legalNameTh: true, displayName: true } } },
    orderBy: { createdAt: 'asc' },
  })
  if (validated.liffToken !== null) {
    // A LIFF session acts only as the member of the LINE link it was opened with, while that very link stands where LINE
    // is on (liff.ts): never as another member of the same person, nor on a newer link of theirs. Otherwise it ends here
    const linked = await liffSessionMemberIds(userId, validated.liffToken)
    members = members.filter((m) => linked.has(m.id))
    if (members.length === 0) {
      await systemDb.session.deleteMany({ where: { id: sessionId, token: validated.liffToken } })
      return { kind: 'anonymous' }
    }
  }
  if (members.length === 0) return { kind: 'no-membership', userId }
  const preferred = readCookie(headers, ORG_COOKIE)
  const member = members.find((m) => m.organizationId === preferred) ?? members[0]!
  const roles = (
    await systemDb.roleAssignment.findMany({ where: { memberId: member.id, organizationId: member.organizationId, revokedAt: null }, select: { role: true } })
  )
    .map((r) => r.role)
    .filter((r): r is StoredRole => (STORED_ROLES as readonly string[]).includes(r))
  // FR-AUTH-002 AC1: a role, or a position a DOA refers to (looked up only when it can change the answer)
  const needsSetup =
    !validated.twoFactorEnabled &&
    requiresTwoFactor(roles, roles.length === 0 && (await holdsDoaReferencedPosition(member.organizationId, member.id, opts.now ?? systemClock.now())))
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
export async function resolvePlatformSession(headers: Headers, opts: Omit<ResolveSessionOptions, 'channel'> = {}): Promise<PlatformSessionState> {
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
