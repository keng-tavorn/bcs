import { randomUUID } from 'node:crypto'
import { portalRequest, postSession } from '@/server/portal/http'
import { acknowledgePo } from '@/server/services/suppliers/po-ack'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../../../_lib/respond'

// POST /portal/<org>/api/pos/<id>/acknowledge (S7-11 · FR-SUP-105 AC2): the contact acknowledges the PO's current revision
// with the date it delivers (optional), with its CSRF token; the answer is the PO's page with the result.

export async function POST(request: Request, { params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params
  const req = await portalRequest(request, org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'pos.acknowledge')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const r = await acknowledgePo(state.ctx, { poId: id, promisedDeliveryOn: field(form, 'promisedDeliveryOn') || null, note: field(form, 'note').trim() || null }, { idempotencyKey: field(form, 'key') || randomUUID() })
  if (r.ok) return seeOther(req.org, `/pos/${id}`, { done: 'ack' })
  if (r.error.code === 'NOT_FOUND') return seeOther(req.org, '/pos')
  const reason = typeof r.error.details?.reason === 'string' ? r.error.details.reason : null
  return seeOther(req.org, `/pos/${id}`, { error: reason === 'PAST_DATE' ? reason : r.error.code })
}
