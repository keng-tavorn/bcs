'use server'

import { revalidatePath } from 'next/cache'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { CloseShortOutcome, PostOutcome, PreviewOutcome, ReceivingFailure } from '@/ui/receiving/outcome'
import type { ReceiptInput } from '@/ui/receiving/types'
import { getSession } from '../../_lib/session'
import { closeShort, postReceipt, previewReceipt } from './commands'

// Browser-facing adapters of the receiving page (FR-P2P-006, FR-P2P-007, FR-P2P-010 AC2). Each checks the session and
// hands the raw input to ./commands.ts, which parses it and runs the service; the service checks gr.post (with
// separation of duties) or po.close every time (BR-AUTH-05). The idempotencyKey comes from the form (spec §4.3), so the
// same submission sent twice posts once — and a check refused by separation of duties is recorded once (FR-DOA-007 AC2).

const NO_SESSION: ReceivingFailure = { ok: false, code: 'UNAUTHENTICATED' }

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

/** The receiving list, the PO, the home page and the bell all change after a receipt */
function refreshed<T extends { ok: boolean }>(outcome: T): T {
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}

export async function previewReceiptAction(input: Omit<ReceiptInput, 'deliveryNoteNo' | 'notes'>, idempotencyKey: string): Promise<PreviewOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return previewReceipt(ctx, input, idempotencyKey)
}

export async function postReceiptAction(input: ReceiptInput, idempotencyKey: string): Promise<PostOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await postReceipt(ctx, input, idempotencyKey))
}

export async function closeShortAction(input: { poId: string; reason: string; confirmed: boolean }, idempotencyKey: string): Promise<CloseShortOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await closeShort(ctx, input, idempotencyKey))
}
