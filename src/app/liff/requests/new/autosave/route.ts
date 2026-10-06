import { saveDraftFromRequest } from '../../../../_lib/autosave-route'
import { liffPage } from '../../../_lib/session'

// POST the LIFF request form's draft (FR-INT-006 AC1–AC2 on the LIFF channel): the same saves as the web's
// /requests/new/autosave (src/app/_lib/autosave-route.ts: same origin only, at most 1 MiB, created on the first save and
// edited after it naming the version it was based on, only the parts a save carries), with the session of the LIFF page,
// whose channel (LIFF) every request.drafted Event records. A route rather than a server action because the browser
// also saves while the page goes away (LINE's window closing), which only a keepalive request outlives. The LIFF session
// decides who saves (a LIFF-only session is no session on the web's route); the services check ownership, state and
// every value (BR-AUTH-05).
export async function POST(request: Request): Promise<Response> {
  return saveDraftFromRequest(request, async () => {
    const page = await liffPage()
    return page.kind === 'member' ? page.ctx : null
  })
}
