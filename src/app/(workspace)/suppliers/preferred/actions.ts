'use server'

import { revalidatePath } from 'next/cache'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { EndPreferredInput, NewPreferredInput, PreferredFailure, PreferredOutcome } from '@/ui/sourcing/preferred-model'
import { getSession } from '../../../_lib/session'
import { createPreferredFromScreen, endPreferredFromScreen } from './commands'

// Browser-facing adapters of /suppliers/preferred (S10-13 · BR-RFX-14). Each one builds ctx from the session and hands
// the browser's arguments, unread, to ./commands.ts, which parses them and calls the commands of preferred.ts; those
// check SOURCING and sourcing.preferred.manage (PROCUREMENT) and every rule again (BR-AUTH-05): hiding a button is never
// the guard. The idempotencyKey comes from the form (spec §4.3), so a double click or a retry runs the command once.

const NO_SESSION: PreferredFailure = { ok: false, code: 'UNAUTHENTICATED' }

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

function refreshed<T extends PreferredOutcome>(outcome: T): T {
  if (outcome.ok) revalidatePath('/suppliers/preferred')
  return outcome
}

export async function createPreferredSupplierAction(input: NewPreferredInput, idempotencyKey: string): Promise<PreferredOutcome<{ preferredSupplierId: string }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await createPreferredFromScreen(ctx, input, idempotencyKey))
}

export async function endPreferredSupplierAction(input: EndPreferredInput, idempotencyKey: string): Promise<PreferredOutcome<{ preferredSupplierId: string }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await endPreferredFromScreen(ctx, input, idempotencyKey))
}
