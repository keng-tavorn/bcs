import { isCommitteeStep, type ApproverSpec } from '@/core/doa'
import type { ApprovalSubject } from '@/core/sod'
import type { OpenTaskOnTree, ReviewerSpec } from '@/core/workflow'
import { escapeLike } from '@/server/db/like'
import type { TenantTx } from '@/server/db/tenant'
import { versionSnapshotFromRows } from '@/server/doa/snapshot'
import { workflowVersionFromRows } from '@/server/workflow/snapshot'
import { subjectFacts } from '../sla/subject'

// The open tasks a department move may move (S6-08 · BR-WF-14 · FR-WF-104 AC2): open or waiting for an answer, on a
// running route, found from a position — with the spec they were found by: the DOA step of the route's own rule (a step
// of one approver; a committee's slot is left where it is), or the reviewer of the workflow rule they answer for (the
// reviewer or the fallback whose position they hold) — and the department and conflicts of their document.

const position = (resolvedFrom: string) => /^POSITION:([^@]+)@/.exec(resolvedFrom)?.[1] ?? null

export async function openTasksOnTree(tx: TenantTx): Promise<OpenTaskOnTree[]> {
  const tasks = await tx.approvalTask.findMany({
    where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, resolvedFrom: { startsWith: escapeLike('POSITION:') }, step: { route: { status: 'ACTIVE' } } },
    select: {
      id: true,
      resolvedFrom: true,
      assigneeMemberId: true,
      principalMemberId: true,
      workflowRuleCodes: true,
      step: { select: { kind: true, mode: true, doaStepNo: true, route: { select: { subjectType: true, subjectId: true, doaVersionId: true, ruleCode: true, workflowVersionId: true } } } },
    },
    orderBy: { id: 'asc' },
  })
  const doaVersions = new Map<string, ReturnType<typeof versionSnapshotFromRows>>()
  const workflowVersions = new Map<string, ReturnType<typeof workflowVersionFromRows>>()
  const out: OpenTaskOnTree[] = []
  for (const t of tasks) {
    const route = t.step.route
    const pos = position(t.resolvedFrom)
    let spec: ApproverSpec | ReviewerSpec | null = null
    if (t.step.kind === 'REVIEW' && route.workflowVersionId) {
      if (!workflowVersions.has(route.workflowVersionId)) {
        const v = await tx.workflowVersion.findUniqueOrThrow({ where: { id: route.workflowVersionId }, include: { rules: true } })
        workflowVersions.set(v.id, workflowVersionFromRows(v, v.rules))
      }
      const rules = workflowVersions.get(route.workflowVersionId)!.rules.filter((r) => t.workflowRuleCodes.includes(r.code))
      spec = rules.flatMap((r) => [...r.reviewers, ...(r.fallback ? [r.fallback] : [])]).find((s) => s.kind === 'POSITION_AT' && s.position === pos) ?? null
    } else if (t.step.mode === 'SEQUENTIAL' && t.step.doaStepNo !== null) {
      if (!doaVersions.has(route.doaVersionId)) {
        const v = await tx.doaVersion.findUniqueOrThrow({ where: { id: route.doaVersionId }, include: { rules: true } })
        doaVersions.set(v.id, versionSnapshotFromRows(v, v.rules))
      }
      const step = doaVersions.get(route.doaVersionId)!.rules.find((r) => r.code === route.ruleCode)?.steps[t.step.doaStepNo - 1]
      spec = step && !isCommitteeStep(step) ? step.approver : null
    }
    if (!spec) continue
    const facts = await subjectFacts(tx, route.subjectType as ApprovalSubject, route.subjectId)
    if (!facts.chargedDepartmentId) continue
    out.push({
      id: t.id,
      resolvedFrom: t.resolvedFrom,
      approver: spec,
      chargedDepartmentId: facts.chargedDepartmentId,
      assigneeMemberId: t.assigneeMemberId,
      principalMemberId: t.principalMemberId,
      conflictMemberIds: [...facts.conflictMemberIds],
    })
  }
  return out
}
