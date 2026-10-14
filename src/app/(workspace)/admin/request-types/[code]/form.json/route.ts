import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { currentFormJson } from '@/server/services/request-types'

// GET the JSON of the form a request type uses now (FR-ADM-005 AC1), to edit and import as the next version. At
// /admin/request-types/[code]/form.json: /form is the no-code form builder (S6-14 · FR-INT-104).
// Read-only: it never changes state.
export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }): Promise<Response> {
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return new Response(null, { status: 401 })
  // Next decodes dynamic params already; decoding again would throw on a code such as "%" (a 500 instead of a 404)
  const { code } = await params
  const result = await currentFormJson(ctx, code)
  if (!result.ok) return new Response(null, { status: result.error.code === 'NOT_FOUND' ? 404 : 403 })
  return new Response(result.data.json, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${result.data.fileName}"`,
      'cache-control': 'no-store',
    },
  })
}
