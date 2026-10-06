import { z } from 'zod'
import { amountToSatang } from '@/core/money/dto'
import { ok, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { doaNamedApprovers } from '@/server/doa/policy'
import { listCurrentHolders, listDepartments, listMembers, listOrgChanges, listPositions, openTasksBySlot, type OrgChangeRow } from '@/server/queries/org'
import { personOf, routeView, type PersonView, type RouteView } from '../doa/view'
import type { MemberPick } from '../org-structure/view'
import { treeOrder } from '../org-structure/tree'
import { PayloadSchemas } from './index'

// The authority-change pages of ORG_ADMIN (spec §9.1 /admin/org-authority, FR-DOA-010): the changes with their status,
// what they change, their impact and their route, and what the proposal form offers. Reading needs
// admin.orgAuthority.propose (BR-AUTH-05); nothing here writes. The preview before sending is previewOrgChange.

export interface DepartmentRef {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
}

export interface PositionRef {
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
}

export type ChangeDetails =
  | { readonly kind: 'POSITION_ASSIGN'; readonly position: PositionRef; readonly department: DepartmentRef; readonly member: PersonView }
  | { readonly kind: 'POSITION_END'; readonly position: PositionRef; readonly department: DepartmentRef; readonly replacement: PersonView | null }
  | { readonly kind: 'DEPARTMENT_REPARENT'; readonly department: DepartmentRef; readonly newParent: DepartmentRef }
  | {
      readonly kind: 'DELEGATION_ON_BEHALF'
      readonly delegator: PersonView
      readonly delegate: PersonView
      readonly startsAt: string
      readonly endsAt: string
      /** Empty = every document type (BR-DLG-01) */
      readonly documentTypes: readonly string[]
      /** Satang text; null = no cap */
      readonly maxAmount: string | null
    }
  | { readonly kind: 'IDENTITY_RESET'; readonly member: PersonView }

export interface OrgChangeView {
  readonly id: string
  readonly kind: OrgChangeRow['kind']
  readonly status: OrgChangeRow['status']
  readonly reason: string
  readonly effectiveFrom: string
  readonly submittedBy: PersonView
  readonly submittedAt: string | null
  readonly approvedAt: string | null
  readonly appliedAt: string | null
  /**
   * It takes effect as soon as it is approved: an identity reset and a delegation on behalf always (the delegation's own
   * start then governs), and a proposal sent with "effective on approval", whose effective time is its sending time
   */
  readonly onApproval: boolean
  /** null when the stored payload cannot be read (never for rows the services wrote) */
  readonly details: ChangeDetails | null
  /**
   * openTasks: pending tasks of the slot that move to the new holder; openTasksStay: those that stay where they are
   * because the slot becomes vacant (ADR-042 item 3)
   */
  readonly impact: { readonly gains: readonly PersonView[]; readonly loses: readonly PersonView[]; readonly openTasks: number; readonly openTasksStay: number } | null
  readonly route: RouteView | null
}

export interface OrgChangeFormView {
  readonly departments: ReadonlyArray<DepartmentRef & { readonly depth: number; readonly parentId: string | null }>
  readonly positions: ReadonlyArray<PositionRef & { readonly scope: 'DEPARTMENT' | 'ORG'; readonly authority: boolean }>
  readonly members: readonly MemberPick[]
  /** Current holder of each position slot, so the form can say who is replaced */
  readonly holders: ReadonlyArray<{ readonly positionCode: string; readonly departmentId: string; readonly member: PersonView }>
}

async function allowed(ctx: Ctx) {
  return forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'admin.orgAuthority.propose'))
}

// openTasksStay was added later: a stored vacancy without it counted the tasks that stay in openTasks
const Impact = z.object({ gains: z.array(z.string()), loses: z.array(z.string()), openTasks: z.number().int().nonnegative(), openTasksStay: z.number().int().nonnegative().optional() })

/** A POSITION_END without a replacement leaves the slot vacant: its pending tasks stay where they are */
const vacates = (c: OrgChangeRow) => c.kind === 'POSITION_END' && !PayloadSchemas.POSITION_END.safeParse(c.payload).data?.replacementMemberId

/** /admin/org-authority: every change, newest first, with what it changes and its route (FR-DOA-010). */
export async function listOrgChangesForAdmin(ctx: Ctx): Promise<Result<readonly OrgChangeView[]>> {
  const allow = await allowed(ctx)
  if (!allow.ok) return allow
  const [changes, members, departments, positions] = await Promise.all([listOrgChanges(ctx), listMembers(ctx), listDepartments(ctx), listPositions(ctx)])
  const person = personOf(members)
  const department = (id: string): DepartmentRef => {
    const d = departments.find((x) => x.id === id)
    return { id, code: d?.code ?? id, nameTh: d?.nameTh ?? id, nameEn: d?.nameEn ?? null }
  }
  const position = (code: string): PositionRef => {
    const p = positions.find((x) => x.code === code)
    return { code, nameTh: p?.nameTh ?? code, nameEn: p?.nameEn ?? null }
  }
  const detailsOf = (c: OrgChangeRow): ChangeDetails | null => {
    switch (c.kind) {
      case 'POSITION_ASSIGN': {
        const p = PayloadSchemas.POSITION_ASSIGN.safeParse(c.payload)
        return p.success ? { kind: c.kind, position: position(p.data.positionCode), department: department(p.data.departmentId), member: person(p.data.memberId)! } : null
      }
      case 'POSITION_END': {
        const p = PayloadSchemas.POSITION_END.safeParse(c.payload)
        return p.success ? { kind: c.kind, position: position(p.data.positionCode), department: department(p.data.departmentId), replacement: person(p.data.replacementMemberId ?? null) } : null
      }
      case 'DEPARTMENT_REPARENT': {
        const p = PayloadSchemas.DEPARTMENT_REPARENT.safeParse(c.payload)
        return p.success ? { kind: c.kind, department: department(p.data.departmentId), newParent: department(p.data.newParentId) } : null
      }
      case 'DELEGATION_ON_BEHALF': {
        const p = PayloadSchemas.DELEGATION_ON_BEHALF.safeParse(c.payload)
        return p.success
          ? {
              kind: c.kind,
              delegator: person(p.data.delegatorMemberId)!,
              delegate: person(p.data.delegateMemberId)!,
              startsAt: new Date(p.data.startsAt).toISOString(),
              endsAt: new Date(p.data.endsAt).toISOString(),
              documentTypes: p.data.documentTypes,
              maxAmount: p.data.maxAmount ? amountToSatang(p.data.maxAmount).toString() : null,
            }
          : null
      }
      case 'IDENTITY_RESET': {
        const p = PayloadSchemas.IDENTITY_RESET.safeParse(c.payload)
        return p.success ? { kind: c.kind, member: person(p.data.memberId)! } : null
      }
    }
  }
  return ok(
    changes.map((c) => {
      const impact = Impact.safeParse(c.impactSummary)
      const vacancy = vacates(c)
      return {
        id: c.id,
        kind: c.kind,
        status: c.status,
        reason: c.reason,
        effectiveFrom: c.effectiveFrom.toISOString(),
        submittedBy: person(c.submittedById)!,
        submittedAt: c.submittedAt?.toISOString() ?? null,
        approvedAt: c.approvedAt?.toISOString() ?? null,
        appliedAt: c.appliedAt?.toISOString() ?? null,
        onApproval: c.kind === 'IDENTITY_RESET' || c.kind === 'DELEGATION_ON_BEHALF' || (c.submittedAt !== null && c.effectiveFrom.getTime() <= c.submittedAt.getTime()),
        details: detailsOf(c),
        impact: impact.success
          ? {
              gains: impact.data.gains.map((id) => person(id)!),
              loses: impact.data.loses.map((id) => person(id)!),
              openTasks: vacancy ? 0 : impact.data.openTasks,
              openTasksStay: impact.data.openTasksStay ?? (vacancy ? impact.data.openTasks : 0),
            }
          : null,
        route: c.route ? routeView(c.route, person) : null,
      }
    }),
  )
}

/** What the proposal form of /admin/org-authority/new offers: departments, positions, active members, current holders. */
export async function getOrgChangeFormForAdmin(ctx: Ctx): Promise<Result<OrgChangeFormView>> {
  const named = await forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allow = await authorize(tx, ctx, 'admin.orgAuthority.propose')
    return allow.ok ? { ok: true as const, positions: (await doaNamedApprovers(tx, ctx.now)).positions } : { ok: false as const, error: allow.error }
  })
  if (!named.ok) return { ok: false, error: named.error }
  const [departments, positions, holders, members, openBySlot] = await Promise.all([listDepartments(ctx), listPositions(ctx), listCurrentHolders(ctx, ctx.now), listMembers(ctx), openTasksBySlot(ctx)])
  const person = personOf(members)
  const open = (code: string) => [...openBySlot.keys()].some((slot) => slot.startsWith(`${code}@`))
  return ok({
    departments: treeOrder(departments).map((d) => ({ id: d.id, code: d.code, nameTh: d.nameTh, nameEn: d.nameEn, depth: d.depth, parentId: d.parentId })),
    positions: positions.map((p) => ({ code: p.code, nameTh: p.nameTh, nameEn: p.nameEn, scope: p.scope, authority: named.positions.has(p.code) || open(p.code) })),
    members: members.filter((m) => m.active).map((m) => ({ id: m.id, nameTh: m.displayNameTh, nameEn: m.displayNameEn, employeeCode: m.employeeCode })),
    holders: holders.map((h) => ({ positionCode: h.positionCode, departmentId: h.departmentId, member: person(h.memberId)! })),
  })
}
