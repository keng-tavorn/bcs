import { signOutPortal } from '@/server/portal/commands'
import { portalRequest, postSession } from '@/server/portal/http'
import { PORTAL_CSRF_COOKIE, PORTAL_SESSION_COOKIE, portalCookieOptions } from '@/server/portal/session'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../_lib/respond'

// POST /portal/<org>/api/sign-out (BR-PORTAL ข้อ 03): ends the session, with its CSRF token

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const state = await postSession(request, req, field(await formOf(request), 'csrf'), 'sign-out')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  await signOutPortal(state)
  const res = seeOther(req.org, '/login')
  res.cookies.set(PORTAL_SESSION_COOKIE, '', portalCookieOptions(req.org, { maxAgeMs: 0 }))
  res.cookies.set(PORTAL_CSRF_COOKIE, '', portalCookieOptions(req.org, { maxAgeMs: 0, httpOnly: false }))
  return res
}
