'use server'

import { revalidatePath } from 'next/cache'
import { getLocale } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { IncomeTypeFormInput } from '@/ui/wht/income-types'
import type { TaxOutcome } from '@/ui/wht/outcome'
import { getSession } from '../../../../_lib/session'
import { localeOf } from '../../../_tracking/present'
import { NO_SESSION } from '../failure'
import { confirmIncomeTypeFor, updateIncomeTypeFor } from './commands'

// Browser-facing adapters of /finance/wht/types (S8-13): the session, then ./commands.ts; the service checks
// wht.configure every time (BR-AUTH-05).

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function updateIncomeTypeAction(input: IncomeTypeFormInput, idempotencyKey: string): Promise<TaxOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const outcome = await updateIncomeTypeFor(ctx, input, idempotencyKey, localeOf(await getLocale()))
  if (outcome.ok) revalidatePath('/finance/wht/types')
  return outcome
}

export async function confirmIncomeTypeAction(input: { code: string }, idempotencyKey: string): Promise<TaxOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const outcome = await confirmIncomeTypeFor(ctx, input, idempotencyKey, localeOf(await getLocale()))
  if (outcome.ok) revalidatePath('/finance/wht/types')
  return outcome
}
