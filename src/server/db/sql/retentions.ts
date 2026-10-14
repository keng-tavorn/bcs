import { systemDb } from '../system'

// The job retention-due reads across organizations (ADR-124, BR-RET-04): HELD retentions whose day has come and that
// were not announced yet (no retention.release_due), so those still waiting to be released never crowd out the new
// ones. Only ids leave here; each organization's are marked through its own command.

export async function dueRetentions(onOrBefore: Date): Promise<Array<{ id: string; organizationId: string }>> {
  const due = await systemDb.retention.findMany({ where: { status: 'HELD', releaseDueOn: { lte: onOrBefore } }, orderBy: [{ organizationId: 'asc' }, { releaseDueOn: 'asc' }, { id: 'asc' }], select: { id: true, organizationId: true } })
  if (due.length === 0) return []
  const told = new Set((await systemDb.event.findMany({ where: { type: 'retention.release_due', aggregateType: 'Retention', aggregateId: { in: due.map((r) => r.id) } }, select: { aggregateId: true } })).map((e) => e.aggregateId))
  return due.filter((r) => !told.has(r.id))
}
