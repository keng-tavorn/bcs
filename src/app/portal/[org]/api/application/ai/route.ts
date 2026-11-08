import { randomUUID } from 'node:crypto'
import { portalRequest, postSession } from '@/server/portal/http'
import { getPortalApplication } from '@/server/portal/queries'
import { takeAiReading } from '@/server/services/suppliers/ai-take'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../../_lib/respond'

// POST /portal/<org>/api/application/ai (S7-14 · FR-AI-304 AC3 · BR-AI-30): the contact takes values the AI read off a
// document into its application — the ones it ticked (take=<path>), and with the button rest=1 every other value that
// need not be confirmed one by one — with its CSRF token. The answer is the step it came from.

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'application.ai')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const step = field(form, 'step') || 'company'
  const app = await getPortalApplication(state.ctx)
  if (!app) return seeOther(req.org, '/apply', { error: 'FORBIDDEN' })
  const paths = form.getAll('take').filter((v): v is string => typeof v === 'string')
  const r = await takeAiReading(
    state.ctx,
    { applicationId: app.id, expectedVersion: app.version, agentActionId: field(form, 'agentActionId'), paths: paths as never, rest: field(form, 'rest') === '1' },
    { idempotencyKey: field(form, 'key') || randomUUID() },
  )
  if (r.ok) return seeOther(req.org, '/apply', { step, ai: 'taken' })
  const reason = typeof r.error.details?.reason === 'string' ? r.error.details.reason : r.error.code
  return seeOther(req.org, '/apply', { step, error: reason === 'NOTHING_TAKEN' ? 'AI_NOTHING_TAKEN' : 'VALIDATION_FAILED' })
}
