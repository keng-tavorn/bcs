'use server'

import { isDocumentFile } from '@/server/queries/document-files'
import { completeUpload, getDownloadUrl, requestUpload } from '@/server/services/files'
import type { CompleteUploadResult, FileRefusal, RequestUploadResult } from '@/ui/files/file-upload'
import type { LiffNoSession } from '@/ui/liff/receiving/photo-upload'
import type { PostOutcome, PreviewOutcome, ReceivingFailure } from '@/ui/receiving/outcome'
import type { ReceiptInput } from '@/ui/receiving/types'
import { postReceipt, previewReceipt } from '../../../(workspace)/receiving/commands'
import { liffPage } from '../../_lib/session'

// Browser-facing adapters of /liff/gr/[poId] (S5-06, FR-LINE-003 AC3, FR-P2P-006, FR-P2P-007). Each reads the session of
// the LIFF page — a LINE sign-in or a password sign-in inside LINE, with the LIFF idle limit — and hands the raw input to
// the same code as the workspace's receiving page, on channel LIFF: the receipt and its preview through
// src/app/(workspace)/receiving/commands.ts (parsed there, then gr.post with BR-SOD-02 and BR-SOD-07 checked by the
// service every time, BR-AUTH-05), the photos through the file service's presigned upload (FR-PLT-004, NFR-SEC-08), and
// a photo's address only for a photo of this PO's receipts, after the service checks the reader may see its receipt
// (FR-PLT-004 AC2). A hidden button is never the guard. The idempotency key comes from the page (spec §4.3). Without a
// member session nothing is done, and the answer says the session ended (the page says so, rather than blaming the
// connection). Nothing here logs what the person sent.

const NO_SESSION: ReceivingFailure = { ok: false, code: 'UNAUTHENTICATED' }
const NO_UPLOAD_SESSION: LiffNoSession = { ok: false, reason: 'UNAUTHENTICATED' }
const UPLOAD_REFUSALS: readonly FileRefusal[] = ['TYPE_NOT_ALLOWED', 'TOO_LARGE', 'EMPTY', 'CONTENT_MISMATCH']

/** The service context of the LIFF page's member (channel LIFF), or null without one */
async function memberCtx() {
  const page = await liffPage()
  return page.kind === 'member' ? page.ctx : null
}

function uploadRefusal(details: Readonly<Record<string, unknown>> | undefined): FileRefusal {
  const reason = details?.reason
  return typeof reason === 'string' && (UPLOAD_REFUSALS as readonly string[]).includes(reason) ? (reason as FileRefusal) : 'FAILED'
}

/** What the receipt will do, before it is posted (§9.9 principle 3); a refusal by separation of duties is recorded once */
export async function previewLiffReceiptAction(input: Omit<ReceiptInput, 'deliveryNoteNo' | 'notes'>, idempotencyKey: string): Promise<PreviewOutcome> {
  const ctx = await memberCtx()
  if (!ctx) return NO_SESSION
  return previewReceipt(ctx, input, idempotencyKey)
}

/** Posts the receipt (gr.post) on channel LIFF; the page then shows it with its photos */
export async function postLiffReceiptAction(input: ReceiptInput, idempotencyKey: string): Promise<PostOutcome> {
  const ctx = await memberCtx()
  if (!ctx) return NO_SESSION
  return postReceipt(ctx, input, idempotencyKey)
}

/** Step 1 of a photo's upload: a short-lived PUT address bound to the declared type and size */
export async function requestLiffUploadAction(input: { fileName: string; mimeType: string; sizeBytes: number }): Promise<RequestUploadResult | LiffNoSession> {
  const ctx = await memberCtx()
  if (!ctx) return NO_UPLOAD_SESSION
  const started = await requestUpload(ctx, input)
  return started.ok ? { ok: true, uploadUrl: started.data.uploadUrl, ticket: started.data.ticket } : { ok: false, reason: uploadRefusal(started.error.details) }
}

/** Step 3: the server reads the photo back (size, magic bytes, sha256) and records it, or deletes it */
export async function completeLiffUploadAction(ticket: string): Promise<CompleteUploadResult | LiffNoSession> {
  const ctx = await memberCtx()
  if (!ctx) return NO_UPLOAD_SESSION
  const done = await completeUpload(ctx, { ticket })
  return done.ok ? { ok: true, fileId: done.data.fileId, fileName: done.data.fileName } : { ok: false, reason: uploadRefusal(done.error.details) }
}

/**
 * A photo of one of the PO's receipts, as the page lists them: an address valid five minutes, for a member the file
 * service lets see that receipt (its receiver and the approvers of its variances, whoever may view the PO, whoever may
 * receive on it). Only a file linked to a goods receipt of this PO: through this page a LINE sign-in reaches no other
 * file of the organization (defence in depth, src/server/queries/document-files.ts). Null otherwise, or without a
 * session. The page binds the PO's id (receiptPhotoUrlAction.bind(null, poId)); both ids come from the browser, so both
 * are checked here.
 */
export async function receiptPhotoUrlAction(poId: string, fileId: string): Promise<string | null> {
  const ctx = await memberCtx()
  if (!ctx || typeof poId !== 'string' || typeof fileId !== 'string') return null
  if (!(await isDocumentFile(ctx, { subjectType: 'PO_RECEIPTS', subjectId: poId }, fileId))) return null
  const url = await getDownloadUrl(ctx, { fileId })
  return url.ok ? url.data.url : null
}
