import type { TenantTx } from '@/server/db/tenant'
import { versionSnapshotFromRows, type DoaRuleRow, type DoaVersionRow } from '@/server/doa/snapshot'
import { comparisonBaselineId } from '@/server/queries/doa'
import { boundaryComparison, type BoundaryCompareTable } from './compare'

// The boundary table a version is sent and approved with (FR-DOA-009 AC3, BR-DOA-08 (ช)): the rule and approvers at
// every band's upper end, and one satang above it, in this version beside the version it is compared with (the one in
// effect just before it starts, src/server/queries/doa.ts comparisonBaselineId). When that table has rows, the drafter
// ticks it before sending (doa.submit, doa.submit_initial_package) and the approver before approving: these checks live
// in the services (BR-AUTH-05), so every channel asks for the same tick. A version whose bands have no upper end — and
// whose baseline has none either — has no table, and nothing to tick. Read inside the command's transaction.

/** A stored version with its rules, as the submit and approve commands lock and read it */
export type VersionWithRules = DoaVersionRow & { readonly rules: readonly DoaRuleRow[] }

/** The boundary table of a version beside its baseline, as the version's page shows it; [] when it has none */
export async function boundaryTablesOf(tx: TenantTx, version: VersionWithRules, now: Date): Promise<BoundaryCompareTable[]> {
  const baselineId = await comparisonBaselineId(tx, version, now)
  const baseline = baselineId ? await tx.doaVersion.findUniqueOrThrow({ where: { id: baselineId }, include: { rules: true } }) : null
  return boundaryComparison(baseline ? versionSnapshotFromRows(baseline, baseline.rules) : null, versionSnapshotFromRows(version, version.rules))
}

/** Whether sending or approving this version needs the boundary table ticked as checked (FR-DOA-009 AC3) */
export async function boundaryTableRequired(tx: TenantTx, version: VersionWithRules, now: Date): Promise<boolean> {
  return (await boundaryTablesOf(tx, version, now)).length > 0
}

/** The same by the version's id, for a command that has not read the version's rules (the approval of a DOA_VERSION task) */
export async function boundaryTableRequiredFor(tx: TenantTx, versionId: string, now: Date): Promise<boolean> {
  const version = await tx.doaVersion.findUniqueOrThrow({ where: { id: versionId }, include: { rules: true } })
  return boundaryTableRequired(tx, version, now)
}
