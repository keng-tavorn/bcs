import { NextResponse } from 'next/server'
import { portalRequest, postSession } from '@/server/portal/http'
import { poPdfUrlForContact } from '@/server/services/suppliers/po-ack'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../../../_lib/respond'

// POST /portal/<org>/api/pos/<id>/pdf (S7-11 · FR-SUP-105 AC1 · BR-TOK-06): the PDF of the PO's current revision, as an
// address of five minutes — a POST with the CSRF token, never a GET link that lasts

export async function POST(request: Request, { params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params
  const req = await portalRequest(request, org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'pos.pdf')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const r = await poPdfUrlForContact(state.ctx, id)
  return r.ok ? NextResponse.redirect(r.data.url, 303) : seeOther(req.org, '/pos')
}
