import { systemClock } from '@/lib/clock'
import { PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { getEnv, type AppEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { inngest } from '@/server/inngest'
import { organizationCount, seedDemoBase, seedDemoHistoryFromInputs } from '@/server/services/demo-seed'

// Job `staging-first-seed` (ADR-055): the first seed of staging, which the user approved (ADR-038 item 14, ADR-032). It
// runs on Vercel next to the database in Singapore because the database secrets exist only in the deployment's
// environment (Secret values cannot be read back) and Vercel builds run in Washington, where about 0.22 s a statement
// would push the history's commands past their 20 s transactions. Registered only when APP_ENV=staging
// (src/server/jobs/index.ts) and started by hand: Inngest dashboard → staging → Functions → staging-first-seed → Invoke
// (docs/runbooks/p0-07-inngest.md). It seeds only a database without organizations, so it never changes data that
// exists; seeding staging again is `pnpm demo:reset` by the person who owns it.
export const STAGING_FIRST_SEED_EVENT = 'bcs/staging.first_seed_requested'

export type FirstSeedRefusal = 'NOT_STAGING' | 'NO_SEED_PASSWORD' | 'NOT_EMPTY'

/** Why the first seed may not run here, or null when it may */
export function firstSeedRefusal(appEnv: AppEnv, password: string | undefined, organizations: number): FirstSeedRefusal | null {
  if (appEnv !== 'staging') return 'NOT_STAGING'
  if (!password || password.length < PASSWORD_MIN_LENGTH) return 'NO_SEED_PASSWORD'
  if (organizations > 0) return 'NOT_EMPTY'
  return null
}

// Each step is one call of /api/inngest (maxDuration 300 s): the base is some 460 statements, the history some 7,000
export const stagingFirstSeed = inngest.createFunction(
  { id: 'staging-first-seed', retries: 0, concurrency: { limit: 1 }, triggers: [{ event: STAGING_FIRST_SEED_EVENT }] },
  async ({ step }) => {
    const refusal = await step.run('check', async () => {
      const env = getEnv()
      return firstSeedRefusal(env.APP_ENV, env.SEED_DEV_PASSWORD, await organizationCount())
    })
    if (refusal) {
      logger.warn({ refusal }, 'staging-first-seed did not seed')
      return { seeded: false, refusal }
    }
    const base = await step.run('base', async () => {
      const env = getEnv()
      const seeded = await seedDemoBase(env, env.SEED_DEV_PASSWORD ?? '', systemClock)
      return {
        organizationId: seeded.organizationId,
        orgCode: seeded.orgCode,
        members: seeded.report.members.created,
        twoFactor: seeded.report.twoFactorEnabled,
        doaVersions: seeded.structure.doaVersions,
        budgetLines: seeded.budget.lines,
        suppliers: seeded.suppliers.suppliers,
      }
    })
    const history = await step.run('history', () => seedDemoHistoryFromInputs(base.organizationId, getEnv(), systemClock))
    const result = { seeded: true, ...base, history: history.byStatus }
    logger.info(result, 'staging-first-seed seeded the demo organization')
    return result
  },
)
