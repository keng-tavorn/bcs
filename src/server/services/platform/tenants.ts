import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { findOrganizationForPlatform, isActivePlatformAdmin, listOrganizationsForPlatform, type PlatformOrganization } from '@/server/db/lookups'

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
