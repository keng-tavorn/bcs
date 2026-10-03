import { HTTP_STATUS, isErrorCode } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { BYTES_PER_KIB } from '@/lib/constants'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { ETAX_MAX_BYTES } from '@/ui/finance/limits'
import type { EtaxOutcome } from '@/ui/finance/outcome'
import { readEtaxFor } from '../../commands'

// POST an e-Tax file of the PO's invoice (S4-17, BR-IVC-05, FR-P2P-008 AC4): a PDF/A-3 with its XML, or the XML. A
// route rather than a server action because an e-Tax PDF carries its fonts and logo and often passes the 1 MB a server
// action takes; the body is the file itself, its name in the x-file-name header (URI-encoded), refused past
// ETAX_MAX_BYTES (4 MiB, under the 4.5 MB the staging host takes in one request) while it arrives. The session decides
// who reads; the service checks invoiceConfirmation.record, the PO and the file, keeps the file and answers what to
// fill in or why it cannot (BR-AUTH-05). Same-origin only, so a page of another site cannot post files into someone's
// session. Answers use the HTTP status of §14.2.

const json = (body: EtaxOutcome, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
/** A URI-encoded file name of 200 Thai characters is about 1.8 KB; anything longer is not a name */
const FILE_NAME_HEADER_MAX = 2 * BYTES_PER_KIB

function sameOrigin(request: Request): boolean {
  // Browsers say where a request comes from; a fetch of another site is refused even when it carries the cookie
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = request.headers.get('origin')
  if (!origin) return true
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** The body's bytes, or null when it is larger than the limit (counted as it arrives: Content-Length may be absent) */
async function readBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > ETAX_MAX_BYTES) return null
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > ETAX_MAX_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

function fileNameOf(header: string | null): string {
  if (!header || header.length > FILE_NAME_HEADER_MAX) return ''
  try {
    return decodeURIComponent(header)
  } catch {
    return ''
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ poId: string }> }): Promise<Response> {
  if (!sameOrigin(request)) return json({ ok: false, code: 'FORBIDDEN' }, HTTP_STATUS.FORBIDDEN)
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return json({ ok: false, code: 'UNAUTHENTICATED' }, HTTP_STATUS.UNAUTHENTICATED)
  const content = await readBody(request)
  // 413 Content Too Large: refused as a whole, and the form says so
  if (content === null) return json({ ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'TOO_LARGE' }, 413)
  const outcome = await readEtaxFor(ctx, (await params).poId, fileNameOf(request.headers.get('x-file-name')), content)
  if (outcome.ok) return json(outcome)
  return json(outcome, isErrorCode(outcome.code) ? HTTP_STATUS[outcome.code] : HTTP_STATUS.INTERNAL)
}
