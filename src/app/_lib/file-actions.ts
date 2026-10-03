'use server'

import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { completeUpload, getDownloadUrl, requestUpload } from '@/server/services/files'
import type { CompleteUploadResult, FileRefusal, RequestUploadResult } from '@/ui/files/file-upload'
import { getSession } from './session'

// Browser-facing adapters for file attachments (FR-PLT-004). Every call checks the session; the service checks the
// member and, for downloads, the document the file belongs to.

const REFUSALS: readonly FileRefusal[] = ['TYPE_NOT_ALLOWED', 'TOO_LARGE', 'EMPTY', 'CONTENT_MISMATCH']

function refusalOf(details: Record<string, unknown> | undefined): FileRefusal {
  const reason = details?.reason
  return typeof reason === 'string' && (REFUSALS as readonly string[]).includes(reason) ? (reason as FileRefusal) : 'FAILED'
}

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function requestUploadAction(input: { fileName: string; mimeType: string; sizeBytes: number }): Promise<RequestUploadResult> {
  const ctx = await currentCtx()
  if (!ctx) return { ok: false, reason: 'FAILED' }
  const r = await requestUpload(ctx, input)
  return r.ok ? { ok: true, uploadUrl: r.data.uploadUrl, ticket: r.data.ticket } : { ok: false, reason: refusalOf(r.error.details) }
}

export async function completeUploadAction(ticket: string): Promise<CompleteUploadResult> {
  const ctx = await currentCtx()
  if (!ctx) return { ok: false, reason: 'FAILED' }
  const r = await completeUpload(ctx, { ticket })
  return r.ok ? { ok: true, fileId: r.data.fileId, fileName: r.data.fileName } : { ok: false, reason: refusalOf(r.error.details) }
}

export async function downloadUrlAction(fileId: string): Promise<string | null> {
  const ctx = await currentCtx()
  if (!ctx) return null
  const r = await getDownloadUrl(ctx, { fileId })
  return r.ok ? r.data.url : null
}
