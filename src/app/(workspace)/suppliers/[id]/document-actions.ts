'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { rejectSupplierDocument, requestSupplierDocumentDownload, verifySupplierDocument } from '@/server/services/suppliers/documents'
import type { DocumentActionResult } from '@/ui/supplier-docs/documents-panel'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters of the documents panel on /suppliers/[id] (S7-06 · BR-SDOC ข้อ 03 ข้อ 05): the services check
// supplier.document.verify or .view (and .viewSensitive with its log) every time. Opening a file is this POST, never a GET.

const submissionKey = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function verifyDocumentAction(documentId: string, version: number, idempotencyKey: string): Promise<DocumentActionResult> {
  const ctx = await currentCtx()
  if (!ctx || !submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'FORBIDDEN' }
  const r = await verifySupplierDocument(ctx, { documentId, expectedVersion: version }, { idempotencyKey })
  if (!r.ok) return { ok: false, code: r.error.code }
  revalidatePath('/suppliers')
  return { ok: true }
}

export async function rejectDocumentAction(documentId: string, version: number, reason: string, idempotencyKey: string): Promise<DocumentActionResult> {
  const ctx = await currentCtx()
  if (!ctx || !submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'FORBIDDEN' }
  const r = await rejectSupplierDocument(ctx, { documentId, expectedVersion: version, reason }, { idempotencyKey })
  if (!r.ok) return { ok: false, code: r.error.code }
  revalidatePath('/suppliers')
  return { ok: true }
}

export async function openDocumentAction(documentId: string, idempotencyKey: string): Promise<DocumentActionResult> {
  const ctx = await currentCtx()
  if (!ctx || !submissionKey.safeParse(idempotencyKey).success) return { ok: false, code: 'FORBIDDEN' }
  const r = await requestSupplierDocumentDownload(ctx, { documentId }, { idempotencyKey })
  return r.ok ? { ok: true, url: r.data.url } : { ok: false, code: r.error.code }
}
