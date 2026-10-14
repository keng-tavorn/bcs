'use server'

import { revalidatePath } from 'next/cache'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { ChangePreviewOutcome, PoS8Outcome } from '@/ui/po-change/outcome'
import { getSession } from '../../../../_lib/session'
import { cancelChangeFor, createChangeFor, previewChangeFor, sendRevisionFor, setMilestonesFor, setRetentionFor, submitChangeFor } from './s8-commands'

// Browser-facing adapters of what S8 adds to the purchase-order page and its change page (S8-13). Each checks the
// session and hands the raw input to ./s8-commands.ts, which parses it and runs the service; the service checks the
// capability again (BR-AUTH-05), so a hidden button is never the guard. The idempotencyKey comes from the form
// (spec §4.3), so the same submission sent twice runs once — and a revision goes to the supplier once.

const NO_SESSION = { ok: false, code: 'UNAUTHENTICATED' } as const

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

/** The PO, the lists, the tasks and home all change after these */
function refreshed(outcome: PoS8Outcome): PoS8Outcome {
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}

export async function setMilestonesAction(input: { poId: string; expectedVersion: number; poLineId: string; shares: string[] }, idempotencyKey: string): Promise<PoS8Outcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await setMilestonesFor(ctx, input, idempotencyKey))
}

export async function setRetentionAction(input: { poId: string; expectedVersion: number; retentionPercent: string; holdDays: string }, idempotencyKey: string): Promise<PoS8Outcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await setRetentionFor(ctx, input, idempotencyKey))
}

export async function sendRevisionAction(poId: string, idempotencyKey: string): Promise<PoS8Outcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await sendRevisionFor(ctx, poId, idempotencyKey))
}

export async function previewChangeAction(input: { poId: string; lines: Array<{ poLineId: string; newQuantity?: string; newUnitPrice?: string }> }): Promise<ChangePreviewOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return previewChangeFor(ctx, input)
}

export async function createChangeAction(
  input: {
    poId: string
    reason: string
    lines: Array<{ poLineId: string; newQuantity?: string; newUnitPrice?: string }>
    deliveryDate: string
    notesToSupplier: string
    quantityDisposition?: 'RETURN_TO_POOL' | 'CANCEL_REQUEST_LINES'
  },
  idempotencyKey: string,
): Promise<PoS8Outcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await createChangeFor(ctx, input, idempotencyKey))
}

export async function submitChangeAction(input: { poChangeId: string; version: number }, idempotencyKey: string): Promise<PoS8Outcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await submitChangeFor(ctx, input, idempotencyKey))
}

export async function cancelChangeAction(input: { poChangeId: string; version: number; reason: string }, idempotencyKey: string): Promise<PoS8Outcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await cancelChangeFor(ctx, input, idempotencyKey))
}
