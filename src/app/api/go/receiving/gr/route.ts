import { HTTP_STATUS } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { postGoodsReceipt } from '@/server/services/receiving'
import { recordedReceipt } from '@/server/services/receiving/offline-copies'
import { sameOrigin } from '../../../../_lib/same-origin'

// /api/go/receiving/gr (S17-12, FR-PLT-301 AC8, BR-APP-07, BR-APP-08, BR-APP-10): the queue of /go/receive sends a
// receipt with its own key, and asks what a key recorded.
//  - POST + Idempotency-Key: gr.post as it is, with `offline` { capturedAt, capturedByMemberId, expectedPoVersion }.
//    The key is required (the queue's, kept for the item's life), so a resend after a lost answer gets the same
//    receipt (INV-PLT-01). 201 { grId, number, poStatus, poVersion, … } · the error code with its status otherwise.
//  - GET ?key=: what gr.post recorded for this key of the member signed in (another member's key is not found).
//    200 { recorded: false } or { recorded: true, result } · 401. Read-only.
// No module check: gr.post and files are CORE, so a queue left when BCS_GO went off still goes (BR-APP-13).
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: { code: 'FORBIDDEN' } }, HTTP_STATUS.FORBIDDEN)
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return json({ error: { code: 'UNAUTHENTICATED' } }, HTTP_STATUS.UNAUTHENTICATED)
  const idempotencyKey = request.headers.get('idempotency-key') ?? ''
  if (!KEY.test(idempotencyKey)) return json({ error: { code: 'VALIDATION_FAILED', details: { field: 'Idempotency-Key', reason: 'REQUIRED' } } }, HTTP_STATUS.VALIDATION_FAILED)
  const body: unknown = await request.json().catch(() => null)
  const posted = await postGoodsReceipt(ctx, (body ?? {}) as never, { idempotencyKey })
  if (!posted.ok) return json({ error: { code: posted.error.code, details: posted.error.details } }, HTTP_STATUS[posted.error.code])
  return json(posted.data, 201)
}

export async function GET(request: Request): Promise<Response> {
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return json({ error: { code: 'UNAUTHENTICATED' } }, HTTP_STATUS.UNAUTHENTICATED)
  const key = new URL(request.url).searchParams.get('key') ?? ''
  if (!KEY.test(key)) return json({ error: { code: 'VALIDATION_FAILED', details: { field: 'key', reason: 'REQUIRED' } } }, HTTP_STATUS.VALIDATION_FAILED)
  const found = await recordedReceipt(ctx, key)
  if (!found.ok) return json({ error: { code: found.error.code } }, HTTP_STATUS[found.error.code])
  return json(found.data, 200)
}
