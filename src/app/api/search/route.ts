import { HTTP_STATUS } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { countSearch, searchForMember } from '@/server/services/search'
import { getSession } from '../../_lib/session'

// GET /api/search?q= — the ⌘K search of the workspace (FR-PLT-014, §9.1). Read only: no Event, no write beyond the
// call's count (NFR-SEC-05) and the session's own bookkeeping. Answers 200 { documents, suppliers, recent } · 401
// without a member session · 403 · 429 past 60 calls a minute. What the member may find is decided by the service.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export async function GET(request: Request): Promise<Response> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return json({ error: { code: 'UNAUTHENTICATED' } }, HTTP_STATUS.UNAUTHENTICATED)
  const counted = await countSearch(ctx)
  if (!counted.ok) return json({ error: { code: counted.error.code, details: counted.error.details } }, HTTP_STATUS[counted.error.code])
  const found = await searchForMember(ctx, new URL(request.url).searchParams.get('q'))
  if (!found.ok) return json({ error: { code: found.error.code } }, HTTP_STATUS[found.error.code])
  return json(found.data, 200)
}
