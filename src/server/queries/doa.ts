import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { ROUTE_SELECT, routeRow, type RouteRow } from './org'

// Read-only views of the organization's DOA versions for the admin screens (FR-DOA-001 AC2–AC3, FR-DOA-002). Queries
// never write (§4.2) and never check permissions: the admin view in src/server/services/doa checks the capability.

export interface DoaVersionListRow {
  readonly id: string
  readonly code: string
  readonly versionNo: number
  readonly status: 'DRAFT' | 'PENDING_APPROVAL' | 'PUBLISHED' | 'SUPERSEDED' | 'REJECTED' | 'WITHDRAWN'
  readonly effectiveFrom: Date
  readonly effectiveTo: Date | null
  readonly changeReason: string | null
  readonly submittedById: string | null
  readonly submittedAt: Date | null
  readonly approvedById: string | null
  readonly approvedAt: Date | null
  readonly publishedAt: Date | null
  readonly createdAt: Date
  readonly rules: number
}

const LIST_SELECT = {
  id: true,
  code: true,
  versionNo: true,
  status: true,
  effectiveFrom: true,
  effectiveTo: true,
  changeReason: true,
  submittedById: true,
  submittedAt: true,
  approvedById: true,
  approvedAt: true,
  publishedAt: true,
  createdAt: true,
  _count: { select: { rules: true } },
} as const

/** Every version of every DOA code of the organization: by code, newest edition first. */
export async function listDoaVersions(ctx: Ctx): Promise<DoaVersionListRow[]> {
  const rows = await forTenant(ctx.organizationId).doaVersion.findMany({ select: LIST_SELECT, orderBy: [{ code: 'asc' }, { versionNo: 'desc' }] })
  return rows.map(({ _count, ...v }) => ({ ...v, rules: _count.rules }))
}

export interface DoaRuleRowView {
  readonly code: string
  readonly documentType: string
  readonly priority: number
  readonly when: unknown
  readonly steps: unknown
  readonly descriptionTh: string | null
}

export interface DoaVersionFullRow extends DoaVersionListRow {
  readonly amountBasis: 'GROSS' | 'NET'
  readonly selfApprovalPolicy: 'ESCALATE_NEXT_BAND' | 'BLOCK'
  readonly collapseDuplicateApprovers: boolean
  readonly stepUpThresholdSatang: bigint | null
  readonly sodPolicy: unknown
  readonly ruleRows: readonly DoaRuleRowView[]
}

const RULE_SELECT = { code: true, documentType: true, priority: true, when: true, steps: true, descriptionTh: true } as const

/** One version with its policy and rules, in the order they were written (ids are time-ordered). */
export async function getDoaVersionRow(ctx: Ctx, versionId: string): Promise<DoaVersionFullRow | null> {
  const row = await forTenant(ctx.organizationId).doaVersion.findFirst({
    where: { id: versionId },
    select: {
      ...LIST_SELECT,
      amountBasis: true,
      selfApprovalPolicy: true,
      collapseDuplicateApprovers: true,
      stepUpThresholdSatang: true,
      sodPolicy: true,
      rules: { select: RULE_SELECT, orderBy: { id: 'asc' } },
    },
  })
  if (!row) return null
  const { _count, rules, ...v } = row
  return { ...v, rules: _count.rules, ruleRows: rules }
}

/**
 * The version this one is compared with in its history (FR-DOA-001 AC3): the latest edition of the same code below
 * this number that was ever in effect (PUBLISHED or SUPERSEDED). Drafts and rejected editions are never the baseline.
 */
export async function previousDoaVersionId(ctx: Ctx, code: string, versionNo: number): Promise<string | null> {
  const row = await forTenant(ctx.organizationId).doaVersion.findFirst({
    where: { code, versionNo: { lt: versionNo }, status: { in: ['PUBLISHED', 'SUPERSEDED'] } },
    select: { id: true },
    orderBy: { versionNo: 'desc' },
  })
  return row?.id ?? null
}

/**
 * The moment a draft or a version waiting for approval is compared at (FR-DOA-009 AC1, AC3): just before it starts, so
 * the version in effect then is the one it replaces — a version approved for later included — or now, once its start
 * has passed (an approval moves a start that has passed to the approval itself, BR-DOA-12).
 */
export function comparisonInstant(effectiveFrom: Date, now: Date): Date {
  return effectiveFrom.getTime() > now.getTime() ? new Date(effectiveFrom.getTime() - 1) : now
}

/**
 * The version a draft or a version waiting for approval is compared with (FR-DOA-009 AC1, AC3): the one in effect at
 * comparisonInstant (BR-DOA-01: PUBLISHED or SUPERSEDED with effectiveFrom ≤ that moment < effectiveTo; the latest
 * start wins, as the route engine's versionAt picks it). The drafter's page, the send and the approver's decision page
 * read the same baseline. Takes the tenant client or a transaction of it; null when no version is in effect then.
 */
export async function comparisonBaselineId(db: Pick<TenantTx, 'doaVersion'>, version: { readonly id: string; readonly effectiveFrom: Date }, now: Date): Promise<string | null> {
  const at = comparisonInstant(version.effectiveFrom, now)
  const row = await db.doaVersion.findFirst({
    where: { id: { not: version.id }, status: { in: ['PUBLISHED', 'SUPERSEDED'] }, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
    select: { id: true },
    orderBy: [{ effectiveFrom: 'desc' }, { versionNo: 'desc' }],
  })
  return row?.id ?? null
}

/** Who drafted the version (imported it, or saved it from the editor) and when, from its doa_version.drafted event (the seed publishes without one). */
export async function doaVersionDrafted(ctx: Ctx, versionId: string): Promise<{ memberId: string | null; at: Date } | null> {
  const event = await forTenant(ctx.organizationId).event.findFirst({
    where: { aggregateType: 'DoaVersion', aggregateId: versionId, type: 'doa_version.drafted' },
    select: { actorMemberId: true, occurredAt: true },
    orderBy: { seq: 'asc' },
  })
  return event ? { memberId: event.actorMemberId, at: event.occurredAt } : null
}

/** The latest approval route of a version (its DOA_CHANGE approval, or the initial package's). */
export async function latestDoaVersionRoute(ctx: Ctx, versionId: string): Promise<RouteRow | null> {
  const route = await forTenant(ctx.organizationId).approvalRoute.findFirst({
    where: { subjectType: 'DOA_VERSION', subjectId: versionId },
    select: ROUTE_SELECT,
    orderBy: { routeNo: 'desc' },
  })
  return route ? routeRow(route) : null
}

/** Whether the organization has a DOA that is, was, or may become in effect (otherwise the initial package applies). */
export async function hasDoaBeyondDrafts(ctx: Ctx): Promise<boolean> {
  return (await forTenant(ctx.organizationId).doaVersion.count({ where: { status: { in: ['PENDING_APPROVAL', 'PUBLISHED', 'SUPERSEDED'] } } })) > 0
}

/** The contract signatory the BCS team verified (BR-DOA-19), or null. */
export async function verifiedSignatoryId(ctx: Ctx): Promise<string | null> {
  const org = await forTenant(ctx.organizationId).organization.findUnique({
    where: { id: ctx.organizationId },
    select: { contractSignatoryMemberId: true, contractSignatoryVerifiedAt: true },
  })
  return org?.contractSignatoryMemberId && org.contractSignatoryVerifiedAt ? org.contractSignatoryMemberId : null
}
