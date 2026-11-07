import { PORTAL_PENDING_COOKIE_MS } from '@/lib/portal-limits'
import { consumePortalLink } from '@/server/portal/commands'
import { portalRequest, sameOrigin } from '@/server/portal/http'
import { PORTAL_PENDING_COOKIE, portalCookieOptions } from '@/server/portal/session'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../_lib/respond'

// POST /portal/<org>/api/link (BR-PORTAL ข้อ 01 ข้อ 02): the link is used (once) and a code goes to its contact. The
// browser keeps `<challengeId>.<token>` for the page of the code, under the organization's path only.

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  if (!sameOrigin(request)) return forbiddenCsrf()
  const token = field(await formOf(request), 'token')
  const r = await consumePortalLink(req.org, { token }, req.meta)
  if (!r.ok) return seeOther(req.org, '/login', { error: r.error.code })
  const res = seeOther(req.org, '/otp')
  res.cookies.set(PORTAL_PENDING_COOKIE, `${r.data.challengeId}.${token}`, portalCookieOptions(req.org, { maxAgeMs: PORTAL_PENDING_COOKIE_MS }))
  return res
}
