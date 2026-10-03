'use server'

import { revalidatePath } from 'next/cache'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { PoOutcome } from '@/ui/purchase-order/outcome'
import { getSession } from '../../../_lib/session'
import { cancelPo, closePo, editDraft, sendToSupplier, submitDraft } from './commands'

// Browser-facing adapters of the purchase-order page (FR-P2P-003 to FR-P2P-005, FR-P2P-010). Each checks the session
// and hands the raw input to commands.ts, which parses it and runs the service; the service checks the capability, the
// state machine and the money rules again (BR-AUTH-05), so a hidden button is never the guard. The idempotencyKey comes
// from the form (spec §4.3), so the same submission sent twice runs once — and an e-mail to a supplier goes once.

const NO_SESSION: PoOutcome = { ok: false, code: 'UNAUTHENTICATED' }

/** The PO, the list, the pool, the requests, home and the bell all change after these */
function refreshed(outcome: PoOutcome): PoOutcome {
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function editDraftAction(
  input: { poId: string; expectedVersion: number; lines?: Array<{ poLineId: string; quantity?: string; unitPrice?: string }>; removeLineIds?: string[]; paymentTermDays?: number | null; notesToSupplier?: string | null },
  idempotencyKey: string,
): Promise<PoOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await editDraft(ctx, input, idempotencyKey))
}

export async function submitPoAction(poId: string, idempotencyKey: string): Promise<PoOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await submitDraft(ctx, poId, idempotencyKey))
}

export async function sendPoAction(input: { poId: string; reason?: string }, idempotencyKey: string): Promise<PoOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await sendToSupplier(ctx, input, idempotencyKey))
}

export async function cancelPoAction(input: { poId: string; disposition: 'RETURN_TO_POOL' | 'CANCEL_REQUEST_LINES'; reason: string }, idempotencyKey: string): Promise<PoOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await cancelPo(ctx, input, idempotencyKey))
}

export async function closePoAction(poId: string, idempotencyKey: string): Promise<PoOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await closePo(ctx, poId, idempotencyKey))
}
