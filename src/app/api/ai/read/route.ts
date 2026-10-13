import { randomUUID } from 'node:crypto'
import { HTTP_STATUS } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { readDocument } from '@/server/services/ai'
import { sameOrigin } from '../../../_lib/same-origin'

// POST /api/ai/read { fileId, purpose: QUOTATION | DELIVERY_NOTE, subject? } — starts reading a file with the Document
// Agent (FR-AI-303 AC1 AC5 AC8, docs/sub-specs/S13.md "route"). Answers 202 { agentActionId } of a PENDING action that
// GET /api/ai/actions/[id] follows · 400 AI_FILE_UNSUPPORTED (reason ETAX for an e-Tax file: no AI call, no credits) ·
// 401 · 403 the gate that refused (AI_AGENT_DISABLED, MODULE_DISABLED, AI_NOT_EVALUATED) · 422 AI_CREDITS_EXHAUSTED ·
// 429 RATE_LIMITED. The service decides everything; the route only reads the session and the body.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: { code: 'FORBIDDEN' } }, HTTP_STATUS.FORBIDDEN)
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return json({ error: { code: 'UNAUTHENTICATED' } }, HTTP_STATUS.UNAUTHENTICATED)
  const body: unknown = await request.json().catch(() => null)
  // A retry with the same Idempotency-Key gets the same action, never a second call (§14.1)
  const idempotencyKey = request.headers.get('idempotency-key') ?? randomUUID()
  const started = await readDocument(ctx, (body ?? {}) as never, { idempotencyKey })
  if (!started.ok) return json({ error: { code: started.error.code, details: started.error.details } }, HTTP_STATUS[started.error.code])
  return json(started.data, 202)
}
