import { systemDb } from '../system'

// The job retention-due reads across organizations (ADR-124, BR-RET-04): HELD retentions whose day has come. Only ids
// leave here; each organization's are marked through its own command.

export async function dueRetentions(onOrBefore: Date): Promise<Array<{ id: string; organizationId: string }>> {
  return systemDb.retention.findMany({ where: { status: 'HELD', releaseDueOn: { lte: onOrBefore } }, orderBy: [{ organizationId: 'asc' }, { releaseDueOn: 'asc' }], select: { id: true, organizationId: true } })
}
