'use server'

import { revalidatePath } from 'next/cache'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { CatalogFailure, CatalogOutcome } from '@/ui/catalog/outcome'
import type { ItemEditInput, NewAgreementInput, NewItemInput } from '@/ui/catalog/types'
import { getSession } from '../../../_lib/session'
import { createAgreementFromScreen, createItemFromScreen, endAgreementFromScreen, updateItemFromScreen } from './commands'

// Browser-facing adapters of /catalog/manage (S6-10 · FR-INT-102 AC3). Each one builds ctx from the session and hands
// the browser's arguments, unread, to ./commands.ts, which parses them and calls a service; the service checks
// catalog.manage (PROCUREMENT) and every rule again (BR-AUTH-05): hiding a form is never the guard. The idempotencyKey
// comes from the form (spec §4.3), so a double click or a retry runs the command once (INV-PLT-01).

const NO_SESSION: CatalogFailure = { ok: false, code: 'UNAUTHENTICATED' }

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

function refreshed<T extends CatalogOutcome>(outcome: T): T {
  if (outcome.ok) {
    revalidatePath('/catalog')
    revalidatePath('/catalog/manage')
  }
  return outcome
}

export async function createCatalogItemAction(input: NewItemInput, idempotencyKey: string): Promise<CatalogOutcome<{ catalogItemId: string }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await createItemFromScreen(ctx, input, idempotencyKey))
}

export async function updateCatalogItemAction(input: ItemEditInput, idempotencyKey: string): Promise<CatalogOutcome<{ catalogItemId: string }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await updateItemFromScreen(ctx, input, idempotencyKey))
}

export async function createPriceAgreementAction(input: NewAgreementInput, idempotencyKey: string): Promise<CatalogOutcome<{ priceAgreementId: string }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await createAgreementFromScreen(ctx, input, idempotencyKey))
}

export async function endPriceAgreementAction(input: { priceAgreementId: string }, idempotencyKey: string): Promise<CatalogOutcome<{ validTo: string }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await endAgreementFromScreen(ctx, input, idempotencyKey))
}
