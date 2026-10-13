import type { ReviewInput, WorkflowVersionSnapshot } from '@/core/workflow'
import type { TenantTx } from '@/server/db/tenant'
import { workflowVersionFromRows } from './snapshot'

// The workflow versions routing reads (spec §7.17 BR-WF-06, BR-WF-12): those published or superseded, picked by their
// dates (workflowVersionAt), as loadRoutePolicy reads the DOA versions.

const ROUTING_STATUSES = ['PUBLISHED', 'SUPERSEDED'] as const

export async function loadWorkflowVersions(tx: TenantTx): Promise<WorkflowVersionSnapshot[]> {
  const versions = await tx.workflowVersion.findMany({ where: { status: { in: [...ROUTING_STATUSES] } }, include: { rules: true } })
  return versions.map((v) => workflowVersionFromRows(v, v.rules))
}

/** The fields of the current form of every request type, for the lint of BR-WF-11 */
export async function loadRequestTypeFields(tx: TenantTx): Promise<Record<string, string[]>> {
  const types = await tx.requestType.findMany({ select: { code: true, currentFormVersion: { select: { schema: true } } } })
  const fieldsOf = (schema: unknown): string[] => {
    const fields = (schema as { fields?: Array<{ id?: unknown }> } | null)?.fields ?? []
    return fields.map((f) => f.id).filter((id): id is string => typeof id === 'string')
  }
  return Object.fromEntries(types.map((t) => [t.code, fieldsOf(t.currentFormVersion?.schema)]))
}

/** What the conditions of the reviewer rules read of a request (BR-WF-07): the rest of ReviewInput comes with the route */
export type ReviewFacts = Omit<ReviewInput, 'requesterMemberId' | 'conflictMemberIds' | 'at' | 'basisAmountSatang'>

/**
 * The facts of a request for its REVIEW step, read the same way at the submit and when the route is checked again
 * (G-2): the line categories, the account codes of the budget lines it uses (its own and any line's own), the amounts
 * VAT included and before VAT, and the answers of its form.
 */
export async function requestReviewFacts(
  tx: TenantTx,
  request: {
    readonly requestTypeCode: string
    readonly grossSatang: bigint
    readonly netSatang: bigint
    readonly formData: unknown
    readonly budgetLineId: string | null
    readonly lines: ReadonlyArray<{ readonly categoryCode: string | null; readonly budgetLineId: string | null }>
  },
): Promise<ReviewFacts> {
  const lineIds = [...new Set([request.budgetLineId, ...request.lines.map((l) => l.budgetLineId)].filter((id): id is string => id !== null))]
  const budgetLines = lineIds.length ? await tx.budgetLine.findMany({ where: { id: { in: lineIds } }, select: { accountCode: true } }) : []
  const unique = (values: ReadonlyArray<string | null>) => [...new Set(values.filter((v): v is string => typeof v === 'string' && v !== ''))].sort()
  const fields = request.formData && typeof request.formData === 'object' ? (request.formData as Record<string, unknown>) : {}
  return {
    requestType: request.requestTypeCode,
    amountGross: request.grossSatang,
    amountNet: request.netSatang,
    lineCategories: unique(request.lines.map((l) => l.categoryCode)),
    budgetAccountCodes: unique(budgetLines.map((b) => b.accountCode)),
    fields,
  }
}
