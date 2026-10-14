'use server'

import { revalidatePath } from 'next/cache'
import { getLocale } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { TaxOutcome } from '@/ui/wht/outcome'
import { getSession } from '../../../_lib/session'
import { localeOf } from '../../_tracking/present'
import { NO_SESSION } from '../wht/failure'
import { releaseRetentionFor } from './commands'

// Browser-facing adapter of /finance/retentions (S8-13): the session, then ./commands.ts; the service checks
// retention.release every time (BR-AUTH-05).

export async function releaseRetentionAction(input: { retentionId: string; version: number }, idempotencyKey: string): Promise<TaxOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return NO_SESSION
  const outcome = await releaseRetentionFor(ctx, input, idempotencyKey, localeOf(await getLocale()))
  if (outcome.ok) revalidatePath('/finance/retentions')
  return outcome
}
