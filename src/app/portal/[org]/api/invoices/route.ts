import { randomUUID } from 'node:crypto'
import { portalRequest, postSession } from '@/server/portal/http'
import { createInvoiceFromPortal, updateInvoice } from '@/server/services/ap'
import { uploadPortalInvoiceFile } from '@/server/services/ap/files'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../_lib/respond'
import { headerOf } from './form'

// POST /portal/<org>/api/invoices (S7-12 · FR-AP-101 AC7 · BR-SUP ข้อ 15): a new invoice on a PO of the contact's supplier,
// as multipart form data with its CSRF token — S8's own commands in turn: the file (invoice.store_file), the draft
// (invoice.create, channel PORTAL) and its header (invoice.update). A refused header leaves the draft to edit on its page.

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'invoices.new')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const poId = field(form, 'poId')
  const key = field(form, 'key') || randomUUID()
  const back = (error: string) => seeOther(req.org, '/invoices/new', { po: poId || undefined, error })
  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) return back('FILE_REQUIRED')
  const header = headerOf(form)
  if (!header.ok) return back(header.reason)
  const stored = await uploadPortalInvoiceFile(state.ctx, { poId, fileName: file.name, content: new Uint8Array(await file.arrayBuffer()) }, { idempotencyKey: `${key}:file` })
  if (!stored.ok) return back(typeof stored.error.details?.reason === 'string' ? stored.error.details.reason : stored.error.code)
  const created = await createInvoiceFromPortal(state.ctx, { poId, sourceFileId: stored.data.fileId }, { idempotencyKey: `${key}:create` })
  if (!created.ok) return back(typeof created.error.details?.reason === 'string' ? created.error.details.reason : created.error.code)
  const { invoiceId } = created.data
  const updated = await updateInvoice(state.ctx, { invoiceId, version: 0, ...header.data }, { idempotencyKey: `${key}:update` })
  if (!updated.ok) return seeOther(req.org, `/invoices/${invoiceId}`, { error: typeof updated.error.details?.reason === 'string' ? updated.error.details.reason : updated.error.code })
  return seeOther(req.org, `/invoices/${invoiceId}`, { done: 'sent' })
}
