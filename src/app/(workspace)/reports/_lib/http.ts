import { BYTES_PER_KIB } from '@/lib/constants'

// Shared parts of the insight screens' POST routes (/audit/export, /reports/export). A route rather than a server action
// because an export answers with what the screen shows (rows and the file's checksum) and because a refusal must be
// plain HTTP that anyone can check (ADR-038 ข้อ 5: the CEO's audit export is refused with FORBIDDEN). Same-origin only,
// so a page of another site cannot make exports in someone's name; small bodies only. Answers use the HTTP status of
// §14.2 and never change state on GET.

/** Largest body accepted: a filter or a report's parameters are far below this */
const BODY_MAX_BYTES = 16 * BYTES_PER_KIB

export function sameOrigin(request: Request): boolean {
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

/** The JSON body, or undefined when it is too large or not JSON */
export async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) return undefined
  const text = await request.text()
  if (text.length > BODY_MAX_BYTES) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
