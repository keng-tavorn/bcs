import { systemDb } from './system'
import { forTenant } from './tenant'

// The portal's reads outside one tenant (S7-04 · §4.8): which organization a path names (/portal/[org] before any
// session exists), and the global per-IP rate limit (PortalIpRateLimit has no organizationId · BR-PORTAL ข้อ 04). Only
// these, here in the db layer, so src/server/portal never holds the unscoped client.

export interface OrgOfCode {
  readonly id: string
  readonly name: string
  readonly supplierModule: boolean
}

/** The organization whose code is `code` (case-insensitive), with whether SUPPLIER is on */
export async function organizationOfCode(code: string): Promise<OrgOfCode | null> {
  // codes are unique as written; two that differ only by case would make the path ambiguous, so neither answers
  const found = await systemDb.organization.findMany({
    where: { code: { equals: code, mode: 'insensitive' } },
    select: { id: true, legalNameTh: true, displayName: true, modules: { where: { module: 'SUPPLIER', enabled: true }, select: { id: true } } },
    take: 2,
  })
  const org = found.length === 1 ? found[0]! : null
  return org ? { id: org.id, name: org.displayName ?? org.legalNameTh, supplierModule: org.modules.length > 0 } : null
}

/** Counts one hit of an IP (its hash) in a bucket and window; the count after it */
export async function countPortalIpHit(scopeKey: string, bucket: 'LINK' | 'OTP', windowStart: Date): Promise<number> {
  const row = await systemDb.portalIpRateLimit.upsert({
    where: { scopeKey_bucket_windowStart: { scopeKey, bucket, windowStart } },
    create: { scopeKey, bucket, windowStart, count: 1 },
    update: { count: { increment: 1 } },
    select: { count: true },
  })
  return row.count
}

/** Counts one hit of a contact, a supplier or an application in a bucket and window (PortalRateLimit · BR-PORTAL ข้อ 04) */
export async function countPortalScopeHit(
  organizationId: string,
  scope: { readonly kind: 'CONTACT' | 'SUPPLIER' | 'APPLICATION'; readonly key: string },
  bucket: 'LINK' | 'OTP' | 'UPLOAD' | 'INVOICE',
  windowStart: Date,
): Promise<number> {
  const row = await forTenant(organizationId).portalRateLimit.upsert({
    where: { organizationId_scopeKind_scopeKey_bucket_windowStart: { organizationId, scopeKind: scope.kind, scopeKey: scope.key, bucket, windowStart } },
    create: { organizationId, scopeKind: scope.kind, scopeKey: scope.key, bucket, windowStart, count: 1 },
    update: { count: { increment: 1 } },
    select: { count: true },
  })
  return row.count
}

/** The organizations with SUPPLIER on: the daily jobs of S7 run once for each */
export async function organizationsWithSupplier(): Promise<string[]> {
  return (await systemDb.orgModule.findMany({ where: { module: 'SUPPLIER', enabled: true }, select: { organizationId: true }, orderBy: { organizationId: 'asc' } })).map((m) => m.organizationId)
}
