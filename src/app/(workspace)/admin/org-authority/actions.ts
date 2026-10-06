'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { ctxFromSession } from '@/server/auth/session'
import { previewOrgChange, proposeOrgChange } from '@/server/services/org-authority'
import { CHANGE_KINDS } from '@/ui/admin-org/kinds'
import type { OrgChangeDraft, PreviewResult, ProposeResult } from '@/ui/admin-org/org-change-form'
import { toActionFailure, type ActionFailure } from '@/ui/admin-org/outcome'
import { getSession } from '../../../_lib/session'
import { orgChangeInput } from './draft-input'

// Browser-facing adapters for /admin/org-authority (FR-DOA-010 AC1). The form sends what the admin filled in, with
// times as local "YYYY-MM-DDTHH:mm" in Thai time (what every screen shows); draft-input.ts turns it into the service's
// input. The preview only reads, except that a refusal by separation of duties is recorded (FR-DOA-007 AC2) with the
// form's idempotencyKey; the proposal is a command with the form's idempotencyKey (spec §4.3). The service checks
// admin.orgAuthority.propose, BR-SOD-08, the governance rules and the warnings every time (BR-AUTH-05).

const NO_SESSION: ActionFailure = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_INPUT: ActionFailure = { ok: false, code: 'VALIDATION_FAILED', field: '(input)' }
const BAD_KEY: ActionFailure = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const submissionKey = z.uuid()
// Server actions are public endpoints (BR-AUTH-05): the shape of what arrives is checked before it is read; the
// service checks the values themselves
const Text = z.string().max(REASON_MAX_LENGTH * 2)
const DraftShape = z.object({
  kind: z.enum(CHANGE_KINDS),
  positionCode: Text,
  departmentId: Text,
  memberId: Text,
  replacementMemberId: Text,
  newParentId: Text,
  delegatorMemberId: Text,
  delegateMemberId: Text,
  startsAt: Text,
  endsAt: Text,
  documentTypes: z.array(z.string().max(40)).max(10),
  maxAmount: Text,
  effectiveMode: z.enum(['ON_APPROVAL', 'AT']),
  effectiveAt: Text,
  reason: Text,
})
const Acknowledged = z.array(z.string().max(200)).max(100)

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

export async function previewOrgChangeAction(draft: OrgChangeDraft, idempotencyKey: string): Promise<PreviewResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const shape = DraftShape.safeParse(draft)
  if (!shape.success) return BAD_INPUT
  const built = orgChangeInput(shape.data, ctx.now, [])
  if (!built.ok) return built
  const result = await previewOrgChange(ctx, built.input, { idempotencyKey })
  if (!result.ok) return toActionFailure(result.error)
  const payload = built.input.payload as { startsAt?: string; endsAt?: string }
  return {
    ok: true,
    preview: { ...result.data, period: payload.startsAt && payload.endsAt ? { startsAt: payload.startsAt, endsAt: payload.endsAt } : null },
  }
}

export async function proposeOrgChangeAction(draft: OrgChangeDraft, acknowledgedWarnings: readonly string[], idempotencyKey: string): Promise<ProposeResult> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  const shape = DraftShape.safeParse(draft)
  const acknowledged = Acknowledged.safeParse(acknowledgedWarnings)
  if (!shape.success || !acknowledged.success) return BAD_INPUT
  const built = orgChangeInput(shape.data, ctx.now, acknowledged.data)
  if (!built.ok) return built
  const result = await proposeOrgChange(ctx, built.input, { idempotencyKey })
  if (!result.ok) return toActionFailure(result.error)
  revalidatePath('/admin/org-authority', 'layout')
  return { ok: true, changeId: result.data.changeId, assigneeMemberId: result.data.assigneeMemberId }
}
