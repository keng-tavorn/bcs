import { randomUUID } from 'node:crypto'
import { portalRequest, postSession } from '@/server/portal/http'
import { isUuid } from '@/server/queries/requests'
import { submitRiskAssessment } from '@/server/services/risk/assessments'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../../_lib/respond'

// POST /portal/<org>/api/risk/submit (S11-05 · BR-RSK-17 · BR-RSK-06): the contact sends the assessment with the version
// the page showed (riskAssessment.submit: the points and the tier are frozen there, never shown here). A refusal for
// missing answers (RISK_ANSWERS_INCOMPLETE) comes back with ?missing= — the question codes in sortOrder — for the page
// to name them; the answer is the page with ?sent= or ?error=.

const versionOf = (v: string): number => (/^\d{1,9}$/.test(v) ? Number(v) : -1)

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'risk/submit')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const id = field(form, 'assessmentId')
  if (!isUuid(id)) return seeOther(req.org, '/risk', { error: 'NOT_FOUND' })
  const page = `/risk/${id}`
  const r = await submitRiskAssessment(state.ctx, { assessmentId: id, expectedVersion: versionOf(field(form, 'version')) }, { idempotencyKey: field(form, 'key') || randomUUID() })
  if (r.ok) return seeOther(req.org, page, { sent: 1 })
  const details: Readonly<Record<string, unknown>> = r.error.details ?? {}
  const missing = Array.isArray(details.missing) ? details.missing.filter((x): x is string => typeof x === 'string') : []
  const reason = typeof details.reason === 'string' ? details.reason : undefined
  return seeOther(req.org, page, { error: r.error.code, reason, missing: missing.length ? missing.join(',') : undefined })
}
