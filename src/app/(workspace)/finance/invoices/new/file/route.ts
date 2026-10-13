import { HTTP_STATUS, isErrorCode } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { BYTES_PER_KIB, MAX_UPLOAD_BYTES } from '@/lib/constants'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import type { ApFileOutcome } from '@/ui/ap/list/outcome'
import { AP_FILE_MAX_BYTES } from '@/ui/ap/list/limits'
import { uploadApInvoiceFileFor } from '../../ap-list-commands'

// POST the file of a new tier-2 invoice (S8-13, FR-AP-101 AC1): a PDF, XML, JPEG or PNG for the PO named by ?po=. A route
// rather than a server action because a server action takes 1 MB at most and a scanned invoice is often larger; the
// body is the file itself, its name in the x-file-name header (URI-encoded), refused past AP_FILE_MAX_BYTES while it
// arrives (the staging host refuses a body above 4.5 MB on its own; the service's own limit is MAX_UPLOAD_BYTES). The
// session decides who sends; the service checks invoice.record, module PAY, the PO and the kind of file by its bytes
// (BR-AUTH-05). Same-origin only, so a page of another site cannot post files into someone's session. Answers use the
// HTTP status of §14.2.

const LIMIT = Math.min(AP_FILE_MAX_BYTES, MAX_UPLOAD_BYTES)
const FILE_NAME_HEADER_MAX = 2 * BYTES_PER_KIB

const json = (body: ApFileOutcome, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

function sameOrigin(request: Request): boolean {
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
  if (Number.isFinite(declared) && declared > LIMIT) return null
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > LIMIT) {
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

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ ok: false, code: 'FORBIDDEN' }, HTTP_STATUS.FORBIDDEN)
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return json({ ok: false, code: 'UNAUTHENTICATED' }, HTTP_STATUS.UNAUTHENTICATED)
  const content = await readBody(request)
  // 413 Content Too Large: refused as a whole, and the form says so
  if (content === null) return json({ ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'TOO_LARGE' }, 413)
  const poId = new URL(request.url).searchParams.get('po') ?? ''
  const outcome = await uploadApInvoiceFileFor(ctx, poId, fileNameOf(request.headers.get('x-file-name')), content)
  if (outcome.ok) return json(outcome)
  return json(outcome, isErrorCode(outcome.code) ? HTTP_STATUS[outcome.code] : HTTP_STATUS.INTERNAL)
}
