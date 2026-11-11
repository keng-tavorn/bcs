import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { portalRequest, postSession } from '@/server/portal/http'
import { isUuid } from '@/server/queries/requests'
import { removeBidFile, requestPortalRfxFile, uploadBidFile } from '@/server/services/sourcing'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../../_lib/respond'

// POST /portal/<org>/api/rfx/file (S10-07 · BR-RFX-07 · BR-PORTAL ข้อ 07): the files of the contact's RFx and bid —
// action = upload (multipart: rfxEventId, file), remove (fileId) or download (fileId: a file of the RFx, RFX_DOC, or of
// the bid; answered with a 303 to a five-minute link · a POST, never a GET). The bid page's form uploads and removes
// with fetch and Accept: application/json, so the prices it holds stay on the page: it gets JSON. Without that header
// the answer is a page with ?uploaded= ?removed= or ?error= (and ?reason=).

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'rfx/file')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const json = (request.headers.get('accept') ?? '').includes('application/json')
  const rfxEventId = field(form, 'rfxEventId')
  const action = field(form, 'action')
  if (!isUuid(rfxEventId)) return json ? NextResponse.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 }) : seeOther(req.org, '/rfx', { error: 'NOT_FOUND' })
  const bidPage = `/rfx/${rfxEventId}/bid`
  const fileId = field(form, 'fileId')
  if (action === 'download') {
    const r = isUuid(fileId) ? await requestPortalRfxFile(state.ctx, { rfxEventId, fileId }, { idempotencyKey: randomUUID() }) : null
    return r?.ok ? NextResponse.redirect(r.data.url, 303) : seeOther(req.org, `/rfx/${rfxEventId}`, { error: r ? r.error.code : 'NOT_FOUND' })
  }
  const key = field(form, 'key') || randomUUID()
  const remove = action === 'remove'
  const file = form.get('file')
  const removed = remove && isUuid(fileId) ? await removeBidFile(state.ctx, { rfxEventId, fileId }, { idempotencyKey: key }) : null
  const uploaded = !remove && file instanceof File ? await uploadBidFile(state.ctx, { rfxEventId, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, { idempotencyKey: key }) : null
  const r = removed ?? uploaded
  const reason = r ? (!r.ok && typeof r.error.details?.reason === 'string' ? r.error.details.reason : undefined) : remove ? undefined : 'EMPTY'
  const code = r ? (r.ok ? null : r.error.code) : remove ? 'NOT_FOUND' : 'VALIDATION_FAILED'
  if (json) {
    if (!code) return NextResponse.json(uploaded?.ok ? { ok: true, file: { id: uploaded.data.fileId, scanStatus: 'PENDING' } } : { ok: true })
    return NextResponse.json({ ok: false, code, ...(reason ? { reason } : {}) }, { status: 422 })
  }
  if (!code) return seeOther(req.org, bidPage, { [action === 'remove' ? 'removed' : 'uploaded']: 1 })
  return seeOther(req.org, bidPage, { error: code, reason })
}
