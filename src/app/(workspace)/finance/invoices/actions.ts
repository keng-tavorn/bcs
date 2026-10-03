'use server'

import { revalidatePath } from 'next/cache'
import { getLocale } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { FinanceFailure, PreviewOutcome, RecordOutcome } from '@/ui/finance/outcome'
import type { InvoiceFormInput } from '@/ui/finance/types'
import { getSession } from '../../../_lib/session'
import { localeOf } from '../../_tracking/present'
import { previewInvoiceFor, recordInvoiceFor } from './commands'

// Browser-facing adapters of the invoice page (S4-08, FR-P2P-008). Each checks the session and hands the raw input to
// ./commands.ts, which parses it and runs the service; the service checks invoiceConfirmation.record every time
// (BR-AUTH-05). The idempotencyKey comes from the form (spec §4.3), so the same submission sent twice records once.

const NO_SESSION: FinanceFailure = { ok: false, code: 'UNAUTHENTICATED' }

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function previewInvoiceAction(input: InvoiceFormInput): Promise<PreviewOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return previewInvoiceFor(ctx, input, localeOf(await getLocale()))
}

export async function recordInvoiceAction(input: InvoiceFormInput, idempotencyKey: string): Promise<RecordOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const outcome = await recordInvoiceFor(ctx, input, idempotencyKey)
  // The finance lists, the PO, the budget dashboard and home all change after an invoice
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}
