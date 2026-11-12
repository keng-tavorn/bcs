import { systemDb } from './system'

// Supplier risk's reads outside one tenant (S11-09 · §4.8): which organizations the daily job of RISK runs for. Only this,
// here in the db layer, so src/server/services/risk never holds the unscoped client.

/** The organizations with RISK on: risk-review-daily runs once for each (FR-RSK-205 AC2) */
export async function organizationsWithRisk(): Promise<string[]> {
  return (await systemDb.orgModule.findMany({ where: { module: 'RISK', enabled: true }, select: { organizationId: true }, orderBy: { organizationId: 'asc' } })).map((m) => m.organizationId)
}
