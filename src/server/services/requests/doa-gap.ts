import { z } from 'zod'
import type { AppError } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// FR-DOA-003 AC3 and §10.1 (admin.doa_gap): when a submit is refused because the DOA names nobody who can approve the
// request — no version in effect, a position nobody holds, or no authority above the requester — the requester is told
// whom to contact on the screen and ORG_ADMIN is told to fix the gap.
//
// The refusal rolls back the whole submit transaction (FR-INT-007 AC1: nothing at all happens), so nothing written in
// it survives. Like the audit events a rejected command keeps (_pipeline.ts, auditEvents), the report must outlive
// that rollback: submitRequest and resubmitRequest run this second command right after the refused one, in its own
// transaction, with an idempotency key derived from the submit's key. A resend of the same submission therefore
// replays the report instead of reporting twice, and each administrator hears about one gap of one request once
// (Notification.dedupeKey). The request's history keeps every refused attempt (request.doa_gap_reported).

export const DOA_GAP_CODES = ['DOA_NOT_CONFIGURED', 'APPROVER_NOT_FOUND', 'NO_HIGHER_AUTHORITY'] as const
export type DoaGapCode = (typeof DOA_GAP_CODES)[number]

export function isDoaGap(code: string): code is DoaGapCode {
  return (DOA_GAP_CODES as readonly string[]).includes(code)
}

const Text = z.string().trim().min(1).max(100)
const ReportInput = z.strictObject({
  requestId: z.uuid(),
  code: z.enum(DOA_GAP_CODES),
  ruleCode: Text.nullable(),
  position: Text.nullable(),
  departments: z.array(z.string().trim().min(1).max(50)).max(50),
})

export const reportDoaGapCommand = defineCommand({
  name: 'request.report_doa_gap',
  capability: 'request.submit',
  input: ReportInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ admins: number }>> {
    const request = await tx.request.findFirst({ where: { id: input.requestId }, select: { id: true, title: true, number: true, requesterMemberId: true } })
    if (!request) return { ok: false, error: { code: 'NOT_FOUND', message: 'request not found' } }
    const allowed = await authorize(tx, ctx, 'request.submit', { ownerMemberIds: [request.requesterMemberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const admins = await tx.roleAssignment.findMany({ where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
    const adminIds = [...new Set(admins.map((a) => a.memberId))]
    const gap = [input.code, input.ruleCode ?? '-', input.position ?? '-'].join(':')
    return {
      ok: true,
      result: { admins: adminIds.length },
      events: [
        {
          type: 'request.doa_gap_reported',
          aggregateType: 'Request',
          aggregateId: request.id,
          data: { code: input.code, ruleCode: input.ruleCode, position: input.position, departments: input.departments, notifiedAdmins: adminIds.length },
        },
      ],
      notifications: adminIds.map((memberId) => ({
        recipientMemberId: memberId,
        templateKey: 'admin.doa_gap',
        data: { requestId: request.id, number: request.number, title: request.title, code: input.code, ruleCode: input.ruleCode, position: input.position, departments: input.departments },
        urgency: 'IMMEDIATE' as const,
        dedupeKey: `admin.doa_gap:${request.id}:${gap}:${memberId}`,
        subjectType: 'REQUEST',
        subjectId: request.id,
      })),
    }
  },
})

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

/**
 * After a refused submit or resubmit: a DOA gap is recorded on the request and ORG_ADMIN told, in a transaction of its
 * own. Returns how many administrators were told, or null when the refusal is no DOA gap or the report itself failed —
 * the requester is then told to contact them, never that they were told.
 */
export async function reportDoaGap(ctx: Ctx, requestId: unknown, error: AppError, options: RunOptions): Promise<number | null> {
  if (!isDoaGap(error.code) || typeof requestId !== 'string') return null
  const details = error.details ?? {}
  const departments = Array.isArray(details.departments) ? details.departments.filter((d): d is string => typeof d === 'string' && d.trim().length > 0) : []
  const reported = await runCommand(
    ctx,
    reportDoaGapCommand,
    { requestId, code: error.code, ruleCode: text(details.ruleCode), position: text(details.position), departments },
    { ...options, idempotencyKey: `${options.idempotencyKey}:doa-gap` },
  )
  return reported.ok ? reported.data.admins : null
}
