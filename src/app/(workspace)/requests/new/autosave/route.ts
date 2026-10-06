import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { saveDraftFromRequest } from '../../../../_lib/autosave-route'

// POST the request form's draft (FR-INT-006 AC1–AC2) on the web: the saves of src/app/_lib/autosave-route.ts (same
// origin only, at most 1 MiB, created on the first save and edited after it naming the version it was based on, only
// the parts a save carries), as the member of the request's session on channel WEB. A route rather than a server action
// because the browser also saves while the page is going away (another page, a closed tab), which only a keepalive
// request outlives. The LIFF form saves through its own route, on the LIFF session (src/app/liff/requests/new/autosave).
export async function POST(request: Request): Promise<Response> {
  return saveDraftFromRequest(request, async () => ctxFromSession(await resolveSession(request.headers), 'WEB', systemClock.now()))
}
