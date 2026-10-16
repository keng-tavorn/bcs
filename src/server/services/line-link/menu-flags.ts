import { stepApprovers, versionAt } from '@/core/doa'
import type { RichMenuInput } from '@/core/line-menu'
import { resolveReviewer, workflowVersionAt } from '@/core/workflow'
import { loadOrgSnapshot } from '@/server/doa/policy'
import { versionSnapshotFromRows } from '@/server/doa/snapshot'
import type { TenantTx } from '@/server/db/tenant'
import { loadWorkflowVersions } from '@/server/workflow/policy'

// What selectRichMenu needs of members at the time of a switch (BR-LINE-16 · S17-03): their status and roles, and
// whether they approve — read now, never from an event (BR-LINE-17):
//  - doaApprover: they hold a position that an approver of the DOA version in effect names (POSITION_OF_DEPARTMENT or
//    POSITION_OF_ORG, whatever the department; the approvers of a PARALLEL step or a committee too), or the version
//    names them (MEMBER). The version is the one routing uses now (versionAt).
//  - activeDelegate: they are the delegate of an ACTIVE delegation not revoked.
//  - workflowReviewer: a reviewer or the fallback of a rule of the workflow version in effect resolves to them by
//    BR-WF-08 (S6's tables, read only).
// The menu is not a permission: every page a button opens checks its own (BR-AUTH-05). Read inside the caller's
// transaction, all members at once, so a switch of every linked member reads the organization once.

export async function richMenuInputsOf(tx: TenantTx, memberIds: readonly string[], now: Date): Promise<Map<string, RichMenuInput>> {
  const ids = [...new Set(memberIds)]
  const out = new Map<string, RichMenuInput>()
  if (ids.length === 0) return out
  const [members, roles, holdings, delegations, doaVersions, workflowVersions] = await Promise.all([
    tx.member.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } }),
    tx.roleAssignment.findMany({ where: { memberId: { in: ids }, revokedAt: null }, select: { memberId: true, role: true } }),
    tx.positionAssignment.findMany({
      where: { memberId: { in: ids }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
      select: { memberId: true, position: { select: { code: true } } },
    }),
    tx.delegation.findMany({ where: { delegateMemberId: { in: ids }, status: 'ACTIVE', revokedAt: null }, select: { delegateMemberId: true } }),
    tx.doaVersion.findMany({ where: { status: { in: ['PUBLISHED', 'SUPERSEDED'] }, effectiveFrom: { lte: now } }, include: { rules: true } }),
    loadWorkflowVersions(tx),
  ])

  // DOA: the positions and the members the version in effect names as approvers
  const doa = versionAt(
    doaVersions.map((v) => versionSnapshotFromRows(v, v.rules)),
    now,
  )
  const namedPositions = new Set<string>()
  const namedMembers = new Set<string>()
  for (const approver of doa ? doa.rules.flatMap((r) => r.steps.flatMap(stepApprovers)) : []) {
    if (approver.kind === 'MEMBER') namedMembers.add(approver.memberId)
    else namedPositions.add(approver.position)
  }

  // Workflow: whoever its reviewers and fallbacks resolve to now (BR-WF-08); the structure is read only when a version is in effect
  const workflow = workflowVersionAt(workflowVersions, now)
  const reviewers = new Set<string>()
  if (workflow) {
    const org = await loadOrgSnapshot(tx)
    for (const rule of workflow.rules) {
      for (const spec of [...rule.reviewers, ...(rule.fallback ? [rule.fallback] : [])]) {
        const found = resolveReviewer(spec, org, now)
        if (found) reviewers.add(found.memberId)
      }
    }
  }

  const delegates = new Set(delegations.map((d) => d.delegateMemberId))
  for (const m of members) {
    const held = holdings.filter((h) => h.memberId === m.id).map((h) => h.position.code)
    out.set(m.id, {
      linked: true,
      memberStatus: m.status,
      roles: roles.filter((r) => r.memberId === m.id).map((r) => r.role),
      doaApprover: namedMembers.has(m.id) || held.some((code) => namedPositions.has(code)),
      activeDelegate: delegates.has(m.id),
      workflowReviewer: reviewers.has(m.id),
    })
  }
  return out
}
