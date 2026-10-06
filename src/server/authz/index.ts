import { err, ok, type Result } from '@/core/result'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { PERMISSIONS, STORED_ROLES, type Capability, type Grant, type Scope, type StoredRole } from './permissions'

// Authorization happens in services, every time (BR-AUTH-05) — never in proxy.ts and never by hiding buttons.

export type Principal =
  | {
      readonly kind: 'member'
      readonly memberId: string
      readonly roles: ReadonlySet<StoredRole>
      /** Departments (with their subtrees) where the member is DM/VP — DEPT_HEAD (§2.2); filled from S2 */
      readonly headOfDepartmentIds: ReadonlySet<string>
      /** Departments where a DEPT-scoped role applies (role scope or primary department, with subtrees) */
      readonly departmentIds: ReadonlySet<string>
    }
  /** A member who is invited or deactivated: no capability at all */
  | { readonly kind: 'inactive'; readonly memberId: string }
  | { readonly kind: 'platform'; readonly platformAdminId: string }
  | { readonly kind: 'system' }

/** Who the resource belongs to, for OWN / ASSIGNED / DEPT grants. Omit to ask "could this ever be allowed?". */
export interface ResourceScope {
  /** Creator, requester and followers (OWN) */
  readonly ownerMemberIds?: readonly string[]
  /** Everyone who has or had a task on the document: approvers, receivers, reviewers (ASSIGNED) */
  readonly assigneeMemberIds?: readonly string[]
  /** Who may decide the open DOA task now (assignee or their delegate) — the only source of approval.decide */
  readonly deciderMemberIds?: readonly string[]
  readonly departmentId?: string | null
}

function granteeMatches(principal: Principal, grant: Grant): boolean {
  const g = grant.grantee
  if (g.kind === 'PLATFORM_ADMIN') return principal.kind === 'platform'
  if (principal.kind !== 'member') return false
  switch (g.kind) {
    case 'ANY_MEMBER':
      return true
    case 'ROLE':
      return principal.roles.has(g.role)
    case 'DEPT_HEAD':
      return principal.headOfDepartmentIds.size > 0
    case 'DOA_ASSIGNEE':
      return true
  }
}

function scopeMatches(principal: Principal, grant: Grant, resource: ResourceScope | undefined): boolean {
  if (grant.grantee.kind === 'DOA_ASSIGNEE') {
    // Never allowed without the task's actual deciders: no role, scope or "maybe later" grants a decision
    return principal.kind === 'member' && (resource?.deciderMemberIds ?? []).includes(principal.memberId)
  }
  if (!resource) return true
  if (principal.kind !== 'member') return grant.scope === 'ORG'
  switch (grant.scope) {
    case 'ORG':
      return true
    case 'OWN':
      return (resource.ownerMemberIds ?? []).includes(principal.memberId)
    case 'ASSIGNED':
      return (resource.assigneeMemberIds ?? []).includes(principal.memberId)
    case 'DEPT': {
      const dept = resource.departmentId
      if (!dept) return false
      const pool = grant.grantee.kind === 'DEPT_HEAD' ? principal.headOfDepartmentIds : principal.departmentIds
      return pool.has(dept)
    }
  }
}

/** The grants of `capability` that cover this principal and resource; a service checks their `condition`. */
export function matchingGrants(principal: Principal, capability: Capability, resource?: ResourceScope): Grant[] {
  const grants: readonly Grant[] = PERMISSIONS[capability] ?? []
  return grants.filter((grant) => granteeMatches(principal, grant) && scopeMatches(principal, grant, resource))
}

/** Pure decision: true when any grant of the capability covers this principal and resource. */
export function isAllowed(principal: Principal, capability: Capability, resource?: ResourceScope): boolean {
  return matchingGrants(principal, capability, resource).length > 0
}

/** Scopes a list query may use for this principal (DOA-assigned grants are per task, not per list). */
export function scopesFor(principal: Principal, capability: Capability): ReadonlySet<Scope> {
  const grants: readonly Grant[] = PERMISSIONS[capability] ?? []
  return new Set(grants.filter((g) => g.grantee.kind !== 'DOA_ASSIGNEE' && granteeMatches(principal, g)).map((g) => g.scope))
}

/** A member principal from roles already known (e.g. the signed-in session); departments arrive with S2. */
export function memberPrincipal(memberId: string, roles: Iterable<StoredRole>): Principal {
  return { kind: 'member', memberId, roles: new Set(roles), headOfDepartmentIds: new Set(), departmentIds: new Set() }
}

/**
 * §2.2 DEPT_HEAD is not a role: holding a department's position (DM or VP in the demo — the positions whose scope is
 * DEPARTMENT, so no position name is written in code) makes a member head of that department and its subtree, now.
 */
async function headedDepartments(tx: TenantTx, memberId: string, now: Date): Promise<Set<string>> {
  const held = await tx.positionAssignment.findMany({
    where: { memberId, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }], position: { scope: 'DEPARTMENT' } },
    select: { departmentId: true },
  })
  if (held.length === 0) return new Set()
  const departments = await tx.department.findMany({ select: { id: true, parentId: true } })
  const headed = new Set(held.map((h) => h.departmentId))
  // the subtree: add children until nothing new comes in (the tree has no cycles, §6.2)
  for (let grew = true; grew; ) {
    grew = false
    for (const d of departments) {
      if (d.parentId && headed.has(d.parentId) && !headed.has(d.id)) {
        headed.add(d.id)
        grew = true
      }
    }
  }
  return headed
}

/** Loads the acting member's active roles, departments, and the departments they head (§2.2 DEPT_HEAD). */
export async function loadPrincipal(tx: TenantTx, ctx: Ctx): Promise<Principal> {
  if (ctx.actor.type === 'PLATFORM_ADMIN') return { kind: 'platform', platformAdminId: ctx.actor.platformAdminId }
  if (ctx.actor.type !== 'USER') return { kind: 'system' }
  const memberId = ctx.actor.memberId
  const [member, assignments] = await Promise.all([
    tx.member.findUnique({ where: { id: memberId }, select: { status: true, primaryDepartmentId: true } }),
    tx.roleAssignment.findMany({ where: { memberId, revokedAt: null }, select: { role: true, scopeDepartmentId: true } }),
  ])
  if (!member || member.status !== 'ACTIVE') return { kind: 'inactive', memberId }
  const storedRoles = new Set(assignments.map((r) => r.role).filter((r): r is StoredRole => (STORED_ROLES as readonly string[]).includes(r)))
  const departmentIds = new Set([...assignments.map((r) => r.scopeDepartmentId), member.primaryDepartmentId].filter((d): d is string => Boolean(d)))
  return { kind: 'member', memberId, roles: storedRoles, headOfDepartmentIds: await headedDepartments(tx, memberId, ctx.now), departmentIds }
}

/** Service-side check. Returns FORBIDDEN (403) when the capability does not cover this actor and resource. */
export async function authorize(tx: TenantTx, ctx: Ctx, capability: Capability, resource?: ResourceScope): Promise<Result<Principal>> {
  const principal = await loadPrincipal(tx, ctx)
  return isAllowed(principal, capability, resource) ? ok(principal) : err('FORBIDDEN', `missing capability ${capability}`, { capability })
}
