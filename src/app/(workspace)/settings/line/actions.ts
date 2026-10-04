'use server'

import { revalidatePath } from 'next/cache'
import { getLocale } from 'next-intl/server'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getMyLineLink, issueLineLinkCode, unlinkMyLine } from '@/server/services/line-link'
import { formatDateTime } from '@/ui/format'
import { qrDrawing } from '@/ui/settings-line/qr'
import { toLineLinkFailure, type IssueLinkCodeOutcome, type LineLinkFailure, type LinkStatusOutcome, type UnlinkLineOutcome } from '@/ui/settings-line/types'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters for /settings/line (FR-LINE-001 AC1 AC3). Each checks the session; the services check
// self.lineLink — the member's own link only — every time (BR-AUTH-05). The link code goes back in the action's answer
// only: no redirect, no URL of BCS, no cookie and no log carries it, and the QR is drawn here, on the server.

const NO_SESSION: LineLinkFailure = { ok: false, code: 'UNAUTHENTICATED' }
const submissionKey = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

/** "ผูกบัญชี LINE": a one-time code for the signed-in member, as the QR, the link and its time left (§9.2 step 1) */
export async function issueLineLinkCodeAction(): Promise<IssueLinkCodeOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  // The security clock: the code's ten minutes are real time, whatever business time says
  const issuedAt = systemClock.now()
  const issued = await issueLineLinkCode(ctx, issuedAt)
  if (!issued.ok) return toLineLinkFailure(issued.error)
  const expiresAt = new Date(issued.data.expiresAt)
  return {
    ok: true,
    url: issued.data.url,
    expiresAtText: formatDateTime(await getLocale(), expiresAt),
    remainingMs: Math.max(0, expiresAt.getTime() - issuedAt.getTime()),
    qr: qrDrawing(issued.data.url),
  }
}

/** Whether the member is linked now (the page asks while it shows a code); reads only */
export async function lineLinkStatusAction(): Promise<LinkStatusOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const link = await getMyLineLink(ctx)
  if (!link.ok) return toLineLinkFailure(link.error)
  return { ok: true, linked: link.data.linked }
}

/** Ends the member's own LINE link from the web (FR-LINE-001 AC3); the rich menu goes back to UNLINKED after it */
export async function unlinkLineAction(idempotencyKey: string): Promise<UnlinkLineOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED' }
  const result = await unlinkMyLine(ctx, {}, { idempotencyKey })
  if (!result.ok) return toLineLinkFailure(result.error)
  revalidatePath('/settings/line')
  return { ok: true }
}
