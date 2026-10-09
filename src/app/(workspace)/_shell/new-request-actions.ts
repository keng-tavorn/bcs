'use server'

import { headers } from 'next/headers'
import { systemClock } from '@/lib/clock'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { countMyOpenDrafts } from '@/server/queries/request-form'

// The dialog that starts a new request asks, as it opens, how many drafts the member has to go on with (FR-INT-010
// AC2): read when asked, so the count is never the one of the page the member first opened. Reads only; the member's own.
export async function countMyDraftsAction(): Promise<number> {
  const ctx = ctxFromSession(await resolveSession(await headers()), 'WEB', systemClock.now())
  return ctx ? countMyOpenDrafts(ctx) : 0
}
