import { randomUUID } from 'node:crypto'
import { portalRequest, postSession } from '@/server/portal/http'
import { applyErrorOf, changedFields, stepFields } from '@/server/portal/apply-form'
import { getPortalApplication, PORTAL_APPLY_STEPS, type PortalApplyStep } from '@/server/portal/queries'
import { updateApplication } from '@/server/services/suppliers/applications'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../_lib/respond'

// POST /portal/<org>/api/application (S7-08 · BR-SUP ข้อ 08 ข้อ 09 · ADR-184): one step of the application form, with its
// CSRF token. Only what the step shows and what changed is sent (an unchanged form goes on to the next step); a blank
// optional field clears it; a blank account number keeps the one stored. The answer is the next step, or the same step
// with the reason it was refused.

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'application')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const step = field(form, 'step') as PortalApplyStep
  const at = PORTAL_APPLY_STEPS.indexOf(step)
  if (at < 0) return seeOther(req.org, '/apply', { error: 'VALIDATION_FAILED' })
  const next = PORTAL_APPLY_STEPS[at + 1] ?? 'review'
  const app = await getPortalApplication(state.ctx)
  if (!app) return seeOther(req.org, '/apply', { error: 'FORBIDDEN' })
  const fields = changedFields(stepFields(step, form), app)
  if (Object.keys(fields).length === 0) return seeOther(req.org, '/apply', { step: next })
  const version = Number(field(form, 'version'))
  const r = await updateApplication(state.ctx, { applicationId: app.id, expectedVersion: Number.isInteger(version) ? version : -1, fields }, { idempotencyKey: field(form, 'key') || randomUUID() })
  return r.ok ? seeOther(req.org, '/apply', { step: next }) : seeOther(req.org, '/apply', { step, error: applyErrorOf(r.error) })
}
