import type { LintOptions } from '@/core/doa'
import type { TenantTx } from '@/server/db/tenant'
import { doaAdminFacts, separatesDoaAdmins } from '@/server/doa/policy'
import { enabledModules } from '../modules'

/**
 * What the lint of a DOA version needs besides the version and the organization (BR-DOA-08): the modules that are on
 * (BR-DOA-23) and, for a version that separates the DOA administrators, who holds those roles now (BR-WF-17 · S6-09).
 */
export async function doaLintOptions(tx: TenantTx, sodPolicy: unknown): Promise<LintOptions> {
  const modules = await enabledModules(tx)
  return separatesDoaAdmins(sodPolicy) ? { modules, doaAdmins: await doaAdminFacts(tx) } : { modules }
}
