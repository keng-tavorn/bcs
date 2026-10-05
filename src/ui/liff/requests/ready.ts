'use client'

import { useCallback } from 'react'
import { useLiff } from '../liff-provider'

// Before a LIFF request page sends anything to the server (a server action: the preview of the budget and the route, a
// file upload, attaching or taking off a file, opening one, the requester's answer or sending again, cancelling), the
// LIFF session is renewed first when it is near its idle limit (useLiff().ensureSession(), FR-AUTH-003 AC1), as the
// LIFF provider asks of every page: a renewal started by the same tap would otherwise replace the session while the
// action went out with the one it ended, and the first tap after a pause would fail as signed out. When the session
// cannot be kept on this page load, nothing is sent: in the LINE app a token LINE no longer accepts is replaced by
// loading the page again (at most once a minute, useLiff().reloadForNewToken()); otherwise the caller says that the
// sign-in ended. A refusal that is not final (LINE or BCS could not be reached just now) lets the action go: the session
// may still have a few minutes, and the server checks it anyway.

/** go: send it now · reloading: the page is loading again for a new ID token · ended: the sign-in cannot be kept here */
export type LiffReadiness = 'go' | 'reloading' | 'ended'

export function useLiffReady(): () => Promise<LiffReadiness> {
  const { ensureSession, reloadForNewToken } = useLiff()
  return useCallback(async () => {
    const check = await ensureSession()
    if (check.ok || !check.final) return 'go'
    return check.reason === 'TOKEN_INVALID' && reloadForNewToken() ? 'reloading' : 'ended'
  }, [ensureSession, reloadForNewToken])
}
