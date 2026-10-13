'use server'

import { getLocale } from 'next-intl/server'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { doaGapNames, sentRequestSummary } from '@/server/queries/request-form'
import { listCatalog } from '@/server/services/catalog/view'
import { resubmitRequest, submitRequest } from '@/server/services/requests'
import { attachFile, detachFile } from '@/server/services/requests/attachments'
import { previewRequest } from '@/server/services/requests/preview'
import { toFormFailure, type FormFailure, type FormOutcome } from '@/ui/request-form/outcome'
import type { CatalogSearchOutcome, PreviewRequestInput, PreviewView, SentView } from '@/ui/request-form/types'
import { getSession } from '../../../_lib/session'
import { catalogOption } from './catalog-options'

// Browser-facing adapters of the request form (S2-11). Each one builds ctx from the session and calls a service, which
// checks the permission (request.create / request.submit, OWN) and every rule again (BR-AUTH-05) — the screen hides
// nothing that matters. The idempotencyKey comes from the browser per submission (spec §4.3), so a double click or a
// retry after a lost answer runs the command once (INV-PLT-01).

const NO_SESSION: FormFailure = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: FormFailure = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const Key = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

async function locale(): Promise<'th' | 'en'> {
  return (await getLocale()) === 'en' ? 'en' : 'th'
}

/** FR-INT-004 AC1 and FR-DOA-003 AC2: the chosen line's balance and the expected route, without writing anything */
export async function previewRequestAction(input: PreviewRequestInput): Promise<FormOutcome<{ preview: PreviewView }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const result = await previewRequest(ctx, { ...input, lines: input.lines.map((l) => ({ ...l })) }, await locale())
  return result.ok ? { ok: true, preview: result.data } : toFormFailure(result.error)
}

/** FR-INT-005: a file the requester uploaded becomes an attachment of their draft, of one kind */
export async function attachFileAction(requestId: string, fileId: string, kind: string, idempotencyKey: string): Promise<FormOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  // The kind comes from the browser as text; the service's schema refuses any that is not a FileLinkKind
  const result = await attachFile(ctx, { requestId, fileId, kind: kind as 'OTHER' }, { idempotencyKey })
  return result.ok ? { ok: true } : toFormFailure(result.error)
}

export async function detachFileAction(requestId: string, fileId: string, idempotencyKey: string): Promise<FormOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const result = await detachFile(ctx, { requestId, fileId }, { idempotencyKey })
  return result.ok ? { ok: true } : toFormFailure(result.error)
}

/**
 * "ส่งขออนุมัติ" (FR-INT-007): submit a draft, or send a returned request again (FR-INT-009 AC2). The expected version is
 * the one the requester reviewed (FR-INT-006 AC2). Sent, the answer carries the request's number and who decides it now,
 * so the form confirms in the button's own words (§9.9 rule 7). When the DOA cannot route it, the answer names the
 * position and departments in words and says whether the organization's administrators were told (FR-DOA-003 AC3).
 */
export async function submitRequestAction(input: { requestId: string; expectedVersion: number; resubmit: boolean }, idempotencyKey: string): Promise<FormOutcome<{ requestId: string; sent: SentView }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!Key.safeParse(idempotencyKey).success) return BAD_KEY
  const command = input.resubmit ? resubmitRequest : submitRequest
  const result = await command(ctx, { requestId: input.requestId, expectedVersion: input.expectedVersion }, { idempotencyKey })
  const screen = await locale()
  if (result.ok) {
    const sent = await sentRequestSummary(ctx, input.requestId, screen)
    return { ok: true, requestId: input.requestId, sent: sent ?? { number: null, waitingFor: [] } }
  }
  const failure = toFormFailure(result.error)
  if (['DOA_NOT_CONFIGURED', 'APPROVER_NOT_FOUND', 'NO_HIGHER_AUTHORITY', 'DOA_AMBIGUOUS', 'REVIEWER_NOT_FOUND'].includes(failure.code)) {
    const names = await doaGapNames(ctx, { position: failure.position ?? null, departments: failure.departments ?? [] }, screen)
    return { ...failure, ...(names.position ? { position: names.position } : {}), departments: names.departments }
  }
  return failure
}

/**
 * S6-10 (FR-INT-102 AC1): the catalogue a line of the form is picked from — the active items matching the words, with the
 * agreed prices in effect today. It changes nothing (a POST only because server actions are); listCatalog checks
 * catalog.view. The words come from the browser: anything but text of up to 100 characters is refused.
 */
export async function searchCatalogAction(q: string): Promise<CatalogSearchOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (typeof q !== 'string' || q.length > 100) return { ok: false, code: 'VALIDATION_FAILED' }
  const result = await listCatalog(ctx, { q })
  return result.ok ? { ok: true, items: result.data.items.map(catalogOption), total: result.data.total, limit: result.data.limit } : { ok: false, code: result.error.code }
}
