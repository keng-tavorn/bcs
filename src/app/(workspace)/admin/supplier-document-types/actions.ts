'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { deactivateSupplierDocumentType, upsertSupplierDocumentType } from '@/server/services/suppliers/documents'
import type { DocumentTypeInput, TypeActionResult } from '@/ui/supplier-docs/types-form'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters of /admin/supplier-document-types (S7-06 · BR-SDOC ข้อ 01): the services check
// admin.supplierDocumentTypes and the module every time; a refusal comes back as its code only.

const submissionKey = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function saveDocumentTypeAction(input: DocumentTypeInput, idempotencyKey: string): Promise<TypeActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return { ok: false, code: 'FORBIDDEN' }
  if (!submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED' }
  const r = await upsertSupplierDocumentType(ctx, input, { idempotencyKey })
  if (!r.ok) return { ok: false, code: r.error.code }
  revalidatePath('/admin/supplier-document-types')
  return { ok: true }
}

export async function closeDocumentTypeAction(code: string, idempotencyKey: string): Promise<TypeActionResult> {
  const ctx = await currentCtx()
  if (!ctx) return { ok: false, code: 'FORBIDDEN' }
  if (!submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED' }
  const r = await deactivateSupplierDocumentType(ctx, { code }, { idempotencyKey })
  if (!r.ok) return { ok: false, code: r.error.code }
  revalidatePath('/admin/supplier-document-types')
  return { ok: true }
}
