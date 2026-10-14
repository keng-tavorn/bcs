'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { updateAgentSetting } from '@/server/services/ai'
import { toFailure, type AdminOutcome } from '@/ui/admin/outcome'
import { getSession } from '../../../_lib/session'

// Browser-facing adapter for /admin/ai (docs/sub-specs/S13.md "ฐานของโมดูล" AC1): checks the session; the service
// checks admin.ai.manage and the version the screen showed (BR-AUTH-05). The idempotencyKey comes from the form (§4.3).
export async function updateAgentAction(
  input: { agent: string; enabled?: boolean; minConfidenceBp?: number; expectedVersion?: number },
  idempotencyKey: string,
): Promise<AdminOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (!z.uuid().safeParse(idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
  // The agent arrives as a plain string; the service's schema refuses an unknown one
  const result = await updateAgentSetting(ctx, { ...input, agent: input.agent as Parameters<typeof updateAgentSetting>[1]['agent'] }, { idempotencyKey })
  if (!result.ok) return toFailure(result.error)
  revalidatePath('/admin/ai')
  return { ok: true }
}
