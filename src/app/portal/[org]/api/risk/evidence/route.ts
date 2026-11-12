import { randomUUID } from 'node:crypto'
import { portalRequest, postSession } from '@/server/portal/http'
import { isUuid } from '@/server/queries/requests'
import { uploadRiskEvidence } from '@/server/services/risk/evidence'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../../_lib/respond'

// POST /portal/<org>/api/risk/evidence (S11-05 · BR-RSK-18 · BR-AI-34 · BR-PORTAL ข้อ 07 ข้อ 08): one file behind an
// answer, as multipart form data with its CSRF token — assessmentId, questionCode, file, and aiReadable (the uploader's
// tick that the AI may read the files of this answer; unticked = it may not). The bytes, the type, the size, the five
// files a question, the upload bucket and the privacy notice are checked by the service; the answer is the page at the
// question with ?uploaded= or ?error=.

const QUESTION_CODE = /^[A-Za-z0-9-]{1,20}$/

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'risk/evidence')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const id = field(form, 'assessmentId')
  if (!isUuid(id)) return seeOther(req.org, '/risk', { error: 'NOT_FOUND' })
  const questionCode = field(form, 'questionCode')
  const known = QUESTION_CODE.test(questionCode)
  const page = known ? `/risk/${id}#q-${questionCode}` : `/risk/${id}`
  const question = known ? questionCode : undefined
  const file = form.get('file')
  if (!(file instanceof File)) return seeOther(req.org, page, { error: 'VALIDATION_FAILED', reason: 'EMPTY', question })
  const r = await uploadRiskEvidence(
    state.ctx,
    { assessmentId: id, questionCode, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()), aiReadable: field(form, 'aiReadable') !== '' },
    { idempotencyKey: field(form, 'key') || randomUUID() },
  )
  if (r.ok) return seeOther(req.org, page, { uploaded: 1, question })
  const details: Readonly<Record<string, unknown>> = r.error.details ?? {}
  return seeOther(req.org, page, { error: r.error.code, reason: typeof details.reason === 'string' ? details.reason : undefined, question })
}
