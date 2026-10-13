import type { WorkflowVersionSnapshot } from '@/core/workflow'
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
