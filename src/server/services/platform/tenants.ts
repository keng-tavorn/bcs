import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { findOrganizationForPlatform, isActivePlatformAdmin, listOrganizationsForPlatform, type PlatformOrganization } from '@/server/db/lookups'
import { forTenant } from '@/server/db/tenant'

// Customer organizations as the BCS team sees them at /platform/tenants (§9.1): names and status only, never
// business data (BR-AUTH-08). Every call checks that the platform admin is still active.

export type TenantDto = PlatformOrganization

export async function listTenants(platformAdminId: string): Promise<Result<TenantDto[]>> {
  if (!(await isActivePlatformAdmin(platformAdminId))) return err('FORBIDDEN', 'only the BCS team')
  return ok(await listOrganizationsForPlatform())
}

/** NOT_FOUND for an id that is not a customer organization. */
export async function getTenant(platformAdminId: string, organizationId: string): Promise<Result<TenantDto>> {
  if (!(await isActivePlatformAdmin(platformAdminId))) return err('FORBIDDEN', 'only the BCS team')
  if (!z.uuid().safeParse(organizationId).success) return err('NOT_FOUND', 'organization not found')
  const org = await findOrganizationForPlatform(organizationId)
  return org ? ok(org) : err('NOT_FOUND', 'organization not found')
}

/** S6-21 (BR-UAT-01): whether the organization is a customer's production or a UAT sandbox, and whose sandbox it is */
export interface TenantKindDto {
  readonly kind: 'PRODUCTION' | 'SANDBOX'
  /** The production organization a sandbox belongs to; null for a production organization */
  readonly sandboxOf: TenantDto | null
}

/** The kind of a customer organization for the BCS team's page of it: read only, no business data (BR-AUTH-08) */
export async function getTenantKind(platformAdminId: string, organizationId: string): Promise<Result<TenantKindDto>> {
  const tenant = await getTenant(platformAdminId, organizationId)
  if (!tenant.ok) return tenant
  const row = await forTenant(organizationId).organization.findUnique({ where: { id: organizationId }, select: { kind: true, sandboxOfOrganizationId: true } })
  if (!row) return err('NOT_FOUND', 'organization not found')
  const sandboxOf = row.sandboxOfOrganizationId ? await findOrganizationForPlatform(row.sandboxOfOrganizationId) : null
  return ok({ kind: row.kind, sandboxOf })
}
