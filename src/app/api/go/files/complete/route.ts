import { HTTP_STATUS } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { completeUpload } from '@/server/services/files'
import { sameOrigin } from '../../../../_lib/same-origin'

// POST /api/go/files/complete { ticket } (S17-12, BR-APP-14): the photo is in storage; record it. Completing again with
// the same ticket gives the same file (its command's key is upload:<storage key>), so a lost answer is asked again
// with the ticket while it lives. 200 { fileId } · 400 TICKET_INVALID (ask a new ticket) · NOT_UPLOADED · the file
// refused (TYPE_NOT_ALLOWED TOO_LARGE EMPTY CONTENT_MISMATCH) · 401.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: { code: 'FORBIDDEN' } }, HTTP_STATUS.FORBIDDEN)
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return json({ error: { code: 'UNAUTHENTICATED' } }, HTTP_STATUS.UNAUTHENTICATED)
  const body = (await request.json().catch(() => null)) as { ticket?: unknown } | null
  const done = await completeUpload(ctx, { ticket: typeof body?.ticket === 'string' ? body.ticket : '' })
  if (!done.ok) return json({ error: { code: done.error.code, details: done.error.details } }, HTTP_STATUS[done.error.code])
  return json({ fileId: done.data.fileId }, 200)
}
