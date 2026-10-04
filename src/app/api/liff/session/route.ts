import { z } from 'zod'
import { getEnv } from '@/lib/env'
import { LIFF_ID_TOKEN_MAX_LENGTH } from '@/lib/constants'
import { auth } from '@/server/auth/auth'
import { isLiffRequestFromThisSite, LIFF_SESSION_PATH } from '@/server/auth/liff'

// POST /api/liff/session { idToken } — the LIFF app signs in (§9.1, §9.4, BR-LINE-01, BR-LINE-02). The body holds the ID
// token of liff.getIDToken() and nothing else: a LINE user id, a profile or any other field from the browser is refused,
// never read. The request is handed to the liffIdToken plugin of Better Auth (/api/auth/liff/session, ADR-040), which has
// LINE verify the token, finds the linked member and sets the LIFF session cookie; Better Auth's rate limit applies there.
// Answers: 200 { ok } with the cookie · 400 a body that is not { idToken } · 401 a token LINE does not accept for our LIFF
// channel (forged, wrong aud, expired) · 403 another site (CROSS_SITE), or reason LINK_REQUIRED (open /liff/link),
// LINK_AMBIGUOUS (one LINE account linked to two sign-in identities: an admin unlinks one) or SIGNED_IN_AS_ANOTHER_USER
// (the browser holds a live session of another sign-in identity, which stays with its cookie: the gate offers to sign it
// out first) · 413 · 503 LINE cannot be asked now. Sending a new ID token renews the session (§9.4): the new one takes
// the place of the session the browser holds when that is the same person's or has ended, never of someone else's.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Far above an ID token of LIFF_ID_TOKEN_MAX_LENGTH characters in JSON */
const BODY_MAX_BYTES = 2 * LIFF_ID_TOKEN_MAX_LENGTH

const Body = z.strictObject({ idToken: z.string().min(1).max(LIFF_ID_TOKEN_MAX_LENGTH) })

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
  // Another site's page cannot sign a browser into an account (login CSRF); the plugin checks it again
  if (!isLiffRequestFromThisSite(request.headers)) return json({ ok: false, code: 'FORBIDDEN', reason: 'CROSS_SITE' }, 403)
  const text = await readBody(request)
  if (text === null) return json({ ok: false, code: 'VALIDATION_FAILED', field: '(body)', reason: 'TOO_LARGE' }, 413)
  const parsed = Body.safeParse(parse(text))
  if (!parsed.success) return json({ ok: false, code: 'VALIDATION_FAILED', field: parsed.error.issues[0]?.path.join('.') || '(body)' }, 400)
  // The same request (cookies, origin, address, user agent) with only the checked body, to the plugin's endpoint
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  headers.set('content-type', 'application/json')
  const forwarded = new Request(new URL(`/api/auth${LIFF_SESSION_PATH}`, getEnv().BETTER_AUTH_URL), {
    method: 'POST',
    headers,
    body: JSON.stringify({ idToken: parsed.data.idToken }),
  })
  const answer = await auth.handler(forwarded)
  const answerHeaders = new Headers(answer.headers)
  answerHeaders.set('cache-control', 'no-store')
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: answerHeaders })
}
