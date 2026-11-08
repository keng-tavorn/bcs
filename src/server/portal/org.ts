import { organizationOfCode } from '@/server/db/portal'
import { forTenant } from '@/server/db/tenant'

// The organization of a portal route (BR-PORTAL ข้อ 01): /portal/[org]/… names it by Organization.code in lower case. An
// unknown code and an organization without SUPPLIER give the same answer (null → the page "ยังไม่เปิดบริการ"), so the
// portal never tells whether another organization exists.

export interface PortalOrg {
  readonly organizationId: string
  /** The code as it stands in the path, lower case */
  readonly code: string
  readonly nameTh: string
}

const ORG_CODE = /^[a-z0-9][a-z0-9-]{0,39}$/

export async function resolvePortalOrg(code: string): Promise<PortalOrg | null> {
  const lower = code.toLowerCase()
  if (!ORG_CODE.test(lower)) return null
  const org = await organizationOfCode(lower)
  if (!org || !org.supplierModule) return null
  return { organizationId: org.id, code: lower, nameTh: org.name }
}

/** The path every cookie and link of the organization's portal lives under */
export const portalPath = (org: { readonly code: string }): string => `/portal/${org.code}`

/** The settings of the organization (supplier.* · supplierSettingsOf reads them) */
export async function organizationSettings(org: PortalOrg): Promise<unknown> {
  return (await forTenant(org.organizationId).organization.findUniqueOrThrow({ where: { id: org.organizationId }, select: { settings: true } })).settings
}
