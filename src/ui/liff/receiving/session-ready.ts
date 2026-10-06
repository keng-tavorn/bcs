'use client'

import { useCallback } from 'react'
import { useLiff } from '../liff-provider'

// Before a LIFF page sends a server action (a photo upload, a receipt, a delegation): the LIFF session is renewed first
// when it is close to its idle limit (useLiff().ensureSession(), FR-AUTH-003 AC1), and nothing is sent when it cannot be
// kept on this page load — the action would run with an ended session and what the person typed would be lost. In the
// LINE app a token LINE no longer accepts is replaced by loading the page again (at most once a minute); otherwise the
// page says what happened (`onEnded`) and sends nothing. A refusal that is not final (LINE or BCS could not be reached
// just now) lets the action go: the session may still have a few minutes, and the server checks it anyway.

export function useSessionReady(onEnded: () => void): () => Promise<boolean> {
  const liff = useLiff()
  return useCallback(async () => {
    const check = await liff.ensureSession()
    if (check.ok || !check.final) return true
    if (check.reason === 'TOKEN_INVALID' && liff.reloadForNewToken()) return false
    onEnded()
    return false
  }, [liff, onEnded])
}
