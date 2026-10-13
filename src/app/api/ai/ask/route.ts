import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HTTP_STATUS } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { askInsight, insightResponse } from '@/server/services/ai'
import { sameOrigin } from '../../../_lib/same-origin'

// POST /api/ai/ask — a question to the Insight Agent from the chat of ⌘K (FR-AI-307, FR-AI-309 AC2 AC4). The body is the
// chat's (@ai-sdk/react): the last user message's text is the question. Answers a stream of the sentences checked one
// by one before sending (ADR-144), with the tools' rows and links as data · 400 · 401 · 403 the gate that refused ·
// 422 AI_CREDITS_EXHAUSTED · 429 RATE_LIMITED. The service decides everything under the asking member's rights.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

const ChatBody = z.object({
  id: z.string().optional(),
  messages: z.array(z.object({ role: z.string(), parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()) }).loose()).min(1),
})

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: { code: 'FORBIDDEN' } }, HTTP_STATUS.FORBIDDEN)
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return json({ error: { code: 'UNAUTHENTICATED' } }, HTTP_STATUS.UNAUTHENTICATED)
  const body = ChatBody.safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: { code: 'VALIDATION_FAILED' } }, HTTP_STATUS.VALIDATION_FAILED)
  const last = [...body.data.messages].reverse().find((m) => m.role === 'user')
  const question = (last?.parts ?? []).flatMap((p) => (p.type === 'text' && p.text ? [p.text] : [])).join(' ')
  const conversationId = z.uuid().safeParse(body.data.id).success ? body.data.id : undefined
  const answer = await askInsight(ctx, { question, ...(conversationId ? { conversationId } : {}) }, { idempotencyKey: request.headers.get('idempotency-key') ?? randomUUID() })
  if (!answer.ok) return json({ error: { code: answer.error.code, details: answer.error.details } }, HTTP_STATUS[answer.error.code])
  return insightResponse(answer.data)
}
