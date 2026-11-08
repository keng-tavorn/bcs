import { randomUUID } from 'node:crypto'
import { portalRequest, postSession } from '@/server/portal/http'
import { updateInvoice } from '@/server/services/ap'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../../_lib/respond'
import { headerOf } from '../form'

// POST /portal/<org>/api/invoices/<id> (S7-12 · BR-SUP ข้อ 15): the contact changes a draft of its own sent on the portal —
// header and lines — until FINANCE confirms its coding (invoice.update of S8 refuses it after), with the CSRF token

export async function POST(request: Request, { params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params
  const req = await portalRequest(request, org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'invoices.update')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const header = headerOf(form, true)
  if (!header.ok) return seeOther(req.org, `/invoices/${id}`, { error: header.reason })
  const version = Number(field(form, 'version'))
  if (!Number.isInteger(version) || version < 0) return seeOther(req.org, `/invoices/${id}`, { error: 'CONFLICT_VERSION' })
  const r = await updateInvoice(state.ctx, { invoiceId: id, version, ...header.data }, { idempotencyKey: field(form, 'key') || randomUUID() })
  if (r.ok) return seeOther(req.org, `/invoices/${id}`, { done: 'saved' })
  if (r.error.code === 'NOT_FOUND') return seeOther(req.org, '/invoices')
  return seeOther(req.org, `/invoices/${id}`, { error: typeof r.error.details?.reason === 'string' ? r.error.details.reason : r.error.code })
}
