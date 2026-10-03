'use server'

import { revalidatePath } from 'next/cache'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { PoolOutcome } from '@/ui/procurement/outcome'
import { getSession } from '../../../_lib/session'
import { assignLines, consolidatePool } from './commands'

// Browser-facing adapters of the procurement pool (FR-P2P-001 AC2, FR-P2P-002 AC3). Each checks the session and hands
// the raw input to commands.ts, which parses it and runs the service; the service checks po.create and the pool again
// (BR-AUTH-05), so a hidden button is never the guard. The idempotencyKey comes from the form (spec §4.3).

const NO_SESSION: PoolOutcome = { ok: false, code: 'UNAUTHENTICATED' }

/** The pool, the purchase orders, home and the bell all change after these */
function refreshed(outcome: PoolOutcome): PoolOutcome {
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}

export async function assignSupplierAction(input: { requestLineIds: string[]; supplierId: string | null }, idempotencyKey: string): Promise<PoolOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return NO_SESSION
  return refreshed(await assignLines(ctx, input, idempotencyKey))
}

export async function consolidateNowAction(idempotencyKey: string): Promise<PoolOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return NO_SESSION
  return refreshed(await consolidatePool(ctx, idempotencyKey))
}
