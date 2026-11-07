import { acceptPrivacyNotice } from '@/server/portal/commands'
import { portalRequest, postSession } from '@/server/portal/http'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../_lib/respond'

// POST /portal/<org>/api/privacy (BR-PORTAL ข้อ 08): the contact acknowledges the privacy notice shown to them

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'privacy')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const version = field(form, 'version')
  const r = await acceptPrivacyNotice(state, { version }, `privacy:${state.sessionId}:${version}`)
  return r.ok ? seeOther(req.org, '') : seeOther(req.org, '', { error: r.error.code })
}
