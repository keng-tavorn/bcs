import { after } from 'next/server'
import { LINE_WEBHOOK_BODY_MAX_BYTES, receiveLineWebhook } from '@/server/jobs/line-webhook'

// POST /api/webhooks/line/<channelKey> — LINE's webhook (§9.1, FR-LINE-005, BR-LINE-03 to 05). The route only reads the
// raw bytes and hands them over: the signature check, the recording and the processing are in src/server/line/webhook
// (reached through src/server/jobs/line-webhook.ts). Answers carry no body and no detail: 404 for a channel key nobody
// has, 401 for a wrong or missing x-line-signature, 413 for a body above LINE_WEBHOOK_BODY_MAX_BYTES, 200 once the
// signature is right (within 2 s: what does not fit the inline budget goes to the line-webhook job), 500 when the events
// could not be recorded or handed to the job. Other methods are 405 (Next.js); nothing here changes state on a GET.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Seconds the work kept alive after the answer may run (an event still running at the end of the inline budget, and
// telling Inngest about the rest). Next.js reads this as a literal; it is LINE_WEBHOOK_ROUTE_MAX_DURATION_MS (a test
// keeps the two equal), which the job's wait for an event that was still running is counted from.
export const maxDuration = 30

const NO_STORE = { 'cache-control': 'no-store' }

/** The body as bytes, or null when it is larger than the limit (counted as it arrives: Content-Length may be absent) */
async function readBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > LINE_WEBHOOK_BODY_MAX_BYTES) return null
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > LINE_WEBHOOK_BODY_MAX_BYTES) {
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

/** Work that goes on after the answer: next/server after() keeps it alive; outside a request (tests) it simply runs on */
function keepAlive(work: Promise<unknown>): void {
  try {
    after(() => work)
  } catch {
    void work
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ channelKey: string }> }): Promise<Response> {
  const startedAt = performance.now()
  const { channelKey } = await params
  const rawBody = await readBody(request)
  if (rawBody === null) return new Response(null, { status: 413, headers: NO_STORE })
  const answer = await receiveLineWebhook({ channelKey, rawBody, signature: request.headers.get('x-line-signature') }, { startedAt, waitUntil: keepAlive })
  return new Response(null, { status: answer.status, headers: NO_STORE })
}
