import { randomUUID } from 'node:crypto'
import { portalRequest, postSession } from '@/server/portal/http'
import { getPortalApplication } from '@/server/portal/queries'
import { takeAiReading } from '@/server/services/suppliers/ai-take'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../../_lib/respond'

// POST /portal/<org>/api/application/ai (S7-14 · FR-AI-304 AC3 · BR-AI-30): the contact takes values the AI read off a
// document into its application — the ones it ticked (take=<path>), and with the button rest=1 every other value that
// need not be confirmed one by one — with its CSRF token. The answer is the step it came from.

const SHOWN = ['CONFLICT_VERSION', 'INVALID_STATE_TRANSITION', 'DUPLICATE_SUPPLIER', 'DUPLICATE_REASON_REQUIRED', 'TAXID_CHECKSUM', 'FORBIDDEN'] as const

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
  // the version the page showed, as the form of the application does: a change made since is CONFLICT_VERSION
  const version = Number(field(form, 'version'))
  const r = await takeAiReading(
    state.ctx,
    { applicationId: app.id, expectedVersion: Number.isInteger(version) ? version : -1, agentActionId: field(form, 'agentActionId'), paths: paths as never, rest: field(form, 'rest') === '1' },
    { idempotencyKey: field(form, 'key') || randomUUID() },
  )
  if (r.ok) return seeOther(req.org, '/apply', { step, ai: 'taken' })
  if (r.error.details?.reason === 'NOTHING_TAKEN') return seeOther(req.org, '/apply', { step, error: 'AI_NOTHING_TAKEN' })
  // the refusals the page explains (the application changed, was sent, a duplicate, a tax id that fails its check)
  return seeOther(req.org, '/apply', { step, error: (SHOWN as readonly string[]).includes(r.error.code) ? r.error.code : 'VALIDATION_FAILED' })
}
