import { randomUUID } from 'node:crypto'
import { applyErrorOf } from '@/server/portal/apply-form'
import { portalRequest, postSession } from '@/server/portal/http'
import { getPortalApplication } from '@/server/portal/queries'
import { submitApplication } from '@/server/services/suppliers/applications'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../../_lib/respond'

// POST /portal/<org>/api/application/submit (S7-08 · BR-SUP ข้อ 09 ข้อ 11 · BR-PORTAL ข้อ 08): the check-and-send step,
// with a reason for each duplicate warning (reason.<code>). Sent → the application page with where it stands; refused →
// the check step with what is missing or why.

const WARNINGS = ['SAME_TAXID_OTHER_BRANCH', 'DUPLICATE_NAME', 'DUPLICATE_EMAIL'] as const

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'application.submit')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const app = await getPortalApplication(state.ctx)
  if (!app) return seeOther(req.org, '/apply', { error: 'FORBIDDEN' })
  const duplicateReasons = Object.fromEntries(WARNINGS.map((code) => [code, field(form, `reason.${code}`).trim()]).filter(([, reason]) => reason !== ''))
  const version = Number(field(form, 'version'))
  const r = await submitApplication(state.ctx, { applicationId: app.id, expectedVersion: Number.isInteger(version) ? version : -1, duplicateReasons }, { idempotencyKey: field(form, 'key') || randomUUID() })
  if (r.ok) return seeOther(req.org, '/apply', { sent: 1 })
  if (r.error.code === 'PRIVACY_NOTICE_OUTDATED') return seeOther(req.org, '', { error: r.error.code })
  return seeOther(req.org, '/apply', { step: 'review', error: applyErrorOf(r.error) })
}
