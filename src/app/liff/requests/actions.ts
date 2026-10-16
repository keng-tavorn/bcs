'use server'

import { getLocale } from 'next-intl/server'
import { z } from 'zod'
import { isDocumentFile, isOwnUnattachedUpload } from '@/server/queries/document-files'
import { doaGapNames, sentRequestSummary } from '@/server/queries/request-form'
import { getRequestAccess } from '@/server/queries/requests'
import { dismissChatIntake, draftFromChat } from '@/server/services/chat-intake'
import { completeUpload, getDownloadUrl, requestUpload } from '@/server/services/files'
import { editRequest, resubmitRequest, submitRequest } from '@/server/services/requests'
import { attachFile, detachFile } from '@/server/services/requests/attachments'
import { previewRequest } from '@/server/services/requests/preview'
import type { CompleteUploadResult, FileRefusal, RequestUploadResult } from '@/ui/files/file-upload'
import type { LiffChatOutcome } from '@/ui/liff/requests/chat-intake'
import { toFormFailure, type FormFailure, type FormOutcome } from '@/ui/request-form/outcome'
import type { PreviewRequestInput, PreviewView, SentView } from '@/ui/request-form/types'
import type { RepeatOutcome } from '@/ui/request-view/repeat-rules'
import type { ActionFailure, ActionOutcome } from '@/ui/tasks/outcome'
import { canViewRequest } from '../../(workspace)/_tracking/access'
import { answerQuestion, cancelOwnRequest, reorderOwnRequest, resubmitOwnRequest } from '../../(workspace)/_tracking/commands'
import { liffPage, type LiffPage } from '../_lib/session'
import { liffDraftHref } from './_lib/form'
import { liffPrincipalOf } from './_lib/principal'

// Browser-facing adapters of the LIFF request pages (S5-06, §9.4: /liff/requests/new and /liff/requests/[id]): the same
// services as the web's request form and request page (src/app/(workspace)/requests/new/actions.ts,
// src/app/_lib/file-actions.ts, src/app/(workspace)/requests/[id]/actions.ts), with the context of the LIFF
// page — its channel is LIFF, so every Event of a request made or sent here says so (FR-LINE-003 AC1, FR-DOA-005). Each
// reads the session of the LIFF page (a LIFF session, or a password sign-in, src/app/liff/_lib/session.ts) and hands the
// raw input to the service, which checks the member (request.create, request.submit OWN), the state and every rule
// again (BR-AUTH-05): what the screen hides or disables is never the guard. The idempotency key comes from the browser
// per submission (spec §4.3), so a double tap or a retry after a lost answer runs the command once. A file opens only
// through the request it belongs to, or as the member's own upload the form has not linked yet (downloadUrlAction).

const NO_SESSION: FormFailure = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: FormFailure = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const Key = z.uuid()
/** DOA gaps whose answer names the position and departments in words (FR-DOA-003 AC3) */
const DOA_GAPS: ReadonlySet<string> = new Set(['DOA_NOT_CONFIGURED', 'APPROVER_NOT_FOUND', 'NO_HIGHER_AUTHORITY', 'DOA_AMBIGUOUS', 'REVIEWER_NOT_FOUND'])
const FILE_REFUSALS: readonly FileRefusal[] = ['TYPE_NOT_ALLOWED', 'TOO_LARGE', 'EMPTY', 'CONTENT_MISMATCH']

type MemberPage = Extract<LiffPage, { kind: 'member' }>

async function memberCtx() {
  const page = await liffPage()
  return page.kind === 'member' ? page.ctx : null
}

async function screenLocale(): Promise<'th' | 'en'> {
  return (await getLocale()) === 'en' ? 'en' : 'th'
}

/** FR-INT-004 AC1, FR-DOA-003 AC2: the chosen line's balance and the expected route, without writing anything */
export async function previewRequestAction(input: PreviewRequestInput): Promise<FormOutcome<{ preview: PreviewView }>> {
  const ctx = await memberCtx()
  if (!ctx) return NO_SESSION
  // Browser input on its way to the service, whose Zod schema checks every part of it (a malformed one: VALIDATION_FAILED)
  const result = await previewRequest(ctx, input as unknown as Parameters<typeof previewRequest>[1], await screenLocale())
  return result.ok ? { ok: true, preview: result.data } : toFormFailure(result.error)
}

/**
 * "ส่งขออนุมัติ" from LIFF (FR-INT-007, FR-LINE-003 AC1): submit the draft the form saved, or send a returned request
 * again (FR-INT-009 AC2), naming the version the requester checked (FR-INT-006 AC2). Sent, the answer carries the number
 * and who decides it now, for the confirmation in the button's own words (§9.9 rule 7). The requester's reason for asking
 * again goes with it as duplicateReason once the form asked for it (S6-13 · BR-DUP-05: DUPLICATE_UNACKNOWLEDGED).
 */
export async function submitRequestAction(
  input: { requestId: string; expectedVersion: number; resubmit: boolean; duplicateReason?: string },
  idempotencyKey: string,
): Promise<FormOutcome<{ requestId: string; sent: SentView }>> {
  const ctx = await memberCtx()
  if (!ctx) return NO_SESSION
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const command = input?.resubmit === true ? resubmitRequest : submitRequest
  const duplicateReason = typeof input?.duplicateReason === 'string' ? { duplicateReason: input.duplicateReason } : {}
  const result = await command(ctx, { requestId: input?.requestId, expectedVersion: input?.expectedVersion, ...duplicateReason }, { idempotencyKey })
  const screen = await screenLocale()
  if (result.ok) {
    const sent = await sentRequestSummary(ctx, input.requestId, screen)
    return { ok: true, requestId: input.requestId, sent: sent ?? { number: null, waitingFor: [] } }
  }
  const failure = toFormFailure(result.error)
  if (DOA_GAPS.has(failure.code)) {
    const names = await doaGapNames(ctx, { position: failure.position ?? null, departments: failure.departments ?? [] }, screen)
    return { ...failure, ...(names.position ? { position: names.position } : {}), departments: names.departments }
  }
  return failure
}

/** FR-INT-005: a file the requester uploaded becomes an attachment of their draft, of one kind */
export async function attachFileAction(requestId: string, fileId: string, kind: string, idempotencyKey: string): Promise<FormOutcome> {
  const ctx = await memberCtx()
  if (!ctx) return NO_SESSION
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  // The kind comes from the browser as text; the service's schema refuses any that is not a FileLinkKind
  const result = await attachFile(ctx, { requestId, fileId, kind: kind as 'OTHER' }, { idempotencyKey })
  return result.ok ? { ok: true } : toFormFailure(result.error)
}

export async function detachFileAction(requestId: string, fileId: string, idempotencyKey: string): Promise<FormOutcome> {
  const ctx = await memberCtx()
  if (!ctx) return NO_SESSION
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const result = await detachFile(ctx, { requestId, fileId }, { idempotencyKey })
  return result.ok ? { ok: true } : toFormFailure(result.error)
}

function fileRefusalOf(details: Readonly<Record<string, unknown>> | undefined): FileRefusal {
  const reason = details?.reason
  return typeof reason === 'string' && (FILE_REFUSALS as readonly string[]).includes(reason) ? (reason as FileRefusal) : 'FAILED'
}

/** FR-PLT-004: a presigned upload straight to private storage (a photo from the phone's camera included, FR-INT-005 AC3) */
export async function requestUploadAction(input: { fileName: string; mimeType: string; sizeBytes: number }): Promise<RequestUploadResult> {
  const ctx = await memberCtx()
  if (!ctx) return { ok: false, reason: 'FAILED' }
  const r = await requestUpload(ctx, input)
  return r.ok ? { ok: true, uploadUrl: r.data.uploadUrl, ticket: r.data.ticket } : { ok: false, reason: fileRefusalOf(r.error.details) }
}

export async function completeUploadAction(ticket: string): Promise<CompleteUploadResult> {
  const ctx = await memberCtx()
  if (!ctx) return { ok: false, reason: 'FAILED' }
  const r = await completeUpload(ctx, { ticket })
  return r.ok ? { ok: true, fileId: r.data.fileId, fileName: r.data.fileName } : { ok: false, reason: fileRefusalOf(r.error.details) }
}

/**
 * A file of the request's LIFF page or of its form, at an address valid a few minutes (FR-PLT-004 AC2): a file linked to
 * the request — its attachments and its quotations' files — for a member who may view the request, as its page checks
 * it; or the member's own upload the form has not linked yet (a quotation's file before the draft is saved; requestId is
 * null while the form has no draft). Nothing else: through these pages a LINE sign-in reaches no other file of the
 * organization (defence in depth, src/server/queries/document-files.ts), and the file service checks the document the
 * file belongs to again. Null for anyone else, or without a session. The page binds the request's id
 * (downloadUrlAction.bind(null, requestId)) and the form sends its draft's; both ids come from the browser, so both are
 * checked here.
 */
export async function downloadUrlAction(requestId: string | null, fileId: string): Promise<string | null> {
  const page = await liffPage()
  if (page.kind !== 'member' || typeof fileId !== 'string' || (requestId !== null && typeof requestId !== 'string')) return null
  const opens = (requestId !== null && (await requestFile(page, requestId, fileId))) || (await isOwnUnattachedUpload(page.ctx, page.member.id, fileId))
  if (!opens) return null
  const r = await getDownloadUrl(page.ctx, { fileId })
  return r.ok ? r.data.url : null
}

/** A file linked to the request, for a member who may view it (request.view, as /liff/requests/[id] checks it) */
async function requestFile(page: MemberPage, requestId: string, fileId: string): Promise<boolean> {
  const access = await getRequestAccess(page.ctx, requestId)
  if (!access || !canViewRequest(await liffPrincipalOf(page.member.id), access)) return false
  return isDocumentFile(page.ctx, { subjectType: 'REQUEST', subjectId: requestId }, fileId)
}

const NO_SESSION_ACTION: ActionFailure = { ok: false, code: 'UNAUTHENTICATED' }

/** FR-INT-009: the requester answers the approver's question from LIFF (the LINE message about it opens the request here) */
export async function answerInfoAction(input: { infoRequestId: string; answer: string }, idempotencyKey: string): Promise<ActionOutcome> {
  const ctx = await memberCtx()
  if (!ctx) return NO_SESSION_ACTION
  return answerQuestion(ctx, input, idempotencyKey)
}

/** FR-INT-009 AC2: the requester sends a returned request again as it is, from LIFF (with the reason for asking again, S6-13) */
export async function resubmitReturnedAction(requestId: string, idempotencyKey: string, duplicateReason?: string): Promise<ActionOutcome> {
  const ctx = await memberCtx()
  if (!ctx) return NO_SESSION_ACTION
  return resubmitOwnRequest(ctx, requestId, idempotencyKey, duplicateReason)
}

/** FR-INT-009 AC1: the requester cancels their request with a reason, from LIFF; the budget it reserved goes back at once */
export async function cancelRequestAction(input: { requestId: string; reason: string }, idempotencyKey: string): Promise<ActionOutcome> {
  const ctx = await memberCtx()
  if (!ctx) return NO_SESSION_ACTION
  return cancelOwnRequest(ctx, input, idempotencyKey)
}

/** "ขอซ้ำ" from LIFF (FR-INT-101 AC1): a new draft from the requester's request, made on the LIFF channel; the page opens its form */
export async function reorderAction(requestId: string, idempotencyKey: string): Promise<RepeatOutcome> {
  const ctx = await memberCtx()
  if (!ctx) return NO_SESSION_ACTION
  return reorderOwnRequest(ctx, requestId, idempotencyKey)
}

// ---------- a request begun in the LINE chat (S17-07 · BR-LINE-12 · FR-LINE-301 AC4 AC7) ----------

const chatFailure = (error: { readonly code: string; readonly details?: Readonly<Record<string, unknown>> }): LiffChatOutcome => {
  const field = typeof error.details?.field === 'string' ? error.details.field : undefined
  const reason = typeof error.details?.reason === 'string' ? error.details.reason : undefined
  return { ok: false, code: error.code, ...(field ? { field } : {}), ...(reason ? { reason } : {}) }
}

/** "สร้างร่างคำขอ": chat_intake.draft as the member of this LIFF page; the draft then opens in the LIFF form */
export async function draftFromChatAction(input: { intakeId: string; requestTypeCode: string; title?: string; ai?: { agentActionId: string; usePaths: string[] }; idempotencyKey: string }): Promise<LiffChatOutcome> {
  const ctx = await memberCtx()
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (!Key.safeParse(input?.idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
  // Browser input on its way to the service, whose Zod schema checks it; a title left out is the first line of the text
  const result = await draftFromChat(
    ctx,
    {
      intakeId: String(input.intakeId),
      requestTypeCode: String(input.requestTypeCode),
      ...(typeof input.title === 'string' ? { title: input.title } : {}),
      // S17-08: what the owner took of the AI's reading (the service checks it is this draft's and of its paths)
      ...(input.ai ? { ai: input.ai } : {}),
    },
    { idempotencyKey: input.idempotencyKey },
  )
  return result.ok ? { ok: true, href: liffDraftHref(result.data.requestId) } : chatFailure(result.error)
}

/** "ไม่ใช่คำขอ": chat_intake.dismiss as the member of this LIFF page */
export async function dismissChatIntakeAction(input: { intakeId: string; idempotencyKey: string }): Promise<LiffChatOutcome> {
  const ctx = await memberCtx()
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (!Key.safeParse(input?.idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
  const result = await dismissChatIntake(ctx, { intakeId: String(input.intakeId) }, { idempotencyKey: input.idempotencyKey })
  return result.ok ? { ok: true, href: '' } : chatFailure(result.error)
}

/**
 * S17-08 (BR-AI-16 BR-AI-17 · FR-LINE-301 AC5): the requester confirms, one by one, values the AI put into their draft
 * (request.edit with aiAssist, nothing else changed). Until each is confirmed request.submit answers AI_REVIEW_PENDING.
 */
export async function confirmAiValuesAction(input: { requestId: string; agentActionId: string; paths: string[]; idempotencyKey: string }): Promise<LiffChatOutcome> {
  const ctx = await memberCtx()
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (!Key.safeParse(input?.idempotencyKey).success) return { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
  const result = await editRequest(
    ctx,
    { requestId: String(input.requestId), aiAssist: { agentActionId: String(input.agentActionId), confirmedPaths: Array.isArray(input.paths) ? input.paths.map(String) : [] } },
    { idempotencyKey: input.idempotencyKey },
  )
  return result.ok ? { ok: true, href: '' } : chatFailure(result.error)
}
