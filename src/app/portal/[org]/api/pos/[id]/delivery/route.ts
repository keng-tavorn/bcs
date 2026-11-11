import { randomUUID } from 'node:crypto'
import { portalRequest, postSession } from '@/server/portal/http'
import { updatePoDelivery } from '@/server/services/suppliers/po-ack'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../../../_lib/respond'

// POST /portal/<org>/api/pos/<id>/delivery (S7-11 · FR-SUP-105 AC3): a new delivery date with its reason, with the CSRF token

export async function POST(request: Request, { params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params
  const req = await portalRequest(request, org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'pos.delivery')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const r = await updatePoDelivery(state.ctx, { poId: id, promisedDeliveryOn: field(form, 'promisedDeliveryOn'), reason: field(form, 'reason') }, { idempotencyKey: field(form, 'key') || randomUUID() })
  if (r.ok) return seeOther(req.org, `/pos/${id}`, { done: 'delivery' })
  if (r.error.code === 'NOT_FOUND') return seeOther(req.org, '/pos')
  const reason = typeof r.error.details?.reason === 'string' ? r.error.details.reason : null
  return seeOther(req.org, `/pos/${id}`, { error: reason === 'PAST_DATE' || reason === 'NO_CHANGE' ? reason : r.error.code })
}
