import { ok, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { doaNamedApprovers } from '@/server/doa/policy'
import { listCostCenters, listCurrentHolders, listDepartments, listMembers, listPositions, openTasksBySlot, type DepartmentRow } from '@/server/queries/org'
import { personOf, type PersonView } from '../doa/view'
import { treeOrder } from './tree'

// The organization structure page of ORG_ADMIN (spec §9.1, FR-ADM-002): the department tree, cost centers, positions
// with their current holders, and for each position whether it carries authority (BR-DOA-17, ADR-042 item 2: a DOA
// version in effect, to come or awaiting approval names it, or open approval tasks came from it) — such holders change
// only through an ORG_AUTHORITY_CHANGE. Reading needs admin.orgStructure.editBasic (BR-AUTH-05); nothing here writes.

export interface DepartmentView extends DepartmentRow {
  readonly depth: number
  readonly costCenters: number
}

export interface CostCenterView {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly active: boolean
  readonly department: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null }
}

export interface HolderView {
  readonly departmentId: string
  readonly departmentCode: string
  readonly departmentNameTh: string
  readonly departmentNameEn: string | null
  readonly member: PersonView
  readonly since: string
  /** Open approval tasks this holder has from the position (they follow a new holder, BR-DOA-17) */
  readonly openTasks: number
}

export interface PositionView {
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly scope: 'DEPARTMENT' | 'ORG'
  /** Holders change only through an ORG_AUTHORITY_CHANGE */
  readonly authority: boolean
  /** A DOA version in effect, to come or awaiting approval names the position */
  readonly namedByDoa: boolean
  /** Open approval tasks that came from the position, in every department */
  readonly openTasks: number
  readonly holders: readonly HolderView[]
}

export interface MemberPick extends PersonView {
  readonly employeeCode: string | null
}

export interface OrgStructureView {
  readonly departments: readonly DepartmentView[]
  readonly costCenters: readonly CostCenterView[]
  readonly positions: readonly PositionView[]
  /** Active members, for the pickers */
  readonly members: readonly MemberPick[]
}

export async function getOrgStructureForAdmin(ctx: Ctx): Promise<Result<OrgStructureView>> {
  const named = await forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'admin.orgStructure.editBasic')
    return allowed.ok ? { ok: true as const, positions: (await doaNamedApprovers(tx, ctx.now)).positions } : { ok: false as const, error: allowed.error }
  })
  if (!named.ok) return { ok: false, error: named.error }

  const [departments, costCenters, positions, holders, members, openBySlot] = await Promise.all([
    listDepartments(ctx),
    listCostCenters(ctx),
    listPositions(ctx),
    listCurrentHolders(ctx, ctx.now),
    listMembers(ctx),
    openTasksBySlot(ctx),
  ])
  const person = personOf(members)
  const departmentById = new Map(departments.map((d) => [d.id, d]))
  const costCenterCount = (id: string) => costCenters.filter((c) => c.departmentId === id).length
  const openOf = (code: string) => [...openBySlot.entries()].filter(([slot]) => slot.startsWith(`${code}@`)).reduce((sum, [, n]) => sum + n, 0)

  return ok({
    departments: treeOrder(departments).map((d) => ({ ...d, costCenters: costCenterCount(d.id) })),
    costCenters: costCenters.map((c) => {
      const d = departmentById.get(c.departmentId)
      return { id: c.id, code: c.code, nameTh: c.nameTh, active: c.active, department: { id: c.departmentId, code: d?.code ?? '', nameTh: d?.nameTh ?? '', nameEn: d?.nameEn ?? null } }
    }),
    positions: positions.map((p) => {
      const namedByDoa = named.positions.has(p.code)
      const openTasks = openOf(p.code)
      return {
        code: p.code,
        nameTh: p.nameTh,
        nameEn: p.nameEn,
        scope: p.scope,
        authority: namedByDoa || openTasks > 0,
        namedByDoa,
        openTasks,
        holders: holders
          .filter((h) => h.positionCode === p.code)
          .map((h) => {
            const d = departmentById.get(h.departmentId)
            return {
              departmentId: h.departmentId,
              departmentCode: d?.code ?? '',
              departmentNameTh: d?.nameTh ?? '',
              departmentNameEn: d?.nameEn ?? null,
              member: person(h.memberId)!,
              since: h.validFrom.toISOString(),
              openTasks: openBySlot.get(`${p.code}@${d?.code ?? ''}`) ?? 0,
            }
          })
          .sort((a, b) => a.departmentCode.localeCompare(b.departmentCode)),
      }
    }),
    members: members.filter((m) => m.active).map((m) => ({ id: m.id, nameTh: m.displayNameTh, nameEn: m.displayNameEn, employeeCode: m.employeeCode })),
  })
}
