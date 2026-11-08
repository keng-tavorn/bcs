import { randomUUID } from 'node:crypto'
import { portalRequest, postSession } from '@/server/portal/http'
import { uploadSupplierDocument } from '@/server/services/suppliers/documents'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../_lib/respond'

// POST /portal/<org>/api/documents (S7-06 · BR-PORTAL ข้อ 07 · BR-SDOC ข้อ 02): a document of the contact's own supplier or
// application, as multipart form data with its CSRF token. The bytes are checked by the service (type by its bytes,
// 20 MB), the dates by the type; the answer is the documents page with its result.

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'documents')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const file = form.get('file')
  if (!(file instanceof File)) return seeOther(req.org, '/documents', { error: 'VALIDATION_FAILED' })
  const r = await uploadSupplierDocument(
    state.ctx,
    {
      supplierId: state.contact.supplierId,
      applicationId: state.contact.supplierId ? null : state.contact.applicationId,
      documentTypeCode: field(form, 'documentTypeCode'),
      issuedOn: field(form, 'issuedOn'),
      expiresOn: field(form, 'expiresOn') || null,
      scope: field(form, 'scope') || null,
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    },
    { idempotencyKey: field(form, 'key') || randomUUID() },
  )
  return r.ok ? seeOther(req.org, '/documents', { sent: 1 }) : seeOther(req.org, '/documents', { error: r.error.code })
}
