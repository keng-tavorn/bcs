'use server'

import { revalidatePath } from 'next/cache'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { PayFailure, PayOutcome } from '@/ui/payments/outcome'
import { getSession } from '../../../_lib/session'
import {
  addDocumentsFor,
  cancelApprovedFor,
  cancelDraftFor,
  createRunFor,
  downloadFileFor,
  generateFileFor,
  markSentFor,
  recordResultsFor,
  regenerateFileFor,
  removeDocumentsFor,
  resendAdviceFor,
  revertSentFor,
  setFlagReasonFor,
  submitRunFor,
} from './commands'

// Browser-facing adapters of the payment run screens (S9-09). Each checks the session and hands the raw input to
// ./commands.ts, which parses it and runs the S9 service; the service checks the capability, module PAY and the run's
// state every time (BR-AUTH-05). The idempotencyKey comes from the form (spec §4.3), so the same submission sent twice
// runs once. A change refreshes the payment pages (and home, whose rows count what waits).

const NO_SESSION: PayFailure = { ok: false, code: 'UNAUTHENTICATED' }

type Command = (ctx: NonNullable<ReturnType<typeof ctxFromSession>>, input: unknown, idempotencyKey: unknown) => Promise<PayOutcome>

async function run(command: Command, input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return NO_SESSION
  const outcome = await command(ctx, input, idempotencyKey)
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}

export async function createRunAction(input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  return run(createRunFor, input, idempotencyKey)
}

export async function addDocumentsAction(input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  return run(addDocumentsFor, input, idempotencyKey)
}

export async function removeDocumentsAction(input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  return run(removeDocumentsFor, input, idempotencyKey)
}

export async function setFlagReasonAction(input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  return run(setFlagReasonFor, input, idempotencyKey)
}

export async function submitRunAction(input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  return run(submitRunFor, input, idempotencyKey)
}

export async function cancelDraftAction(input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  return run(cancelDraftFor, input, idempotencyKey)
}

export async function generateFileAction(input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  return run(generateFileFor, input, idempotencyKey)
}

export async function regenerateFileAction(input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  return run(regenerateFileFor, input, idempotencyKey)
}

/** A POST: writes the download, then answers an address made now (the page opens it at once) */
export async function downloadFileAction(input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  return run(downloadFileFor, input, idempotencyKey)
}

export async function markSentAction(input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  return run(markSentFor, input, idempotencyKey)
}

export async function revertSentAction(input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  return run(revertSentFor, input, idempotencyKey)
}

export async function cancelApprovedAction(input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  return run(cancelApprovedFor, input, idempotencyKey)
}

export async function recordResultsAction(input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  return run(recordResultsFor, input, idempotencyKey)
}

export async function resendAdviceAction(input: unknown, idempotencyKey: string): Promise<PayOutcome> {
  return run(resendAdviceFor, input, idempotencyKey)
}
