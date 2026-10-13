'use server'

import { revalidatePath } from 'next/cache'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { ApFailure, ApOutcome } from '@/ui/ap/invoice/outcome'
import { getSession } from '../../../../_lib/session'
import {
  cancelApInvoiceFor,
  confirmApCodingFor,
  dismissApExceptionFor,
  recheckApInvoiceFor,
  rejectApInvoiceFor,
  reopenApInvoiceFor,
  requestApVarianceFor,
  submitApInvoiceFor,
  updateApInvoiceFor,
} from './ap-commands'

// Browser-facing adapters of the tier-2 invoice page and PROCUREMENT's list of differences (S8-13). Each checks the
// session and hands the raw input to ./ap-commands.ts, which parses it and runs the S8 service; the service checks the
// capability every time (BR-AUTH-05). The idempotencyKey comes from the form (spec §4.3), so the same submission sent
// twice runs once. A change refreshes every page: the finance lists, the PO, the tasks and home all show invoices.

const NO_SESSION: ApFailure = { ok: false, code: 'UNAUTHENTICATED' }

type Command = (ctx: NonNullable<ReturnType<typeof ctxFromSession>>, input: unknown, idempotencyKey: unknown) => Promise<ApOutcome>

async function run(command: Command, input: unknown, idempotencyKey: string): Promise<ApOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return NO_SESSION
  const outcome = await command(ctx, input, idempotencyKey)
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}

export async function updateApInvoiceAction(input: unknown, idempotencyKey: string): Promise<ApOutcome> {
  return run(updateApInvoiceFor, input, idempotencyKey)
}
export async function confirmApCodingAction(input: unknown, idempotencyKey: string): Promise<ApOutcome> {
  return run(confirmApCodingFor, input, idempotencyKey)
}
export async function submitApInvoiceAction(input: unknown, idempotencyKey: string): Promise<ApOutcome> {
  return run(submitApInvoiceFor, input, idempotencyKey)
}
export async function cancelApInvoiceAction(input: unknown, idempotencyKey: string): Promise<ApOutcome> {
  return run(cancelApInvoiceFor, input, idempotencyKey)
}
export async function recheckApInvoiceAction(input: unknown, idempotencyKey: string): Promise<ApOutcome> {
  return run(recheckApInvoiceFor, input, idempotencyKey)
}
export async function reopenApInvoiceAction(input: unknown, idempotencyKey: string): Promise<ApOutcome> {
  return run(reopenApInvoiceFor, input, idempotencyKey)
}
export async function rejectApInvoiceAction(input: unknown, idempotencyKey: string): Promise<ApOutcome> {
  return run(rejectApInvoiceFor, input, idempotencyKey)
}
export async function dismissApExceptionAction(input: unknown, idempotencyKey: string): Promise<ApOutcome> {
  return run(dismissApExceptionFor, input, idempotencyKey)
}
export async function requestApVarianceAction(input: unknown, idempotencyKey: string): Promise<ApOutcome> {
  return run(requestApVarianceFor, input, idempotencyKey)
}
