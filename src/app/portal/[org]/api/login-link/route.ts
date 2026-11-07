import { requestLoginLink } from '@/server/portal/commands'
import { portalRequest, sameOrigin } from '@/server/portal/http'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../_lib/respond'

// POST /portal/<org>/api/login-link (BR-PORTAL ข้อ 01): an e-mail asks for a sign-in link. The answer is the same for an
// address nobody holds; only the limits answer otherwise (RATE_LIMITED · BR-PORTAL ข้อ 04).

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  if (!sameOrigin(request)) return forbiddenCsrf()
  const r = await requestLoginLink(req.org, { email: field(await formOf(request), 'email') }, req.meta)
  return r.ok ? seeOther(req.org, '/login', { sent: 1 }) : seeOther(req.org, '/login', { error: r.error.code })
}
