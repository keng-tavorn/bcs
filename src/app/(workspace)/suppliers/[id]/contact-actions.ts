'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { createSupplierContact, deactivateSupplierContact, revokeSupplierContactSessions, updateSupplierContact } from '@/server/services/suppliers/contacts'
import type { ContactActionResult, NewContactInput } from '@/ui/suppliers/contacts-panel'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters of the contacts and portal tabs on /suppliers/[id] (S7-09 · S7-04 commands · BR-SUP ข้อ 17 ·
// BR-PORTAL ข้อ 03): the services check module SUPPLIER and supplier.contact.manage every time; these only carry the
// form's words and the submission's idempotency key, and answer the refusal's code (and reason) for the screen's words.

const submissionKey = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

function answer(r: { ok: true } | { ok: false; error: { code: string; details?: Readonly<Record<string, unknown>> } }): ContactActionResult {
  if (r.ok) {
    revalidatePath('/suppliers')
    return { ok: true }
  }
  const reason = r.error.details?.reason
  return { ok: false, code: r.error.code, ...(typeof reason === 'string' ? { reason } : {}) }
}

const blank = (s: string) => (s.trim() === '' ? null : s.trim())

export async function addContactAction(supplierId: string, input: NewContactInput, idempotencyKey: string): Promise<ContactActionResult> {
  const ctx = await currentCtx()
  if (!ctx || !submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'FORBIDDEN' }
  const r = await createSupplierContact(
    ctx,
    { supplierId, nameTh: input.nameTh, nameEn: blank(input.nameEn), email: input.email, phone: blank(input.phone), roleLabel: blank(input.roleLabel), isPrimary: input.isPrimary, locale: input.locale },
    { idempotencyKey },
  )
  return answer(r)
}

export async function deactivateContactAction(contactId: string, version: number, idempotencyKey: string): Promise<ContactActionResult> {
  const ctx = await currentCtx()
  if (!ctx || !submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'FORBIDDEN' }
  return answer(await deactivateSupplierContact(ctx, { contactId, expectedVersion: version }, { idempotencyKey }))
}

export async function revokeContactSessionsAction(contactId: string, idempotencyKey: string): Promise<ContactActionResult> {
  const ctx = await currentCtx()
  if (!ctx || !submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'FORBIDDEN' }
  return answer(await revokeSupplierContactSessions(ctx, { contactId }, { idempotencyKey }))
}

/** One contact allowed on the portal or not; taking it away ends their sessions in the same transaction (BR-PORTAL ข้อ 03) */
export async function setContactPortalAction(contactId: string, version: number, portalEnabled: boolean, idempotencyKey: string): Promise<ContactActionResult> {
  const ctx = await currentCtx()
  if (!ctx || !submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'FORBIDDEN' }
  return answer(await updateSupplierContact(ctx, { contactId, expectedVersion: version, portalEnabled }, { idempotencyKey }))
}

/** Another contact becomes the one the supplier's notices go to; the one before steps down in the same command */
export async function makePrimaryContactAction(contactId: string, version: number, idempotencyKey: string): Promise<ContactActionResult> {
  const ctx = await currentCtx()
  if (!ctx || !submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'FORBIDDEN' }
  return answer(await updateSupplierContact(ctx, { contactId, expectedVersion: version, isPrimary: true }, { idempotencyKey }))
}
