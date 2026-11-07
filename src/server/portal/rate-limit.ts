import { PORTAL_CONTACT_LIMIT, PORTAL_IP_LIMITS, PORTAL_RATE_WINDOW_MS } from '@/lib/portal-limits'
import { countPortalIpHit } from '@/server/db/portal'
import { forTenant } from '@/server/db/tenant'

// Rate limits of the portal (BR-PORTAL ข้อ 04): fixed windows counted in the database (no Redis in the stack), one
// UPSERT per hit outside the command's transaction, so a refused or rolled-back request still counts. Per IP (its
// hash) in PortalIpRateLimit, global; per contact, supplier or application in PortalRateLimit, inside the organization
// the path names. Over the limit → RATE_LIMITED, the same answer whether or not the e-mail is known.

export type IpBucket = keyof typeof PORTAL_IP_LIMITS
export type ScopeBucket = 'LINK' | 'OTP' | 'UPLOAD' | 'INVOICE'

/** Within the limit · the first hit over it in the window (recorded once) · a later one (refused, not recorded again) */
export type LimitVerdict = 'OK' | 'FIRST_OVER' | 'OVER'
const verdict = (count: number, limit: number): LimitVerdict => (count <= limit ? 'OK' : count === limit + 1 ? 'FIRST_OVER' : 'OVER')

/** The start of the window `now` falls in */
export const windowStart = (now: Date, windowMs: number = PORTAL_RATE_WINDOW_MS): Date => new Date(Math.floor(now.getTime() / windowMs) * windowMs)

/** Counts one hit of the IP against PORTAL_IP_LIMITS */
export async function hitIpLimit(ipHashValue: string, bucket: IpBucket, now: Date): Promise<LimitVerdict> {
  return verdict(await countPortalIpHit(ipHashValue, bucket, windowStart(now)), PORTAL_IP_LIMITS[bucket])
}

/**
 * Counts one hit of a contact, a supplier or an application against `limit` (a contact's links and
 * codes each have PORTAL_CONTACT_LIMIT a window; links are counted per e-mail, known or not).
 */
export async function hitScopeLimit(
  organizationId: string,
  scope: { readonly kind: 'CONTACT' | 'SUPPLIER' | 'APPLICATION'; readonly key: string },
  bucket: ScopeBucket,
  now: Date,
  limit: number = PORTAL_CONTACT_LIMIT,
  windowMs: number = PORTAL_RATE_WINDOW_MS,
): Promise<LimitVerdict> {
  const start = windowStart(now, windowMs)
  const row = await forTenant(organizationId).portalRateLimit.upsert({
    where: { organizationId_scopeKind_scopeKey_bucket_windowStart: { organizationId, scopeKind: scope.kind, scopeKey: scope.key, bucket, windowStart: start } },
    create: { organizationId, scopeKind: scope.kind, scopeKey: scope.key, bucket, windowStart: start, count: 1 },
    update: { count: { increment: 1 } },
    select: { count: true },
  })
  return verdict(row.count, limit)
}
