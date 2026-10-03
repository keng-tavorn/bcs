'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { platformCtx } from '@/server/auth/session'
import { setModule } from '@/server/services/modules'
import { getTenant } from '@/server/services/platform/tenants'
import { toFailure, type AdminOutcome } from '@/ui/admin/outcome'
import { getPlatformSession } from '../../../../../_lib/session'

// Switch one module of a customer organization (FR-ADM-006 AC1 · FR-PLT-011 · BR-AUTH-08). The session must be an
// active platform admin with TOTP; the service checks that again and applies the §4.11 rules. The idempotencyKey
// comes from the form (spec §4.3), so the same submission sent twice switches the module once.
export async function setModuleAction(
  input: { organizationId: string; module: string; enabled: boolean; contractRef: string; reason: string },
  idempotencyKey: string,
): Promise<AdminOutcome> {
  const state = await getPlatformSession()
  if (state.kind !== 'platform-admin') return { ok: false, code: 'UNAUTHENTICATED' }
  if (!z.uuid().safeParse(idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
  const tenant = await getTenant(state.platformAdminId, input.organizationId)
  if (!tenant.ok) return toFailure(tenant.error)
  const ctx = platformCtx(state, tenant.data.id, systemClock.now())
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  // The module name comes from the browser as a plain string; the service's schema refuses unknown modules
  const result = await setModule(
    ctx,
    { module: input.module as Parameters<typeof setModule>[1]['module'], enabled: input.enabled, contractRef: input.contractRef, reason: input.reason },
    { idempotencyKey },
  )
  if (!result.ok) return toFailure(result.error)
  revalidatePath(`/platform/tenants/${tenant.data.id}/modules`)
  return { ok: true }
}
