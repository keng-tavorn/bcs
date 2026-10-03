'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { createBudgetGrantForDays, revokeBudgetGrant } from '@/server/services/budget/grants'
import type { GrantInputView } from '@/ui/budgets/grant-form'
import { toBudgetFailure, type BudgetFailure, type GrantOutcome } from '@/ui/budgets/outcome'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters of /budgets/grants (FR-BUD-004 AC1). Each checks the session; the services check
// budgetGrant.manage (BUDGET_ADMIN) and the grant's rules every time (BR-AUTH-05). The idempotencyKey comes from the form
// (spec §4.3), so the same submission sent twice grants or revokes once.

const NO_SESSION: BudgetFailure = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: BudgetFailure = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const submissionKey = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

function done(result: { ok: true } | { ok: false; error: { code: string; details?: Readonly<Record<string, unknown>> } }): GrantOutcome {
  if (!result.ok) return toBudgetFailure(result.error)
  revalidatePath('/budgets', 'layout')
  return { ok: true }
}

export async function createBudgetGrantAction(input: GrantInputView, idempotencyKey: string): Promise<GrantOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  return done(await createBudgetGrantForDays(ctx, input, { idempotencyKey }))
}

export async function revokeBudgetGrantAction(grantId: string, idempotencyKey: string): Promise<GrantOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  if (!z.uuid().safeParse(grantId).success) return { ok: false, code: 'NOT_FOUND' }
  return done(await revokeBudgetGrant(ctx, { grantId }, { idempotencyKey }))
}
