import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { getEnv, type AppEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { inngest } from '@/server/inngest'
import type { DemoHistoryReport } from '@/server/services/demo-history'
import { demoOrgCode, demoResetConfirmation, firstSeedPreflight, otherOrganizations, seedDemoHistoryFromInputs, wipeDemoData } from '@/server/services/demo-seed'
import { environmentRefusal, jobStep, liveSeedBase, STAGING_DEMO_DATA_CONCURRENCY, type FirstSeedBase, type FirstSeedRefusal, type FirstSeedStep } from './staging-first-seed'

// Job `staging-demo-reset` (D-07, ADR-056, the user chose it 2026-10-07): puts staging back to its state before the
// demo — every table emptied as the migrator, then the demo organization seeded with its history, the same seed as
// `pnpm demo:reset` on this machine. It runs on Vercel next to the database because the database secrets exist only
// there (ADR-055). Registered only when APP_ENV=staging and started by hand: Inngest dashboard → staging → Functions →
// staging-demo-reset → Invoke with {"confirm": "<org code>-<today in Thai time>"} (docs/DEMO_RUNBOOK.md §2). Wiping
// staging needs the owner's approval every time (spec §17.4): typing today's confirmation is that approval.
export const STAGING_DEMO_RESET_EVENT = 'bcs/staging.demo_reset_requested'

export const DemoResetEventData = z.object({ confirm: z.string().optional() }).loose()

export type DemoResetRefusal = FirstSeedRefusal | 'CONFIRMATION_MISMATCH' | 'OTHER_ORGANIZATIONS'

export interface DemoResetDeps {
  readonly appEnv: AppEnv
  readonly password: string | undefined
  readonly confirm: string | undefined
  readonly now: () => Date
  readonly demoOrgCode: () => Promise<string>
  readonly otherOrganizations: (demoCode: string) => Promise<string[]>
  readonly preflight: () => Promise<void>
  readonly wipe: () => Promise<number>
  readonly seedBase: () => Promise<FirstSeedBase>
  readonly seedHistory: (organizationId: string) => Promise<DemoHistoryReport>
}

export type DemoResetResult =
  | { readonly reset: false; readonly refusal: DemoResetRefusal; readonly expected?: string; readonly others?: readonly string[] }
  | ({ readonly reset: true; readonly tables: number; readonly history: Readonly<Record<string, number>> } & FirstSeedBase)

/**
 * check (environment, today's confirmation, no organization but the demo one, the inputs read and the bucket answers —
 * all before anything is touched) → wipe → base → history. A run that stops after the wipe can be started again with
 * the same confirmation the same day: the wipe of an empty database changes nothing.
 */
export async function runStagingDemoReset(step: FirstSeedStep, deps: DemoResetDeps): Promise<DemoResetResult> {
  const check = await step.run('check', async (): Promise<{ refusal: DemoResetRefusal | null; expected?: string; others?: string[] }> => {
    const early = environmentRefusal(deps.appEnv, deps.password)
    if (early) return { refusal: early }
    const code = await deps.demoOrgCode()
    const expected = demoResetConfirmation(code, deps.now())
    if (deps.confirm !== expected) return { refusal: 'CONFIRMATION_MISMATCH', expected }
    // Staging holds sample data only (OQ-19); an organization that is not the demo one is someone's, so nothing is wiped
    const others = await deps.otherOrganizations(code)
    if (others.length > 0) return { refusal: 'OTHER_ORGANIZATIONS', others }
    await deps.preflight()
    return { refusal: null }
  })
  if (check.refusal) {
    logger.warn({ refusal: check.refusal }, 'staging-demo-reset did not reset')
    return { reset: false, refusal: check.refusal, ...(check.expected ? { expected: check.expected } : {}), ...(check.others ? { others: check.others } : {}) }
  }
  const tables = await step.run('wipe', () => deps.wipe())
  const base = await step.run('base', () => deps.seedBase())
  const history = await step.run('history', () => deps.seedHistory(base.organizationId))
  const result = { reset: true as const, tables, ...base, history: history.byStatus }
  logger.info(result, 'staging-demo-reset put staging back to its state before the demo')
  return result
}

function liveDeps(data: unknown): DemoResetDeps {
  const env = getEnv()
  const parsed = DemoResetEventData.safeParse(data)
  return {
    appEnv: env.APP_ENV,
    password: env.SEED_DEV_PASSWORD,
    confirm: parsed.success ? parsed.data.confirm?.trim() : undefined,
    now: () => systemClock.now(),
    demoOrgCode,
    otherOrganizations,
    preflight: firstSeedPreflight,
    wipe: () => wipeDemoData(env),
    seedBase: () => liveSeedBase(env),
    seedHistory: (organizationId) => seedDemoHistoryFromInputs(organizationId, env, systemClock),
  }
}

// retries 0: a failed run is looked at by people, never repeated by Inngest
export const stagingDemoReset = inngest.createFunction(
  { id: 'staging-demo-reset', retries: 0, concurrency: STAGING_DEMO_DATA_CONCURRENCY, triggers: [{ event: STAGING_DEMO_RESET_EVENT }] },
  async ({ event, step }) => runStagingDemoReset(jobStep(step), liveDeps(event.data)),
)
