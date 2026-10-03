import { systemDb } from './system'

// Cross-tenant lookups that start from a secret rather than from an organization: the caller holds a one-time
// token and does not know the organization yet. Each lookup is by a unique hash and returns only what the
// caller needs to continue inside the organization it finds (through forTenant from then on).

export interface InvitationLookup {
  readonly id: string
  readonly organizationId: string
  readonly memberId: string
  readonly expiresAt: Date
  readonly usedAt: Date | null
  readonly revokedAt: Date | null
  readonly member: { readonly email: string; readonly displayNameTh: string; readonly status: string; readonly userId: string | null }
}

export async function findInvitationByTokenHash(tokenHash: string): Promise<InvitationLookup | null> {
  return systemDb.memberInvitation.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      organizationId: true,
      memberId: true,
      expiresAt: true,
      usedAt: true,
      revokedAt: true,
      member: { select: { email: true, displayNameTh: true, status: true, userId: true } },
    },
  })
}

/** True when the id belongs to an active member of the BCS team (PLATFORM_ADMIN, §2.2). */
export async function isActivePlatformAdmin(platformAdminId: string): Promise<boolean> {
  const admin = await systemDb.platformAdmin.findUnique({ where: { id: platformAdminId }, select: { active: true } })
  return admin?.active === true
}

const PLATFORM_ORG_SELECT = { id: true, code: true, legalNameTh: true, displayName: true, status: true } as const

export interface PlatformOrganization {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly status: 'ACTIVE' | 'SUSPENDED'
}

/** Customer organizations for the BCS team's tenant list: names and status only, no business data (BR-AUTH-08). */
export async function listOrganizationsForPlatform(): Promise<PlatformOrganization[]> {
  const rows = await systemDb.organization.findMany({ select: PLATFORM_ORG_SELECT, orderBy: { code: 'asc' } })
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.displayName ?? r.legalNameTh, status: r.status }))
}

/** One customer organization by id for the BCS team (same fields as the list); null when there is none. */
export async function findOrganizationForPlatform(organizationId: string): Promise<PlatformOrganization | null> {
  const r = await systemDb.organization.findUnique({ where: { id: organizationId }, select: PLATFORM_ORG_SELECT })
  return r ? { id: r.id, code: r.code, name: r.displayName ?? r.legalNameTh, status: r.status } : null
}
