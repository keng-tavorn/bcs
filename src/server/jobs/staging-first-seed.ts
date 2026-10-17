import { systemClock } from '@/lib/clock'
import { PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { getEnv, type AppEnv, type Env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { inngest } from '@/server/inngest'
import type { InputProfile } from '@/server/seed/workbook'
import type { DemoHistoryReport } from '@/server/services/demo-history'
import { firstSeedPreflight, firstSeedState, seedDemoBase, seedDemoHistoryFromInputs, type FirstSeedState } from '@/server/services/demo-seed'

// Job `staging-first-seed` (ADR-055): the first seed of staging, which the user approved (ADR-038 item 14, ADR-032). It
// runs on Vercel next to the database in Singapore because the database secrets exist only in the deployment's
// environment (Secret values cannot be read back) and Vercel builds run in Washington, where about 0.22 s a statement
// would push the history's commands past their 20 s transactions. Registered only when APP_ENV=staging
// (src/server/jobs/index.ts) and started by hand: Inngest dashboard → staging → Functions → staging-first-seed → Invoke
// (docs/runbooks/p0-07-inngest.md part 3). It seeds an empty database, or finishes a first seed that stopped before
// its history (firstSeedState); it never touches anything else. Seeding staging again is the owner's reset (NEW-70).
export const STAGING_FIRST_SEED_EVENT = 'bcs/staging.first_seed_requested'

export type FirstSeedRefusal = 'NOT_STAGING' | 'NO_SEED_PASSWORD' | 'NOT_EMPTY'

/** Why this deployment may not run the first seed at all, or null */
export function environmentRefusal(appEnv: AppEnv, password: string | undefined): FirstSeedRefusal | null {
  if (appEnv !== 'staging') return 'NOT_STAGING'
  if (!password || password.length < PASSWORD_MIN_LENGTH) return 'NO_SEED_PASSWORD'
  return null
}

/** The database may get the first seed: it is empty, or it holds only a first seed that stopped before its history */
export function databaseTakesFirstSeed(state: FirstSeedState): boolean {
  return state.organizations === 0 || (state.organizations === 1 && state.unfinishedFirstSeed)
}

export interface FirstSeedBase {
  readonly organizationId: string
  readonly orgCode: string
  readonly members: number
  readonly twoFactor: number
  readonly doaVersions: number
  readonly budgetLines: number
  readonly suppliers: number
}

/** The job's steps as plain functions: what the job reads and writes, so a test can run the job without Inngest */
export interface FirstSeedDeps {
  readonly appEnv: AppEnv
  readonly password: string | undefined
  readonly state: () => Promise<FirstSeedState>
  readonly preflight: () => Promise<void>
  readonly seedBase: () => Promise<FirstSeedBase>
  readonly seedHistory: (organizationId: string) => Promise<DemoHistoryReport>
}

export interface FirstSeedStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>
}

export type FirstSeedResult = { readonly seeded: false; readonly refusal: FirstSeedRefusal } | ({ readonly seeded: true; readonly history: Readonly<Record<string, number>> } & FirstSeedBase)

/**
 * check (refuse, or make sure the inputs read and the bucket answers, before anything is written) → base → history. With
 * Inngest each step is memoized, so a call that runs a later step never repeats an earlier one.
 */
export async function runStagingFirstSeed(step: FirstSeedStep, deps: FirstSeedDeps): Promise<FirstSeedResult> {
  const check = await step.run('check', async () => {
    const refusal = environmentRefusal(deps.appEnv, deps.password) ?? (databaseTakesFirstSeed(await deps.state()) ? null : 'NOT_EMPTY')
    if (!refusal) await deps.preflight()
    return { refusal }
  })
  if (check.refusal) {
    logger.warn({ refusal: check.refusal }, 'staging-first-seed did not seed')
    return { seeded: false, refusal: check.refusal }
  }
  const base = await step.run('base', () => deps.seedBase())
  const history = await step.run('history', () => deps.seedHistory(base.organizationId))
  const result = { seeded: true as const, ...base, history: history.byStatus }
  logger.info(result, 'staging-first-seed seeded the demo organization')
  return result
}

/** The seed's base of a workbook (the demo one unless named), as the step result both staging jobs keep (plain JSON) */
export async function liveSeedBase(env: Env, profile: InputProfile = 'demo', options: { readonly sandbox?: boolean } = {}): Promise<FirstSeedBase> {
  const seeded = await seedDemoBase(env, env.SEED_DEV_PASSWORD ?? '', systemClock, profile, options)
  return {
    organizationId: seeded.organizationId,
    orgCode: seeded.orgCode,
    members: seeded.report.members.created,
    twoFactor: seeded.report.twoFactorEnabled,
    doaVersions: seeded.structure.doaVersions,
    budgetLines: seeded.budget.lines,
    suppliers: seeded.suppliers.suppliers,
  }
}

/** The job's real dependencies, read when it runs */
function liveDeps(): FirstSeedDeps {
  const env = getEnv()
  return {
    appEnv: env.APP_ENV,
    password: env.SEED_DEV_PASSWORD,
    state: firstSeedState,
    preflight: () => firstSeedPreflight(systemClock.now()),
    seedBase: () => liveSeedBase(env),
    seedHistory: (organizationId) => seedDemoHistoryFromInputs(organizationId, env, systemClock),
  }
}

/** Inngest's step as the job's step: every step returns plain JSON already */
export function jobStep(step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> }): FirstSeedStep {
  return { run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T> }
}

/**
 * One concurrency group for both staging jobs that write the demo data (this one and staging-demo-reset, ADR-056):
 * Inngest runs one step of the group at a time across the environment, so a seed and a reset never write together
 */
export const STAGING_DEMO_DATA_CONCURRENCY = { limit: 1, scope: 'env', key: '"staging-demo-data"' } as const

// retries 0: a failed run is looked at by people, never repeated by Inngest. Inngest may run several steps in one call
// of /api/inngest; each call has up to its maxDuration of 300 s (the base is some 460 statements, the history some 7,000).
export const stagingFirstSeed = inngest.createFunction(
  { id: 'staging-first-seed', retries: 0, concurrency: STAGING_DEMO_DATA_CONCURRENCY, triggers: [{ event: STAGING_FIRST_SEED_EVENT }] },
  async ({ step }) => runStagingFirstSeed(jobStep(step), liveDeps()),
)
