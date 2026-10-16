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

/**
 * The organization whose LINE channel answers at /api/webhooks/line/<channelKey> (§9.1, S5-02). channelKey is public
 * (it is the webhook path), so finding the organization proves nothing: the webhook still checks x-line-signature with
 * that organization's channel secret before it reads anything (BR-LINE-03). null when no channel has this key.
 */
export async function findLineChannelOrganization(channelKey: string): Promise<{ readonly organizationId: string } | null> {
  return systemDb.lineChannelConfig.findUnique({ where: { channelKey }, select: { organizationId: true } })
}

/**
 * Every organization that has a LINE channel, switched on or not: the line-webhook sweep looks at the webhook events of
 * each (S5-02, BR-LINE-05). Ids only.
 */
export async function listLineChannelOrganizationIds(): Promise<string[]> {
  const rows = await systemDb.lineChannelConfig.findMany({ select: { organizationId: true }, orderBy: { organizationId: 'asc' } })
  return rows.map((r) => r.organizationId)
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

/**
 * The VAT rates (BR-VAT-01, spec §7.1). TaxRate belongs to no organization, so services read it here; the dates come
 * back as the calendar days they hold ("YYYY-MM-DD").
 */
export async function listTaxRates(): Promise<Array<{ code: string; rateBp: number; effectiveFrom: string; effectiveTo: string | null }>> {
  const rows = await systemDb.taxRate.findMany({ select: { code: true, rateBp: true, effectiveFrom: true, effectiveTo: true }, orderBy: { effectiveFrom: 'asc' } })
  const day = (d: Date) => d.toISOString().slice(0, 10)
  return rows.map((r) => ({ code: r.code, rateBp: r.rateBp, effectiveFrom: day(r.effectiveFrom), effectiveTo: r.effectiveTo ? day(r.effectiveTo) : null }))
}

/**
 * The document a verification QR names (S6-19 · BR-QR-02): found by the hash of the token in the URL, which is secret
 * and unique, so the public /verify page can say which organization's document it is. null when no row has the hash.
 */
export async function findDocumentVerificationByTokenHash(tokenHash: string): Promise<{ readonly organizationId: string; readonly id: string } | null> {
  return systemDb.documentVerification.findUnique({ where: { tokenHash }, select: { organizationId: true, id: true } })
}
