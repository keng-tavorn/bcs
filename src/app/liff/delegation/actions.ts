'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { revokeDelegation } from '@/server/services/delegations'
import { createDelegationForDays } from '@/server/services/delegations/view'
import type { DelegationInputView } from '@/ui/delegation/delegation-form'
import { toDelegationFailure, type DelegationOutcome } from '@/ui/delegation/outcome'
import { liffPage } from '../_lib/session'

// Browser-facing adapters of /liff/delegation (S5-06, FR-DOA-006 AC2 LIFF part, BR-DLG-01 to BR-DLG-03). Each reads the
// session of the LIFF page and hands the raw input to the same services as the workspace's /settings/delegation, on
// channel LIFF: createDelegationForDays and revokeDelegation check delegation.manage (the member's own delegations only)
// and every rule again (BR-AUTH-05), so a hidden button is never the guard; each change is a command with its Event
// (delegation.created, delegation.revoked). The idempotency key comes from the page (spec §4.3).

const NO_SESSION: DelegationOutcome = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: DelegationOutcome = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const SubmissionKey = z.uuid()
const PAGE = '/liff/delegation'

function done(result: { ok: true } | { ok: false; error: { code: string; details?: Readonly<Record<string, unknown>> } }): DelegationOutcome {
  if (!result.ok) return toDelegationFailure(result.error)
  // The page shows the member's delegations as they are now
  revalidatePath(PAGE)
  return { ok: true }
}

/** Names an acting approver for whole days (createDelegationForDays, then BR-DLG-01..03 in createDelegation) */
export async function createLiffDelegationAction(input: DelegationInputView, idempotencyKey: string): Promise<DelegationOutcome> {
  const page = await liffPage()
  if (page.kind !== 'member') return NO_SESSION
  if (!SubmissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  return done(await createDelegationForDays(page.ctx, input, { idempotencyKey }))
}

/** Cancels one of the member's own running or coming delegations (an ended one is refused by the service) */
export async function revokeLiffDelegationAction(delegationId: string, idempotencyKey: string): Promise<DelegationOutcome> {
  const page = await liffPage()
  if (page.kind !== 'member') return NO_SESSION
  if (!SubmissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  if (!z.uuid().safeParse(delegationId).success) return { ok: false, code: 'NOT_FOUND' }
  return done(await revokeDelegation(page.ctx, { delegationId }, { idempotencyKey }))
}
