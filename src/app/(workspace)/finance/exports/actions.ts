'use server'

import { revalidatePath } from 'next/cache'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { ExportOutcome, FinanceFailure } from '@/ui/finance/outcome'
import { getSession } from '../../../_lib/session'
import { exportAgain, exportNow } from './commands'

// Browser-facing adapters of the Express export page (S4-09, FR-P2P-009). Each checks the session and hands the raw
// input to ./commands.ts; the export.express command checks the permission every time (BR-AUTH-05). The
// idempotencyKey comes from the form (spec §4.3), so the same click sent twice makes one file.

const NO_SESSION: FinanceFailure = { ok: false, code: 'UNAUTHENTICATED' }

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

/** The export page, the invoice lists and the bell (export.ready) change after a file is made */
function refreshed(outcome: ExportOutcome): ExportOutcome {
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}

export async function exportNowAction(input: { confirmed: boolean; fingerprint: string }, idempotencyKey: string): Promise<ExportOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await exportNow(ctx, input, idempotencyKey))
}

export async function exportAgainAction(input: { exportJobId: string; reason: string }, idempotencyKey: string): Promise<ExportOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await exportAgain(ctx, input, idempotencyKey))
}
