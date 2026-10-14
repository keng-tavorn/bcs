'use server'

import { revalidatePath } from 'next/cache'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { ApDoneOutcome, ApDraftOutcome, ApFailure, ApPollOutcome } from '@/ui/ap/list/outcome'
import { getSession } from '../../../_lib/session'
import { createApInvoiceFor, createFromInboxFor, ignoreEmailFor, pollInboxFor } from './ap-list-commands'

// Browser-facing adapters of the tier-2 invoice screens (S8-13: /finance/invoices/new and /finance/invoices/inbox).
// Each checks the session and hands the raw input to ./ap-list-commands.ts, which parses it and runs the S8 service; the
// service checks the capability and module PAY every time (BR-AUTH-05). The idempotencyKey comes from the form (spec
// §4.3), so the same submission sent twice runs once. The file of a new invoice travels by ./new/file/route.ts (a server
// action takes 1 MB at most).

const NO_SESSION: ApFailure = { ok: false, code: 'UNAUTHENTICATED' }

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function createApInvoiceAction(input: { poId: string; sourceFileId: string | null }, idempotencyKey: string): Promise<ApDraftOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const outcome = await createApInvoiceFor(ctx, input, idempotencyKey)
  if (outcome.ok) revalidatePath('/finance/invoices', 'layout')
  return outcome
}

export async function pollInboxAction(): Promise<ApPollOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const outcome = await pollInboxFor(ctx)
  if (outcome.ok) revalidatePath('/finance/invoices', 'layout')
  return outcome
}

export async function ignoreEmailAction(input: { inboundEmailId: string; reason: string }, idempotencyKey: string): Promise<ApDoneOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const outcome = await ignoreEmailFor(ctx, input, idempotencyKey)
  if (outcome.ok) revalidatePath('/finance/invoices/inbox')
  return outcome
}

export async function createFromInboxAction(input: { inboundEmailId: string; fileId: string; poId: string }, idempotencyKey: string): Promise<ApDraftOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const outcome = await createFromInboxFor(ctx, input, idempotencyKey)
  if (outcome.ok) revalidatePath('/finance/invoices', 'layout')
  return outcome
}
