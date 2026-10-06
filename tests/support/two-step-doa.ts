import { toJsonSafe } from '@/lib/json'
import { prisma } from '@/server/db/client'
import { ruleJson } from '@/server/doa/snapshot'
import { versionSnapshots } from '../golden/doa-fixtures'
import { createDoaOrg, type DoaOrg } from './doa-org'

// An organization of the §7.4 fixtures whose DOA gives purchase-request bands a second step, for the tests of a
// co-assignee on a step that has steps after it (BR-SLA-04, NEW-47, NEW-46). By default PR-01 (up to 20,000) is the DM
// of the charged department, then the VP of its division; PR-02 (up to 100,000) the VP, then the COO; PR-03 the CEO.
// The approver of the band above PR-01 is then the COO (the last step of PR-02, ADR-048 item 2), so a request of CON
// escalated at step 1 has three different people: dm_con, its co-assignee coo, and vp_ops for step 2. With
// `{ secondSteps: ['PR-01'] }` PR-02 keeps its one step (the VP), so the band above PR-01 ends with the approver of
// PR-01's own step 2 — the case where escalating step 1 must pass over the VP (NEW-47). admin is ORG_ADMIN.

type SecondStep = { kind: 'POSITION_OF_DEPARTMENT' | 'POSITION_OF_ORG'; position: string }
const SECOND_STEPS: Readonly<Record<string, SecondStep>> = {
  'PR-01': { kind: 'POSITION_OF_DEPARTMENT', position: 'VP' },
  'PR-02': { kind: 'POSITION_OF_ORG', position: 'COO' },
}

export async function createTwoStepOrg(options: { readonly secondSteps?: ReadonlyArray<keyof typeof SECOND_STEPS> } = {}): Promise<DoaOrg> {
  const which = new Set<string>(options.secondSteps ?? Object.keys(SECOND_STEPS))
  const own = await createDoaOrg({ doa: false })
  await prisma.roleAssignment.create({ data: { organizationId: own.organizationId, memberId: own.member.admin!, role: 'ORG_ADMIN', grantedAt: new Date('2026-01-01T00:00:00Z') } })
  const v1 = versionSnapshots().find((v) => v.versionNo === 1)!
  const version = await prisma.doaVersion.create({
    data: {
      organizationId: own.organizationId,
      code: 'DOA-TWO-STEP',
      versionNo: 1,
      status: 'PUBLISHED',
      effectiveFrom: v1.effectiveFrom,
      amountBasis: 'GROSS',
      selfApprovalPolicy: 'ESCALATE_NEXT_BAND',
      collapseDuplicateApprovers: true,
      stepUpThresholdSatang: 10_000_000n,
      escalationPolicy: { remindPct: 0.5, escalateAfterBusinessHours: 8 },
      sodPolicy: { approverMayReceive: false, requesterMayReceive: true },
      publishedAt: v1.effectiveFrom,
    },
  })
  for (const rule of v1.rules) {
    const json = ruleJson(rule)
    const second = which.has(rule.code) ? SECOND_STEPS[rule.code] : undefined
    const steps = second ? [...json.steps, { approver: second, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' }] : json.steps
    await prisma.doaRule.create({ data: { organizationId: own.organizationId, doaVersionId: version.id, code: rule.code, documentType: json.documentType, priority: rule.priority, when: toJsonSafe(json.when) as object, steps } })
  }
  return own
}
