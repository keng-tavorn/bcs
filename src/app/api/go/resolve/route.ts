import { HTTP_STATUS } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { resolveScannedPo } from '@/server/services/receiving/offline-copies'

// GET /api/go/resolve?h=<sha256 of the token> (S17-14, FR-PLT-301 AC6 AC10, BR-APP-11, BR-APP-13): the PO a QR scanned
// on site was printed on, as a copy for /go/receive's receiving form. The page hashes the token itself (WebCrypto) and
// sends only the hash. 200 { copy } · 404 NOT_FOUND (no such printing, another organization's, out of the member's
// scope or no longer taking goods — all alike) · 401 · 403 MODULE_DISABLED (BCS_GO off). Read-only, never cached; a route
// at a fixed URL, not a server action, because the page's shell may come from an older build (BR-APP-03).
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export async function GET(request: Request): Promise<Response> {
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return json({ error: { code: 'UNAUTHENTICATED' } }, HTTP_STATUS.UNAUTHENTICATED)
  const found = await resolveScannedPo(ctx, new URL(request.url).searchParams.get('h') ?? '')
  if (!found.ok) return json({ error: { code: found.error.code } }, HTTP_STATUS[found.error.code])
  return json(found.data, 200)
}
