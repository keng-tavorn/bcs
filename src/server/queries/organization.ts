import { forTenant } from '@/server/db/tenant'

// Read-only organization facts for screens (no writes in queries, §4.2).

export const MODULE_KEYS = ['CORE', 'PAY', 'SUPPLIER', 'SOURCING', 'RISK', 'CONTRACTS', 'AI', 'INTEGRATION', 'DOA_EVERYWHERE', 'BCS_GO'] as const
export type ModuleKey = (typeof MODULE_KEYS)[number]

/** Modules switched on for the organization (§4.11); menus of switched-off modules are hidden (FR-PLT-002 AC1). */
export async function listEnabledModules(organizationId: string): Promise<ModuleKey[]> {
  const rows = await forTenant(organizationId).orgModule.findMany({ where: { enabled: true }, select: { module: true } })
  return rows.map((r) => r.module)
}
