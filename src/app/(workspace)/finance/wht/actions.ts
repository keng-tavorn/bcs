'use server'

import { getLocale } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { ExportOutcome, RevealOutcome } from '@/ui/wht/outcome'
import { getSession } from '../../../_lib/session'
import { localeOf } from '../../_tracking/present'
import { exportWhtReturnFor, revealPayeeTaxIdFor } from './commands'
import { NO_SESSION } from './failure'

// Browser-facing adapters of /finance/wht (S8-13): the session, then ./commands.ts; the services check wht.revealTaxId
// and wht.export every time (BR-AUTH-05). Revealing is a POST (a server action) because it writes the access log.

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function revealPayeeTaxIdAction(input: { certificateId: string }): Promise<RevealOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return revealPayeeTaxIdFor(ctx, input, localeOf(await getLocale()))
}

export async function exportWhtReturnAction(input: { month: string; form: 'PND3' | 'PND53'; revealTaxId: boolean }, idempotencyKey: string): Promise<ExportOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return exportWhtReturnFor(ctx, input, idempotencyKey, localeOf(await getLocale()))
}
