import { z } from 'zod'
import { BYTES_PER_KIB, MS_PER_SECOND } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { isLiffRequestFromThisSite } from '@/server/auth/liff'
import { MOCK_LINE_USER_ID } from '@/app/liff/_lib/mock-cookie'

// POST /api/liff/mock-token { lineUserId } — LIFF_MOCK only (S5 sub-spec row "LIFF", APP_ENV=local): a LIFF page in an
// ordinary browser (e2e, development) gets an ID token for this LINE user, issued for this environment's LIFF channel
// (LINE_LIFF_CHANNEL_ID) by the fake LINE server of the run (LINE_API_BASE_URL + /__fake/id-token, scripts/lib/fake-line.ts).
// It replaces liff.getIDToken() and nothing else: the page sends the token to POST /api/liff/session, where the server
// has it verified at LINE_API_BASE_URL as always (BR-LINE-01, BR-LINE-02) — the fake verifies only tokens it issued.
// Everywhere but APP_ENV=local with LIFF_MOCK=1 the route answers 404 as if it did not exist (env.ts refuses LIFF_MOCK
// outside local, and outside local LINE_API_BASE_URL can only be LINE's own, which has no such endpoint). The token is
// in the answer's body only — never in a URL or a log — and the answer is not cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The body is { lineUserId } and nothing else; far smaller than this */
const BODY_MAX_BYTES = BYTES_PER_KIB
const FAKE_LINE_TIMEOUT_MS = 5 * MS_PER_SECOND

const Body = z.strictObject({ lineUserId: z.string().regex(MOCK_LINE_USER_ID) })

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/** LIFF_MOCK is on for this process (local only) */
function liffMockEnabled(): boolean {
  const env = getEnv()
  return env.APP_ENV === 'local' && env.LIFF_MOCK === true
}

export async function POST(request: Request): Promise<Response> {
  if (!liffMockEnabled()) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
  if (!isLiffRequestFromThisSite(request.headers)) return json({ ok: false, code: 'FORBIDDEN', reason: 'CROSS_SITE' }, 403)
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) return json({ ok: false, code: 'VALIDATION_FAILED', field: '(body)', reason: 'TOO_LARGE' }, 413)
  const text = await request.text()
  if (text.length > BODY_MAX_BYTES) return json({ ok: false, code: 'VALIDATION_FAILED', field: '(body)', reason: 'TOO_LARGE' }, 413)
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  const parsed = Body.safeParse(body)
  if (!parsed.success) return json({ ok: false, code: 'VALIDATION_FAILED', field: parsed.error.issues[0]?.path.join('.') || '(body)' }, 400)
  const env = getEnv()
  const channelId = env.LINE_LIFF_CHANNEL_ID
  if (!channelId) return json({ ok: false, code: 'EXTERNAL_SERVICE_ERROR', service: 'LINE', reason: 'NOT_CONFIGURED' }, 503)
  let answer: Response
  try {
    answer = await fetch(`${env.LINE_API_BASE_URL}/__fake/id-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: parsed.data.lineUserId, aud: channelId }),
      signal: AbortSignal.timeout(FAKE_LINE_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch {
    return json({ ok: false, code: 'EXTERNAL_SERVICE_ERROR', service: 'LINE' }, 502)
  }
  const issued = (await answer.json().catch(() => null)) as { idToken?: unknown } | null
  if (!answer.ok || typeof issued?.idToken !== 'string') return json({ ok: false, code: 'EXTERNAL_SERVICE_ERROR', service: 'LINE' }, 502)
  return json({ idToken: issued.idToken }, 200)
}
