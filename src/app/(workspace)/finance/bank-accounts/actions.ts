'use server'

import { revalidatePath } from 'next/cache'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { BankFailure, BankOutcome, RevealOutcome } from '@/ui/bank-accounts/outcome'
import { getSession } from '../../../_lib/session'
import { attachProofFor, cancelChangeFor, createChangeFor, detachProofFor, recordCallFor, revealAccountFor, revealChangeFor, submitChangeFor, updateChangeFor } from './commands'

// Browser-facing adapters of the bank-account screens (S9-09: /finance/bank-accounts, a request's page and the
// supplier's card). Each checks the session and hands the raw input to ./commands.ts, which parses it and runs the S9-04
// service; the service checks the capability, the proposer and module PAY every time (BR-AUTH-05). The idempotencyKey
// comes from the form (spec §4.3), so the same submission sent twice runs once. A change refreshes every page: the
// list, the request, the supplier, the tasks and home all show requests. Opening a number whole changes no page.

const NO_SESSION: BankFailure = { ok: false, code: 'UNAUTHENTICATED' }

type Ctx = NonNullable<ReturnType<typeof ctxFromSession>>
type Command = (ctx: Ctx, input: unknown, idempotencyKey: unknown) => Promise<BankOutcome>

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

async function run(command: Command, input: unknown, idempotencyKey: string): Promise<BankOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const outcome = await command(ctx, input, idempotencyKey)
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}

export async function createChangeAction(input: unknown, idempotencyKey: string): Promise<BankOutcome> {
  return run(createChangeFor, input, idempotencyKey)
}
export async function updateChangeAction(input: unknown, idempotencyKey: string): Promise<BankOutcome> {
  return run(updateChangeFor, input, idempotencyKey)
}
export async function recordCallAction(input: unknown, idempotencyKey: string): Promise<BankOutcome> {
  return run(recordCallFor, input, idempotencyKey)
}
export async function attachProofAction(input: unknown, idempotencyKey: string): Promise<BankOutcome> {
  return run(attachProofFor, input, idempotencyKey)
}
export async function detachProofAction(input: unknown, idempotencyKey: string): Promise<BankOutcome> {
  return run(detachProofFor, input, idempotencyKey)
}
export async function submitChangeAction(input: unknown, idempotencyKey: string): Promise<BankOutcome> {
  return run(submitChangeFor, input, idempotencyKey)
}
export async function cancelChangeAction(input: unknown, idempotencyKey: string): Promise<BankOutcome> {
  return run(cancelChangeFor, input, idempotencyKey)
}

/** The numbers of a request whole, for the member who asked; logged by the service */
export async function revealChangeAction(input: unknown): Promise<RevealOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return revealChangeFor(ctx, input)
}

/** An account's number whole, for the member who asked; logged by the service */
export async function revealAccountAction(input: unknown): Promise<RevealOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return revealAccountFor(ctx, input)
}
