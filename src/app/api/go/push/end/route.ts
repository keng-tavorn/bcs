import { z } from 'zod'
import { HTTP_STATUS } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { newId } from '@/lib/ids'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { revokePushDevice } from '@/server/services/push-devices'
import { sameOrigin } from '../../../../_lib/same-origin'

// POST /api/go/push/end { deviceId } (S17-13, BR-AUTH-12 LOGOUT): signing out on /go/receive in the BCS Go app ends this
// phone's push device first, as the workspace's sign-out does (src/app/(workspace)/settings/notifications/actions.ts) —
// a route at a fixed URL, not a server action, because the page's shell may come from an older build (BR-APP-03). The
// service checks the member's own devices (self.pushDevices); a device already gone is fine. 204 · 400 · 401 · 403.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const Body = z.strictObject({ deviceId: z.uuid() })

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: { code: 'FORBIDDEN' } }, HTTP_STATUS.FORBIDDEN)
  const ctx = ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now())
  if (!ctx) return json({ error: { code: 'UNAUTHENTICATED' } }, HTTP_STATUS.UNAUTHENTICATED)
  const body = Body.safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: { code: 'VALIDATION_FAILED' } }, HTTP_STATUS.VALIDATION_FAILED)
  const ended = await revokePushDevice(ctx, { deviceId: body.data.deviceId, reason: 'LOGOUT' }, { idempotencyKey: newId() })
  // Someone else's device or one already ended: nothing more to end
  if (!ended.ok && ended.error.code !== 'NOT_FOUND' && ended.error.code !== 'INVALID_STATE_TRANSITION') return json({ error: { code: ended.error.code } }, HTTP_STATUS[ended.error.code])
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}
