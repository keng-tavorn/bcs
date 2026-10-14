import { chooseRule } from '@/core/doa'
import { checkDuplicates, DUPLICATE_STATUSES, type RequestFlagResult } from '@/core/duplicates'
import { err, ok, type AppError, type Result } from '@/core/result'
import { MS_PER_DAY } from '@/lib/constants'
import { s6SettingsOf } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { versionSnapshotFromRows } from '@/server/doa/snapshot'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { requestViewScope } from './view-scope'

// Duplicate requests and split purchases at the submit and the resubmit, every channel (S6-13 · FR-INT-103 · BR-DUP-01
// to BR-DUP-05 · ADR-107 · OQ-103): checked in the transaction that makes the route, under the DOA version that route
// was made with, and written as RequestFlag rows of that route's number with request.flagged. A flag never blocks and
// never changes the route; a DUPLICATE needs the requester's reason (DUPLICATE_UNACKNOWLEDGED until given). Every
// AUDITOR hears of a flag in their digest.

export interface FlagCheckRequest {
  readonly id: string
  readonly number: string | null
  readonly title: string
  readonly requesterMemberId: string
  readonly chargedDepartmentId: string
  readonly suggestedSupplierId: string | null
  readonly lines: ReadonlyArray<{ readonly description: string; readonly uom: string; readonly quantity: { toString(): string }; readonly catalogItemId: string | null }>
}

type Checked = { ok: true; events: EventDraft[]; notifications: NotificationDraft[] } | { ok: false; error: AppError }

/** The flags the request would get if sent now under `doaVersionId`, with its own totals (also the page's "before sending" panel) */
export async function flagsFor(tx: TenantTx, ctx: Ctx, request: FlagCheckRequest, totals: { readonly net: bigint; readonly gross: bigint }, doaVersionId: string): Promise<RequestFlagResult[]> {
  const version = await tx.doaVersion.findUniqueOrThrow({ where: { id: doaVersionId }, include: { rules: true } })
  const snapshot = versionSnapshotFromRows(version, version.rules)
  const basis = (r: { readonly net: bigint; readonly gross: bigint }) => (snapshot.amountBasis === 'NET' ? r.net : r.gross)
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const windowDays = s6SettingsOf(org.settings).duplicateWindowDays
  const window = windowDays * MS_PER_DAY
  // Only who can match: the same requester (DUPLICATE) or the same paying department (SPLIT), sent within the window
  const others = await tx.request.findMany({
    where: {
      id: { not: request.id },
      status: { in: [...DUPLICATE_STATUSES] },
      submittedAt: { gte: new Date(ctx.now.getTime() - window), lte: new Date(ctx.now.getTime() + window) },
      OR: [{ requesterMemberId: request.requesterMemberId }, { chargedDepartmentId: request.chargedDepartmentId }],
    },
    select: { id: true, status: true, submittedAt: true, requesterMemberId: true, chargedDepartmentId: true, suggestedSupplierId: true, netSatang: true, grossSatang: true, lines: { select: { description: true, uom: true, quantity: true, catalogItemId: true } } },
  })
  const lines = (ls: FlagCheckRequest['lines']) => ls.map((l) => ({ description: l.description, uom: l.uom, quantity: l.quantity.toString(), catalogItemId: l.catalogItemId }))
  return checkDuplicates(
    { id: request.id, requesterMemberId: request.requesterMemberId, chargedDepartmentId: request.chargedDepartmentId, suggestedSupplierId: request.suggestedSupplierId, basisAmountSatang: basis(totals), lines: lines(request.lines) },
    others.map((o) => ({
      id: o.id,
      status: o.status,
      submittedAt: o.submittedAt!,
      requesterMemberId: o.requesterMemberId,
      chargedDepartmentId: o.chargedDepartmentId,
      suggestedSupplierId: o.suggestedSupplierId,
      basisAmountSatang: basis({ net: o.netSatang ?? 0n, gross: o.grossSatang ?? 0n }),
      lines: lines(o.lines),
    })),
    {
      at: ctx.now,
      windowDays,
      ruleFor: (amount) => {
        const choice = chooseRule(snapshot, 'PURCHASE_REQUEST', amount)
        return choice.kind === 'rule' ? choice.rule.code : null
      },
    },
  )
}

/** BR-DUP-05 at the submit: the flags of this route written, or DUPLICATE_UNACKNOWLEDGED without the requester's reason */
export async function flagRequest(
  tx: TenantTx,
  ctx: Ctx,
  request: FlagCheckRequest,
  totals: { readonly net: bigint; readonly gross: bigint },
  route: { readonly routeId: string; readonly doaVersionId: string },
  duplicateReason: string | null,
): Promise<Checked> {
  const flags = await flagsFor(tx, ctx, request, totals, route.doaVersionId)
  if (flags.length === 0) return { ok: true, events: [], notifications: [] }
  const duplicate = flags.find((f) => f.kind === 'DUPLICATE')
  const reason = (duplicateReason ?? '').trim()
  if (duplicate && reason === '') {
    const matched = await tx.request.findMany({ where: { id: { in: [...duplicate.matchedRequestIds] } }, select: { id: true, number: true, title: true } })
    return {
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'the request looks like one sent before: give the reason to send it', details: { field: 'duplicateReason', reason: 'DUPLICATE_UNACKNOWLEDGED', matched } },
    }
  }
  const { routeNo } = await tx.approvalRoute.findUniqueOrThrow({ where: { id: route.routeId }, select: { routeNo: true } })
  const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  const auditors = [...new Set((await tx.roleAssignment.findMany({ where: { role: 'AUDITOR', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })).map((r) => r.memberId))]
  const events: EventDraft[] = []
  const notifications: NotificationDraft[] = []
  for (const f of flags) {
    const detail = f.kind === 'SPLIT' ? { combinedSatang: f.combinedSatang.toString(), individualRule: f.individualRule, combinedRule: f.combinedRule } : {}
    await tx.requestFlag.create({
      data: {
        organizationId: ctx.organizationId,
        requestId: request.id,
        routeNo,
        kind: f.kind,
        matchedRequestIds: [...f.matchedRequestIds],
        detail,
        ...(f.kind === 'DUPLICATE' ? { acknowledgedReason: reason, acknowledgedById: actor } : {}),
      },
    })
    events.push({ type: 'request.flagged', aggregateType: 'Request', aggregateId: request.id, data: { kind: f.kind, routeNo, matchedRequestIds: [...f.matchedRequestIds], ...detail } })
    for (const recipientMemberId of auditors) {
      notifications.push({
        recipientMemberId,
        templateKey: 'audit.request_flagged',
        data: { requestId: request.id, number: request.number, title: request.title, kind: f.kind },
        urgency: 'DIGEST',
        dedupeKey: `audit.request_flagged:${request.id}:${routeNo}:${f.kind}:${recipientMemberId}`,
        subjectType: 'REQUEST',
        subjectId: request.id,
      })
    }
  }
  return { ok: true, events, notifications }
}

export interface RequestFlagDto {
  readonly kind: 'DUPLICATE' | 'SPLIT'
  readonly routeNo: number
  /** The requests it matched, by number (or title before one), oldest first */
  readonly matched: ReadonlyArray<{ readonly id: string; readonly label: string }>
  /** SPLIT: the amount of them together on the DOA basis and the rules alone and together */
  readonly combinedSatang: string | null
  readonly individualRule: string | null
  readonly combinedRule: string | null
  /** DUPLICATE: the requester's reason */
  readonly reason: string | null
}

/**
 * The flags of the request's latest route (S6-13 · for the approver's page and card, the report of FR-VIS-101, and S13's
 * Approval Brief): whoever may view the request (request.view, which counts its approvers and reviewers as ASSIGNED).
 */
export async function listRequestFlags(ctx: Ctx, requestId: string): Promise<Result<RequestFlagDto[]>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const scope = await requestViewScope(tx, requestId)
    if (!scope) return err('NOT_FOUND', 'request not found')
    const allowed = await authorize(tx, ctx, 'request.view', scope)
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const latest = await tx.requestFlag.aggregate({ where: { requestId }, _max: { routeNo: true } })
    if (latest._max.routeNo === null) return ok([])
    const flags = await tx.requestFlag.findMany({ where: { requestId, routeNo: latest._max.routeNo }, orderBy: { kind: 'asc' } })
    const ids = [...new Set(flags.flatMap((f) => f.matchedRequestIds))]
    const labels = new Map((await tx.request.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, title: true } })).map((r) => [r.id, r.number ?? r.title]))
    return ok(
      flags.map((f) => {
        const detail = (f.detail ?? {}) as { combinedSatang?: string; individualRule?: string | null; combinedRule?: string | null }
        return {
          kind: f.kind,
          routeNo: f.routeNo,
          matched: f.matchedRequestIds.map((id) => ({ id, label: labels.get(id) ?? id })),
          combinedSatang: detail.combinedSatang ?? null,
          individualRule: detail.individualRule ?? null,
          combinedRule: detail.combinedRule ?? null,
          reason: f.acknowledgedReason,
        }
      }),
    )
  })
}
