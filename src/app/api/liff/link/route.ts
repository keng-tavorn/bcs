import { HTTP_STATUS } from '@/core/result'
import { LIFF_ID_TOKEN_MAX_LENGTH } from '@/lib/constants'
import { isLiffRequestFromThisSite } from '@/server/auth/liff'
import { linkLineAccount } from '@/server/services/line-link'

// POST /api/liff/link { code, idToken } — the LIFF page /liff/link links the member's LINE account (§9.1, §9.2 step 2,
// FR-LINE-001 AC1 AC2). `code` is the one-time code the signed-in member got (/settings/line, or the LIFF page after an
// e-mail, password and 2FA sign-in); `idToken` is liff.getIDToken(). Nothing else is read: a LINE user id, a profile or
// any other field from the browser is refused (BR-LINE-01). The page sends it only after the person saw whose account
// the code links (previewLineLinkCode) and tapped to confirm — never on its own from a URL. The code is checked first,
// then the member's link requests are counted, then LINE checks the ID token (BR-LINE-02), then command line.link runs
// (src/server/services/line-link). Only pages of this site may ask (a link is a sign-in of sorts: another site must
// not link a browser's LINE account to an account of its choosing).
// Answers carry the error code and, for a refusal, its reason (and the time to try again); never the code, the token or
// a LINE user id:
//   200 { ok } · 400 VALIDATION_FAILED (body) or TOKEN_INVALID · 401 UNAUTHENTICATED { reason: ID_TOKEN_INVALID }
//   403 FORBIDDEN (CROSS_SITE, or the member is not active) · 409 TOKEN_USED, or INVALID_STATE_TRANSITION { reason }
//   410 TOKEN_EXPIRED (reason UNLINKED_SINCE: the member unlinked after the code was given) · 413
//   429 RATE_LIMITED { reason: LINK_ATTEMPTS, time } (LINE was not asked) · 502 EXTERNAL_SERVICE_ERROR (LINE could not
//   be asked) · 500 INTERNAL
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Far above a code (about 130 characters) and an ID token of LIFF_ID_TOKEN_MAX_LENGTH characters in JSON */
const BODY_MAX_BYTES = 2 * LIFF_ID_TOKEN_MAX_LENGTH

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/** The body as text, or null when it is larger than the limit (counted as it arrives: Content-Length may be absent) */
async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > BODY_MAX_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isLiffRequestFromThisSite(request.headers)) return json({ ok: false, code: 'FORBIDDEN', reason: 'CROSS_SITE' }, 403)
  const text = await readBody(request)
  if (text === null) return json({ ok: false, code: 'VALIDATION_FAILED', field: '(body)', reason: 'TOO_LARGE' }, 413)
  const result = await linkLineAccount(parse(text))
  if (result.ok) return json({ ok: true }, 200)
  const { code, details } = result.error
  const reason = typeof details?.reason === 'string' ? details.reason : undefined
  const field = code === 'VALIDATION_FAILED' && typeof details?.field === 'string' ? details.field : undefined
  const time = code === 'RATE_LIMITED' && typeof details?.time === 'string' ? details.time : undefined
  return json({ ok: false, code, ...(reason ? { reason } : {}), ...(field ? { field } : {}), ...(time ? { time } : {}) }, HTTP_STATUS[code])
}
