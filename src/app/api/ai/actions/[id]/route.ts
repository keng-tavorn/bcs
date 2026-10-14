import { HTTP_STATUS } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getAgentAction } from '@/server/services/ai'
import { getSession } from '../../../../_lib/session'

// GET /api/ai/actions/[id] — one AI result for its screen and for S17 (docs/sub-specs/S13.md "route"). Read only: the
// member who asked and AUDITOR get its content, ORG_ADMIN its metadata (ai.actions.view), anyone else 403 · 404.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return json({ error: { code: 'UNAUTHENTICATED' } }, HTTP_STATUS.UNAUTHENTICATED)
  const found = await getAgentAction(ctx, (await params).id)
  if (!found.ok) return json({ error: { code: found.error.code } }, HTTP_STATUS[found.error.code])
  return json(found.data, 200)
}
