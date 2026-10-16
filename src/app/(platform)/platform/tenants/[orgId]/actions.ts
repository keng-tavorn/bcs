'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { platformCtx } from '@/server/auth/session'
import { createSandbox } from '@/server/services/platform/sandbox'
import { getTenant } from '@/server/services/platform/tenants'
import { toFailure } from '@/ui/admin/outcome'
import type { CreateSandboxOutcome } from '@/ui/admin/sandbox-form'
import { getPlatformSession } from '../../../../_lib/session'

// Make a UAT sandbox of a customer (S6-21 · FR-PLT-101 AC1 · BR-UAT-01 BR-UAT-04). The session must be an active
// platform admin with TOTP; the service checks that again, asks for the contract reference and the reason, refuses a
// sandbox of a sandbox, and copies nothing of the production organization but its settings with LINE off (NG-12). The
// idempotencyKey comes from the form (spec §4.3), so the same submission sent twice makes one sandbox.
export async function createSandboxAction(input: { organizationId: string; code: string; contractRef: string; reason: string }, idempotencyKey: string): Promise<CreateSandboxOutcome> {
  const state = await getPlatformSession()
  if (state.kind !== 'platform-admin') return { ok: false, code: 'UNAUTHENTICATED' }
  if (!z.uuid().safeParse(idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
  const tenant = await getTenant(state.platformAdminId, input.organizationId)
  if (!tenant.ok) return toFailure(tenant.error)
  const ctx = platformCtx(state, tenant.data.id, systemClock.now())
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  const result = await createSandbox(ctx, { code: input.code, contractRef: input.contractRef, reason: input.reason }, { idempotencyKey })
  if (!result.ok) return toFailure(result.error)
  revalidatePath('/platform/tenants', 'layout')
  return { ok: true, sandboxOrganizationId: result.data.sandboxOrganizationId, code: input.code }
}
