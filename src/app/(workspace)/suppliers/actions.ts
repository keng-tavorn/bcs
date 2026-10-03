'use server'

import { revalidatePath } from 'next/cache'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getDownloadUrl } from '@/server/services/files'
import type { SupplierFailure, SupplierOutcome } from '@/ui/suppliers/outcome'
import type { NewSupplierInput, RegistryCheckView, SupplierEditInput } from '@/ui/suppliers/types'
import { getSession } from '../../_lib/session'
import { checkSupplier, createSupplierFromScreen, updateSupplierFromScreen } from './commands'

// Browser-facing adapters of the supplier screens (S4-02, FR-SUP-001). Each one builds ctx from the session and hands
// the browser's arguments, unread, to ./commands.ts, which parses them and calls a service; the service checks
// supplier.manage (PROCUREMENT) and every rule again (BR-AUTH-05): hiding a form is never the guard. The idempotencyKey
// comes from the form (spec §4.3), so a double click or a retry runs the command once (INV-PLT-01). Checking the
// registries writes nothing; it is a POST only because server actions are.

const NO_SESSION: SupplierFailure = { ok: false, code: 'UNAUTHENTICATED' }

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

/** FR-SUP-001 AC1: what the Revenue Department and DBD say about a tax id and branch (stub mode locally and in the demo) */
export async function checkSupplierAction(input: { taxId: string; branchCode: string }): Promise<SupplierOutcome<{ check: RegistryCheckView }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return checkSupplier(ctx, input)
}

/** "บันทึกผู้ขาย": the server checks the registries again and keeps what they said, or records the person's proof */
export async function createSupplierAction(input: NewSupplierInput, idempotencyKey: string): Promise<SupplierOutcome<{ supplierId: string }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const outcome = await createSupplierFromScreen(ctx, input, idempotencyKey)
  if (outcome.ok) revalidatePath('/suppliers')
  return outcome
}

/** One of the edit forms of /suppliers/[id], or deactivating and activating again (status), against the version seen */
export async function updateSupplierAction(input: SupplierEditInput, idempotencyKey: string): Promise<SupplierOutcome<{ version: number }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const outcome = await updateSupplierFromScreen(ctx, input, idempotencyKey)
  if (!outcome.ok) return outcome
  revalidatePath('/suppliers')
  revalidatePath(`/suppliers/${outcome.supplierId}`)
  return { ok: true, version: outcome.version }
}

/** FR-PLT-004 AC2: a short-lived address of a supplier's proof, for those who see the register in full */
export async function supplierProofUrlAction(fileId: string): Promise<string | null> {
  const ctx = await currentCtx()
  if (!ctx) return null
  const result = await getDownloadUrl(ctx, { fileId: typeof fileId === 'string' ? fileId : '' })
  return result.ok ? result.data.url : null
}
