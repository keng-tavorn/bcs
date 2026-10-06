import { HTTP_STATUS } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { exportDoaVersionYaml } from '@/server/services/doa/view'

// GET one DOA version as YAML in the shape of the §7.4 fixture (FR-DOA-001 AC2): import it again and the data is the
// same. Read-only: it never changes state. The service checks admin.doa.draft (BR-AUTH-05). A refusal answers with the
// HTTP status of its §14.2 code and the code itself (a version the shape cannot hold: 400 VALIDATION_FAILED with
// reason MULTI_STEP_RULE; an unexpected failure: 500 INTERNAL with its reference) — never as if it were forbidden.
export async function GET(request: Request, { params }: { params: Promise<{ versionId: string }> }): Promise<Response> {
  const { versionId } = await params
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return Response.json({ code: 'UNAUTHENTICATED' }, { status: HTTP_STATUS.UNAUTHENTICATED, headers: { 'cache-control': 'no-store' } })
  const result = await exportDoaVersionYaml(ctx, versionId)
  if (!result.ok) {
    const { code, details } = result.error
    const reason = typeof details?.reason === 'string' ? details.reason : undefined
    const requestId = typeof details?.requestId === 'string' ? details.requestId : undefined
    return Response.json({ code, ...(reason ? { reason } : {}), ...(requestId ? { requestId } : {}) }, { status: HTTP_STATUS[code], headers: { 'cache-control': 'no-store' } })
  }
  return new Response(result.data.yaml, {
    headers: {
      'content-type': 'application/yaml; charset=utf-8',
      'content-disposition': `attachment; filename="${result.data.fileName}"`,
      'cache-control': 'no-store',
    },
  })
}
