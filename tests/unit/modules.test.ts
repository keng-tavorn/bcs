import { describe, expect, it } from 'vitest'
import { checkModuleChange, MODULE_REQUIRES, MODULES } from '@/core/modules'

describe('[FR-PLT-011/AC2] switching modules follows the "ต้องมี" column of §4.11', () => {
  it('a module cannot be switched on while what it requires is off, and the answer names the missing module', () => {
    expect(checkModuleChange('SOURCING', true, [])).toEqual({ code: 'REQUIRES_DISABLED', missing: ['SUPPLIER'] })
    expect(checkModuleChange('RISK', true, ['PAY'])).toEqual({ code: 'REQUIRES_DISABLED', missing: ['SUPPLIER'] })
    expect(checkModuleChange('SOURCING', true, ['SUPPLIER'])).toBeNull()
  })

  it('every module that only needs CORE can be switched on from the start', () => {
    const coreOnly = MODULES.filter((m) => m !== 'CORE' && MODULE_REQUIRES[m].every((r) => r === 'CORE'))
    expect(coreOnly.length).toBeGreaterThan(0)
    for (const m of coreOnly) expect(checkModuleChange(m, true, [])).toBeNull()
  })

  it('a module cannot be switched off while an enabled module depends on it', () => {
    expect(checkModuleChange('SUPPLIER', false, ['SUPPLIER', 'SOURCING', 'RISK'])).toEqual({ code: 'REQUIRED_BY_ENABLED', dependents: ['SOURCING', 'RISK'] })
    expect(checkModuleChange('SUPPLIER', false, ['SUPPLIER'])).toBeNull()
  })

  it('CORE is always on', () => {
    expect(checkModuleChange('CORE', false, [])).toEqual({ code: 'CORE_ALWAYS_ON' })
  })

  it('switching to the state a module is already in is reported as no change', () => {
    expect(checkModuleChange('PAY', true, ['PAY'])).toEqual({ code: 'NO_CHANGE' })
    expect(checkModuleChange('PAY', false, [])).toEqual({ code: 'NO_CHANGE' })
  })

  it('the dependency table has no cycles and every required module exists', () => {
    for (const m of MODULES) {
      const seen = new Set<string>()
      const walk = (x: (typeof MODULES)[number]): void => {
        expect(seen.has(x), `cycle through ${x}`).toBe(false)
        seen.add(x)
        for (const r of MODULE_REQUIRES[x]) walk(r)
        seen.delete(x)
      }
      walk(m)
    }
  })
})
