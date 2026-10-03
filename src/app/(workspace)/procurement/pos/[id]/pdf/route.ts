import { HTTP_STATUS } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { purchaseOrderPdf } from '@/server/services/documents/pdf'

// GET the printed purchase order (FR-PLT-009 AC1). Read-only: it renders the PO as it stands and changes nothing.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return new Response(null, { status: 401 })
  const result = await purchaseOrderPdf(ctx, (await params).id)
  if (!result.ok) return new Response(null, { status: HTTP_STATUS[result.error.code] })
  return new Response(new Uint8Array(result.data.pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(result.data.fileName)}`,
      'cache-control': 'private, no-store',
    },
  })
}
