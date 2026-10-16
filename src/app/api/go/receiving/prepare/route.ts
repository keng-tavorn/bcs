import { HTTP_STATUS } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { prepareOfflineCopies } from '@/server/services/receiving/offline-copies'

// GET /api/go/receiving/prepare (S17-12, FR-PLT-301 AC5, BR-APP-04): copies of the POs the member may receive now, for
// /go/receive to keep on the phone — no price, amount, budget or contact — and whose they are (the page sends a receipt
// only for the member signed in, BR-APP-09). 200 { memberId, copies, truncated, retentionDays } ·
// 401 · 403 MODULE_DISABLED (BCS_GO off). A member who receives nothing gets an empty list. Read-only, never cached.
// A route at a fixed URL, not a server action: the page's shell may come from an older build (BR-APP-03).
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export async function GET(request: Request): Promise<Response> {
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return json({ error: { code: 'UNAUTHENTICATED' } }, HTTP_STATUS.UNAUTHENTICATED)
  const copies = await prepareOfflineCopies(ctx)
  if (!copies.ok) return json({ error: { code: copies.error.code, details: copies.error.details } }, HTTP_STATUS[copies.error.code])
  return json({ ...copies.data, memberId: ctx.actor.type === 'USER' ? ctx.actor.memberId : null }, 200)
}
