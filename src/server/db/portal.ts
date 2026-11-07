import { systemDb } from './system'

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
  const org = await systemDb.organization.findFirst({
    where: { code: { equals: code, mode: 'insensitive' } },
    select: { id: true, legalNameTh: true, displayName: true, modules: { where: { module: 'SUPPLIER', enabled: true }, select: { id: true } } },
  })
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
