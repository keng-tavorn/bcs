import type { Ctx } from '@/server/context'
import { escapeLike } from '@/server/db/like'
import { forTenant } from '@/server/db/tenant'

// Read-only views of the organization structure and of authority changes for the admin screens (FR-ADM-002,
// FR-DOA-010). Queries never write (§4.2) and never check permissions: the admin views in src/server/services check the
// capability first and are what pages call.

export interface DepartmentRow {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly kind: 'COMPANY' | 'DIVISION' | 'DEPARTMENT' | 'SECTION'
  readonly parentId: string | null
  readonly active: boolean
}

export async function listDepartments(ctx: Ctx): Promise<DepartmentRow[]> {
  return forTenant(ctx.organizationId).department.findMany({
    select: { id: true, code: true, nameTh: true, nameEn: true, kind: true, parentId: true, active: true },
    orderBy: { code: 'asc' },
  })
}

export interface CostCenterRow {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly departmentId: string
  readonly active: boolean
}

export async function listCostCenters(ctx: Ctx): Promise<CostCenterRow[]> {
  return forTenant(ctx.organizationId).costCenter.findMany({ select: { id: true, code: true, nameTh: true, departmentId: true, active: true }, orderBy: { code: 'asc' } })
}

export interface PositionRow {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly scope: 'DEPARTMENT' | 'ORG'
}

export async function listPositions(ctx: Ctx): Promise<PositionRow[]> {
  return forTenant(ctx.organizationId).position.findMany({ select: { id: true, code: true, nameTh: true, nameEn: true, scope: true }, orderBy: { code: 'asc' } })
}

export interface HolderRow {
  readonly positionCode: string
  readonly departmentId: string
  readonly memberId: string
  readonly validFrom: Date
}

/** Who holds each position now (one current holder per position and department, §6.3). */
export async function listCurrentHolders(ctx: Ctx, now: Date): Promise<HolderRow[]> {
  const rows = await forTenant(ctx.organizationId).positionAssignment.findMany({
    where: { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
    select: { departmentId: true, memberId: true, validFrom: true, position: { select: { code: true } } },
    orderBy: { validFrom: 'asc' },
  })
  return rows.map((r) => ({ positionCode: r.position.code, departmentId: r.departmentId, memberId: r.memberId, validFrom: r.validFrom }))
}

export interface MemberOptionRow {
  readonly id: string
  readonly displayNameTh: string
  readonly displayNameEn: string | null
  readonly employeeCode: string | null
  readonly primaryDepartmentId: string | null
  readonly active: boolean
}

/** Every member with the fields a picker shows; inactive members are kept so history can still name them. */
export async function listMembers(ctx: Ctx): Promise<MemberOptionRow[]> {
  const rows = await forTenant(ctx.organizationId).member.findMany({
    select: { id: true, displayNameTh: true, displayNameEn: true, employeeCode: true, primaryDepartmentId: true, status: true },
    orderBy: { displayNameTh: 'asc' },
  })
  return rows.map((m) => ({ id: m.id, displayNameTh: m.displayNameTh, displayNameEn: m.displayNameEn, employeeCode: m.employeeCode, primaryDepartmentId: m.primaryDepartmentId, active: m.status === 'ACTIVE' }))
}

/** Open approval tasks per position slot they came from ("POSITION:VP@OPS" → 2), BR-DOA-13 and BR-DOA-17. */
export async function openTasksBySlot(ctx: Ctx): Promise<Map<string, number>> {
  const groups = await forTenant(ctx.organizationId).approvalTask.groupBy({
    by: ['resolvedFrom'],
    where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, resolvedFrom: { startsWith: escapeLike('POSITION:') } },
    _count: { _all: true },
  })
  return new Map(groups.map((g) => [g.resolvedFrom.slice('POSITION:'.length), g._count._all]))
}

export interface RouteTaskRow {
  readonly stepNo: number
  readonly assigneeMemberId: string
  readonly principalMemberId: string | null
  readonly status: 'OPEN' | 'INFO_REQUESTED' | 'APPROVED' | 'REJECTED' | 'RETURNED' | 'CANCELLED' | 'REASSIGNED'
  readonly assignedAt: Date
  readonly decidedAt: Date | null
  readonly decidedByMemberId: string | null
}

export interface RouteRow {
  readonly id: string
  readonly status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
  readonly ruleCode: string
  readonly doaCode: string
  readonly versionNo: number
  readonly tasks: readonly RouteTaskRow[]
}

/** The parts of an approval route the admin screens show: the rule, its version, and the tasks with their outcome */
export const ROUTE_SELECT = {
  id: true,
  status: true,
  ruleCode: true,
  doaVersion: { select: { code: true, versionNo: true } },
  steps: {
    select: { stepNo: true, tasks: { select: { assigneeMemberId: true, principalMemberId: true, status: true, assignedAt: true, decidedAt: true, decidedByMemberId: true }, orderBy: { assignedAt: 'asc' as const } } },
    orderBy: { stepNo: 'asc' as const },
  },
} as const

type RouteSelected = {
  id: string
  status: RouteRow['status']
  ruleCode: string
  doaVersion: { code: string; versionNo: number }
  steps: Array<{ stepNo: number; tasks: Array<Omit<RouteTaskRow, 'stepNo'>> }>
}

export function routeRow(r: RouteSelected): RouteRow {
  return {
    id: r.id,
    status: r.status,
    ruleCode: r.ruleCode,
    doaCode: r.doaVersion.code,
    versionNo: r.doaVersion.versionNo,
    tasks: r.steps.flatMap((s) => s.tasks.map((t) => ({ ...t, stepNo: s.stepNo }))),
  }
}

export interface OrgChangeRow {
  readonly id: string
  readonly kind: 'POSITION_ASSIGN' | 'POSITION_END' | 'DEPARTMENT_REPARENT' | 'DELEGATION_ON_BEHALF' | 'IDENTITY_RESET'
  readonly status: 'DRAFT' | 'PENDING_APPROVAL' | 'SCHEDULED' | 'APPLIED' | 'REJECTED' | 'CANCELLED'
  readonly payload: unknown
  readonly reason: string
  readonly effectiveFrom: Date
  readonly submittedById: string
  readonly submittedAt: Date | null
  readonly approvedAt: Date | null
  readonly appliedAt: Date | null
  readonly impactSummary: unknown
  readonly route: RouteRow | null
}

/** Every authority change of the organization with its route, newest first. */
export async function listOrgChanges(ctx: Ctx): Promise<OrgChangeRow[]> {
  const rows = await forTenant(ctx.organizationId).orgAuthorityChange.findMany({
    select: {
      id: true,
      kind: true,
      status: true,
      payload: true,
      reason: true,
      effectiveFrom: true,
      submittedById: true,
      submittedAt: true,
      approvedAt: true,
      appliedAt: true,
      impactSummary: true,
      createdAt: true,
      route: { select: ROUTE_SELECT },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  return rows.map(({ route, createdAt: _createdAt, ...r }) => ({ ...r, route: route ? routeRow(route) : null }))
}
