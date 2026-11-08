import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { portalRequest, postSession } from '@/server/portal/http'
import { whtCertificateUrlForContact } from '@/server/services/ap/portal'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../../../_lib/respond'

// POST /portal/<org>/api/payments/<certificateId>/wht (S7-12 · FR-PAY-103 AC8): the 50 ทวิ of the contact's own supplier
// as an address of five minutes, logged as file.downloaded — a POST with the CSRF token, never a GET link that lasts

export async function POST(request: Request, { params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params
  const req = await portalRequest(request, org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'payments.wht')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const r = await whtCertificateUrlForContact(state.ctx, { certificateId: id }, { idempotencyKey: field(form, 'key') || randomUUID() })
  return r.ok ? NextResponse.redirect(r.data.url, 303) : seeOther(req.org, '/payments', { error: r.error.code })
}
