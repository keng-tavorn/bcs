import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { portalRequest, postSession } from '@/server/portal/http'
import { isUuid } from '@/server/queries/requests'
import { askQuestion, confirmNetPrices, declineRfx, viewRfx } from '@/server/services/sourcing'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../../_lib/respond'

// POST /portal/<org>/api/rfx/respond (S10-05 S10-06 · FR-SRC-202 AC1 · BR-RFX-04): what the contact does on an RFx besides
// its bid — action = view (the page POSTs it once after it loads, with the CSRF header; the GET of the page writes
// nothing · §17.3), decline (with an optional reason) or ask (a question until questionCutoffAt). view answers JSON (the
// page's script calls it); the others answer the RFx page with ?declined= ?asked= or ?error=. S10-11 (OQ-212): confirm —
// the winner who bid with VAT gives each line it won its price before VAT (net:<rfxLineId>), answered on the result page
// with ?confirmed= or ?error= ?reason= ?lines=.

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'rfx/respond')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const rfxEventId = field(form, 'rfxEventId')
  const action = field(form, 'action')
  if (!isUuid(rfxEventId)) return action === 'view' ? notFound() : seeOther(req.org, '/rfx', { error: 'NOT_FOUND' })
  if (action === 'view') {
    // once per invite: the same key for every load of the page (§4.3)
    const r = await viewRfx(state.ctx, { rfxEventId }, { idempotencyKey: `rfx-view:${rfxEventId}:${state.contact.id}` })
    return NextResponse.json({ ok: r.ok })
  }
  const page = `/rfx/${rfxEventId}`
  const key = field(form, 'key') || randomUUID()
  if (action === 'confirm') {
    const lines = [...form.keys()].flatMap((k) => {
      const m = /^net:([0-9a-f-]{36})$/.exec(k)
      return m && isUuid(m[1]!) ? [{ rfxLineId: m[1]!, unitPrice: field(form, k).trim().replaceAll(',', '') }] : []
    })
    const r = await confirmNetPrices(state.ctx, { rfxEventId, lines }, { idempotencyKey: key })
    if (r.ok) return seeOther(req.org, `${page}/result`, { confirmed: 1 })
    const details: Readonly<Record<string, unknown>> = r.error.details ?? {}
    return seeOther(req.org, `${page}/result`, { error: r.error.code, reason: typeof details.reason === 'string' ? details.reason : undefined, lines: typeof details.line === 'string' ? details.line : undefined })
  }
  const r =
    action === 'decline'
      ? await declineRfx(state.ctx, { rfxEventId, ...(field(form, 'reason') ? { reason: field(form, 'reason') } : {}) }, { idempotencyKey: key })
      : await askQuestion(state.ctx, { rfxEventId, question: field(form, 'question') }, { idempotencyKey: key })
  if (r.ok) return seeOther(req.org, page, { [action === 'decline' ? 'declined' : 'asked']: 1 })
  const details: Readonly<Record<string, unknown>> = r.error.details ?? {}
  return seeOther(req.org, page, { error: r.error.code, reason: typeof details.reason === 'string' ? details.reason : undefined })
}
