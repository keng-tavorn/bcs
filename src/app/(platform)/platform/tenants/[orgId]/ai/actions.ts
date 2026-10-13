'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { platformCtx } from '@/server/auth/session'
import { grantCredits } from '@/server/services/ai'
import { getTenant } from '@/server/services/platform/tenants'
import { toFailure, type AdminOutcome } from '@/ui/admin/outcome'
import { getPlatformSession } from '../../../../../_lib/session'

// AI credits of one customer (docs/sub-specs/S13.md "ฐานของโมดูล" AC2, BR-AI-23): a top-up and/or the monthly amount,
// always with a contract reference and a reason. The session must be an active platform admin with TOTP; the service
// checks that again (platform.ai.credits) and never shows business data. The idempotencyKey comes from the form (§4.3).
export async function grantCreditsAction(
  input: { organizationId: string; topUpCredits?: number; monthlyCredits?: number; contractRef: string; reason: string },
  idempotencyKey: string,
): Promise<AdminOutcome> {
  const state = await getPlatformSession()
  if (state.kind !== 'platform-admin') return { ok: false, code: 'UNAUTHENTICATED' }
  if (!z.uuid().safeParse(idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
  const tenant = await getTenant(state.platformAdminId, input.organizationId)
  if (!tenant.ok) return toFailure(tenant.error)
  const ctx = platformCtx(state, tenant.data.id, systemClock.now())
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  const { organizationId: _org, ...grant } = input
  const result = await grantCredits(ctx, grant, { idempotencyKey })
  if (!result.ok) return toFailure(result.error)
  revalidatePath(`/platform/tenants/${tenant.data.id}/ai`)
  return { ok: true }
}
