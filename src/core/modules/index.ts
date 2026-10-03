// Module switching rules (spec §4.11, FR-PLT-011, FR-ADM-006 AC1). Pure: the service passes the current state.
// CORE is always on; switching a module on needs its required module on; switching off is refused while an
// enabled module depends on it. Pending documents of the module are checked by the service (MODULE_IN_USE, OQ-33).

export const MODULES = ['CORE', 'PAY', 'SUPPLIER', 'SOURCING', 'RISK', 'CONTRACTS', 'AI', 'INTEGRATION', 'DOA_EVERYWHERE', 'BCS_GO'] as const
export type Module = (typeof MODULES)[number]

/** "ต้องมี" column of §4.11 */
export const MODULE_REQUIRES: Readonly<Record<Module, readonly Module[]>> = {
  CORE: [],
  PAY: ['CORE'],
  SUPPLIER: ['CORE'],
  SOURCING: ['SUPPLIER'],
  RISK: ['SUPPLIER'],
  CONTRACTS: ['CORE'],
  AI: ['CORE'],
  INTEGRATION: ['CORE'],
  DOA_EVERYWHERE: ['CORE'],
  BCS_GO: ['CORE'],
}

export type ModuleChangeRefusal =
  | { readonly code: 'CORE_ALWAYS_ON' }
  | { readonly code: 'REQUIRES_DISABLED'; readonly missing: readonly Module[] }
  | { readonly code: 'REQUIRED_BY_ENABLED'; readonly dependents: readonly Module[] }
  | { readonly code: 'NO_CHANGE' }

export function isModule(value: string): value is Module {
  return (MODULES as readonly string[]).includes(value)
}

/** CORE counts as on even before its row exists. */
export function enabledSet(enabled: Iterable<Module>): ReadonlySet<Module> {
  return new Set<Module>(['CORE', ...enabled])
}

/** null when the change is allowed; otherwise why not. */
export function checkModuleChange(module: Module, enable: boolean, enabled: Iterable<Module>): ModuleChangeRefusal | null {
  const on = enabledSet(enabled)
  if (module === 'CORE') return enable ? { code: 'NO_CHANGE' } : { code: 'CORE_ALWAYS_ON' }
  if (enable) {
    if (on.has(module)) return { code: 'NO_CHANGE' }
    const missing = MODULE_REQUIRES[module].filter((m) => !on.has(m))
    return missing.length ? { code: 'REQUIRES_DISABLED', missing } : null
  }
  if (!on.has(module)) return { code: 'NO_CHANGE' }
  const dependents = MODULES.filter((m) => on.has(m) && MODULE_REQUIRES[m].includes(module))
  return dependents.length ? { code: 'REQUIRED_BY_ENABLED', dependents } : null
}
