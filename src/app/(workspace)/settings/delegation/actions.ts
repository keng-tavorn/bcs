'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { revokeDelegation } from '@/server/services/delegations'
import { createDelegationForDays } from '@/server/services/delegations/view'
import type { DelegationInputView } from '@/ui/delegation/delegation-form'
import { toDelegationFailure, type DelegationOutcome } from '@/ui/delegation/outcome'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters for /settings/delegation (NEW-06, FR-DOA-006 AC2 web). Each checks the session; the services
// check delegation.manage (own delegations only) and BR-DLG-01..03 every time (BR-AUTH-05).

const NO_SESSION: DelegationOutcome = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: DelegationOutcome = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const submissionKey = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

function done(result: { ok: true } | { ok: false; error: { code: string; details?: Readonly<Record<string, unknown>> } }): DelegationOutcome {
  if (!result.ok) return toDelegationFailure(result.error)
  revalidatePath('/settings/delegation')
  return { ok: true }
}

export async function createDelegationAction(input: DelegationInputView, idempotencyKey: string): Promise<DelegationOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  return done(await createDelegationForDays(ctx, input, { idempotencyKey }))
}

export async function revokeDelegationAction(delegationId: string, idempotencyKey: string): Promise<DelegationOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  if (!z.uuid().safeParse(delegationId).success) return { ok: false, code: 'NOT_FOUND' }
  return done(await revokeDelegation(ctx, { delegationId }, { idempotencyKey }))
}
