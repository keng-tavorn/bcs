import { describe, expect, it } from 'vitest'
import { demoResetRefusal, thaiToday } from '../../scripts/demo-reset'

// D-07 and FR-PLT-007 AC2: `pnpm demo:reset` puts the demo back in one command. On this machine it is pnpm db:reset;
// staging is wiped only with a confirmation that names the demo organization and today's Thai date; production never.

const env = (vars: Record<string, string | undefined>) => vars as NodeJS.ProcessEnv
const NOW = new Date('2026-10-03T17:30:00Z') // 00:30 on 4 Oct 2026 in Bangkok
const local = { APP_ENV: 'local', DATABASE_URL: 'postgresql://bcs_app:x@localhost:5432/bcs', DIRECT_URL: 'postgresql://bcs_migrator:x@localhost:5432/bcs' }
const staging = { APP_ENV: 'staging', DATABASE_URL: 'postgresql://app:x@ep-calm.ap-southeast-1.aws.neon.tech/bcs', DIRECT_URL: 'postgresql://owner:x@ep-calm.ap-southeast-1.aws.neon.tech/bcs' }

describe('[FR-PLT-007/AC2] pnpm demo:reset wipes only what it may, and staging only on a typed confirmation', () => {
  it('counts the day in Thai time', () => {
    expect(thaiToday(NOW)).toBe('2026-10-04')
  })

  it('on this machine behaves as pnpm db:reset: the local database only', () => {
    expect(demoResetRefusal(env(local), undefined, 'DEMO', NOW)).toBeNull()
    expect(demoResetRefusal(env({ ...local, DIRECT_URL: staging.DIRECT_URL }), undefined, 'DEMO', NOW)).not.toBeNull()
  })

  it('refuses production and any other environment', () => {
    for (const appEnv of ['production', 'preview', undefined]) {
      expect(demoResetRefusal(env({ ...staging, APP_ENV: appEnv }), 'DEMO-2026-10-04', 'DEMO', NOW)).toMatch(/production/)
    }
  })

  it('wipes staging only when the confirmation names the demo organization and today', () => {
    expect(demoResetRefusal(env(staging), undefined, 'DEMO', NOW)).toContain('--confirm=DEMO-2026-10-04')
    expect(demoResetRefusal(env(staging), 'DEMO-2026-10-03', 'DEMO', NOW)).not.toBeNull()
    expect(demoResetRefusal(env(staging), 'OTHER-2026-10-04', 'DEMO', NOW)).not.toBeNull()
    expect(demoResetRefusal(env({ ...staging, DIRECT_URL: undefined }), 'DEMO-2026-10-04', 'DEMO', NOW)).not.toBeNull()
    expect(demoResetRefusal(env(staging), 'DEMO-2026-10-04', 'DEMO', NOW)).toBeNull()
  })

  it('never repeats a host or a password', () => {
    const refusal = demoResetRefusal(env(staging), undefined, 'DEMO', NOW) ?? ''
    expect(refusal).not.toContain('neon.tech')
    expect(refusal).not.toContain('owner:x')
  })
})
