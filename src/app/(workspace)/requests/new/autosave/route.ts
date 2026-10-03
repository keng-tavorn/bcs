import { z } from 'zod'
import { HTTP_STATUS, isErrorCode } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { BYTES_PER_MIB } from '@/lib/constants'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { createDraft, editRequest } from '@/server/services/requests'
import { toFormFailure } from '@/ui/request-form/outcome'

// POST the request form's draft (FR-INT-006 AC1–AC2). A route rather than a server action because the browser also
// saves while the page is going away (another page, a closed tab), which only a keepalive request outlives. It creates
// the draft on its first save and edits it afterwards, naming the version it was based on (CONFLICT_VERSION when
// another device saved in between). A save changes only the parts it carries (editRequest): lines and quotations are
// left out while one is still being typed, so a save never takes a saved line away by accident.
// The session decides who saves; the services check ownership, state and every value (BR-AUTH-05). Same-origin only,
// so a page of another site cannot save into someone's draft; bodies above AUTOSAVE_BODY_MAX_BYTES are refused before
// they are read (server actions have the same 1 MB limit). Answers use the HTTP status of §14.2.

/** Largest draft body accepted: far above a real draft (200 lines of 500 characters of Thai is about 300 KB) */
const AUTOSAVE_BODY_MAX_BYTES = BYTES_PER_MIB

const Body = z.object({
  idempotencyKey: z.uuid(),
  requestId: z.uuid().nullable(),
  requestTypeCode: z.string().min(1).max(50),
  expectedVersion: z.number().int().nonnegative().nullable(),
  // The draft's parts go on unchecked; the services' schemas check every value (runCommand step 2)
  draft: z.record(z.string(), z.unknown()),
})

/** The parts of a draft a save may carry; anything else is not passed on */
const DRAFT_KEYS = ['title', 'budgetLineId', 'priceIncludesVat', 'formData', 'lines', 'quotations', 'nonLowestQuoteReason'] as const

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

/** The body as text, or null when it is larger than the limit (counted as it arrives: Content-Length may be absent) */
async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > AUTOSAVE_BODY_MAX_BYTES) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > AUTOSAVE_BODY_MAX_BYTES) {
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
  return new TextDecoder().decode(bytes)
}

/** Browser input on its way to a service whose Zod schema checks it (the static type is the service's promise, not ours) */
const unchecked = <T,>(value: Record<string, unknown>) => value as T

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ ok: false, code: 'FORBIDDEN' }, HTTP_STATUS.FORBIDDEN)
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return json({ ok: false, code: 'UNAUTHENTICATED' }, HTTP_STATUS.UNAUTHENTICATED)
  const text = await readBody(request)
  // 413 Content Too Large: the draft is refused as a whole, and the screen says so
  if (text === null) return json({ ok: false, code: 'VALIDATION_FAILED', field: '(body)', reason: 'TOO_LARGE' }, 413)
  const parsed = Body.safeParse(parse(text))
  if (!parsed.success) return json({ ok: false, code: 'VALIDATION_FAILED', field: parsed.error.issues[0]?.path.join('.') || '(body)' }, HTTP_STATUS.VALIDATION_FAILED)
  const { idempotencyKey, requestId, requestTypeCode, expectedVersion, draft } = parsed.data
  const values: Record<string, unknown> = {}
  for (const key of DRAFT_KEYS) if (draft[key] !== undefined) values[key] = draft[key]
  const result = requestId
    ? await editRequest(ctx, unchecked<Parameters<typeof editRequest>[1]>({ ...values, requestId, ...(expectedVersion !== null ? { expectedVersion } : {}) }), { idempotencyKey })
    : await createDraft(ctx, unchecked<Parameters<typeof createDraft>[1]>({ ...values, requestTypeCode }), { idempotencyKey })
  if (result.ok) return json({ ok: true, requestId: result.data.requestId, version: result.data.version, lineIds: result.data.lineIds })
  const code = result.error.code
  return json(toFormFailure(result.error), isErrorCode(code) ? HTTP_STATUS[code] : HTTP_STATUS.INTERNAL)
}
