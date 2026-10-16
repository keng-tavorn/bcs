import { HTTP_STATUS } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { requestUpload } from '@/server/services/files'
import { sameOrigin } from '../../../../_lib/same-origin'

// POST /api/go/files/request { fileName, mimeType, sizeBytes } (S17-12, BR-APP-14): an upload ticket for one photo of a
// receipt in the queue of /go/receive — requestUpload as the forms use it (the uploader is the member signed in, who
// must be the one who captured the receipt, as gr.post's photosUsable checks). 200 { uploadUrl, ticket } · 400 · 401.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: { code: 'FORBIDDEN' } }, HTTP_STATUS.FORBIDDEN)
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return json({ error: { code: 'UNAUTHENTICATED' } }, HTTP_STATUS.UNAUTHENTICATED)
  const body: unknown = await request.json().catch(() => null)
  const ticket = await requestUpload(ctx, (body ?? {}) as never)
  if (!ticket.ok) return json({ error: { code: ticket.error.code, details: ticket.error.details } }, HTTP_STATUS[ticket.error.code])
  return json(ticket.data, 200)
}
