import type { ApproverSpec, DepartmentSnapshot, OrgSnapshot } from './types'

// Finding the approver of a step (BR-DOA-04, BR-DOA-05): POSITION_OF_DEPARTMENT walks up from the charged department to
// the root and takes the first current holder; POSITION_OF_ORG looks at the root only; MEMBER names a person.
// A position whose holder is not an active member counts as vacant.

export type ApproverFound = {
  readonly found: true
  readonly memberId: string
  readonly resolvedFrom: string
  /** The department whose holder was taken (for the explanation); null for MEMBER */
  readonly department: DepartmentSnapshot | null
  /** Authority from a position may be delegated (BR-DLG-01); a named member's may not */
  readonly viaPosition: boolean
}

export type ApproverMissing = {
  readonly found: false
  /** "VP" or "MEMBER:<id>" */
  readonly position: string
  /** Department codes looked at, in order */
  readonly departments: readonly string[]
}

export function rootDepartment(org: OrgSnapshot): DepartmentSnapshot | null {
  return org.departments.find((d) => d.parentId === null) ?? null
}

/** The department and its ancestors up to the root, nearest first; stops if the tree loops (the database forbids it). */
export function departmentPath(org: OrgSnapshot, departmentId: string): DepartmentSnapshot[] {
  const byId = new Map(org.departments.map((d) => [d.id, d]))
  const path: DepartmentSnapshot[] = []
  const seen = new Set<string>()
  let current = byId.get(departmentId)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.push(current)
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  }
  return path
}

function activeMember(org: OrgSnapshot, memberId: string): boolean {
  return org.members.find((m) => m.id === memberId)?.active ?? false
}

/** Current holder of a position in one department at `at` (validFrom ≤ at < validTo). */
export function holderAt(org: OrgSnapshot, positionCode: string, departmentId: string, at: Date): string | null {
  const t = at.getTime()
  const holder = org.holders.find(
    (h) =>
      h.positionCode === positionCode &&
      h.departmentId === departmentId &&
      h.validFrom.getTime() <= t &&
      (h.validTo === null || t < h.validTo.getTime()) &&
      activeMember(org, h.memberId),
  )
  return holder?.memberId ?? null
}

export function resolveApprover(spec: ApproverSpec, chargedDepartmentId: string, org: OrgSnapshot, at: Date): ApproverFound | ApproverMissing {
  if (spec.kind === 'MEMBER') {
    return activeMember(org, spec.memberId)
      ? { found: true, memberId: spec.memberId, resolvedFrom: `MEMBER:${spec.memberId}`, department: null, viaPosition: false }
      : { found: false, position: `MEMBER:${spec.memberId}`, departments: [] }
  }
  const root = rootDepartment(org)
  const path = spec.kind === 'POSITION_OF_ORG' ? (root ? [root] : []) : departmentPath(org, chargedDepartmentId)
  for (const department of path) {
    const memberId = holderAt(org, spec.position, department.id, at)
    if (memberId) return { found: true, memberId, resolvedFrom: `POSITION:${spec.position}@${department.code}`, department, viaPosition: true }
  }
  return { found: false, position: spec.position, departments: path.map((d) => d.code) }
}

/** Every current holder of a position anywhere in the organization (lint: a position nobody holds is vacant). */
export function anyHolderAt(org: OrgSnapshot, positionCode: string, at: Date): boolean {
  return org.departments.some((d) => holderAt(org, positionCode, d.id, at) !== null)
}
