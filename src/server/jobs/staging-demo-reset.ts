import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { getEnv, type AppEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { inngest } from '@/server/inngest'
import type { DemoHistoryReport } from '@/server/services/demo-history'
import {
  demoOrganizationId,
  demoOrgCode,
  demoResetConfirmation,
  firstSeedPreflight,
  otherOrganizations,
  putLineChannel,
  seedDemoHistoryFromInputs,
  takeLineChannel,
  wipeDemoData,
  type CarriedLineChannel,
  type LineChannelTake,
} from '@/server/services/demo-seed'
import { environmentRefusal, jobStep, liveSeedBase, STAGING_DEMO_DATA_CONCURRENCY, type FirstSeedBase, type FirstSeedRefusal, type FirstSeedStep } from './staging-first-seed'

// Job `staging-demo-reset` (D-07, ADR-056, the user chose it 2026-10-07): puts staging back to its state before the
// demo — every table emptied as the migrator, then the demo organization seeded with its history, the same seed as
// `pnpm demo:reset` on this machine; the LINE channel the owner set up is carried over. It runs on Vercel next to the
// database because the database secrets exist only there (ADR-055). Registered only when APP_ENV=staging and started
// by hand: Inngest dashboard → staging → Functions → staging-demo-reset → Invoke with
// {"data": {"confirm": "<org code>-<today in Thai time>"}} (docs/DEMO_RUNBOOK.md §2). Wiping staging needs the owner's
// approval every time (spec §17.4): typing today's confirmation is that approval.
export const STAGING_DEMO_RESET_EVENT = 'bcs/staging.demo_reset_requested'

// The Invoke box is the event payload, so {"data": {"confirm": …}} arrives as data.confirm; a payload that was taken as
// the data itself carries it one level down. Anything else is no confirmation.
export const DemoResetEventData = z
  .object({ confirm: z.string().optional(), data: z.object({ confirm: z.string().optional() }).loose().optional() })
  .loose()
  .transform((d) => (d.confirm ?? d.data?.confirm)?.trim())

export type DemoResetRefusal = FirstSeedRefusal | 'CONFIRMATION_MISMATCH' | 'OTHER_ORGANIZATIONS'

/** Whether the LINE channel of the demo organization came through the reset (NOT_OPENED: it had one whose secrets did not open, so it is gone) */
export type LineCarry = 'KEPT' | 'NONE' | 'NOT_OPENED'

export interface DemoResetDeps {
  readonly appEnv: AppEnv
  readonly password: string | undefined
  readonly confirm: string | undefined
  readonly now: () => Date
  readonly demoOrgCode: () => Promise<string>
  readonly otherOrganizations: (demoCode: string) => Promise<string[]>
  readonly preflight: () => Promise<void>
  readonly demoOrganizationId: (demoCode: string) => Promise<string | null>
  readonly takeLine: (organizationId: string) => Promise<LineChannelTake>
  readonly wipe: (demoCode: string) => Promise<number>
  readonly seedBase: () => Promise<FirstSeedBase>
  readonly putLine: (organizationId: string, carried: CarriedLineChannel) => Promise<void>
  readonly seedHistory: (organizationId: string) => Promise<DemoHistoryReport>
}

export type DemoResetResult =
  | { readonly reset: false; readonly refusal: DemoResetRefusal; readonly expected?: string; readonly others?: readonly string[] }
  | ({ readonly reset: true; readonly tables: number; readonly line: LineCarry; readonly history: Readonly<Record<string, number>> } & FirstSeedBase)

interface Guard {
  readonly refusal: DemoResetRefusal | null
  readonly demoCode?: string
  readonly expected?: string
  readonly others?: readonly string[]
}

/** Environment, today's confirmation and no organization but the demo one; reads only, writes nothing */
async function guard(deps: DemoResetDeps): Promise<Guard> {
  const early = environmentRefusal(deps.appEnv, deps.password)
  if (early) return { refusal: early }
  const demoCode = await deps.demoOrgCode()
  const expected = demoResetConfirmation(demoCode, deps.now())
  if (deps.confirm !== expected) return { refusal: 'CONFIRMATION_MISMATCH', expected }
  // Staging holds sample data only (OQ-19); an organization that is not the demo one is someone's, so nothing is wiped
  const others = await deps.otherOrganizations(demoCode)
  if (others.length > 0) return { refusal: 'OTHER_ORGANIZATIONS', others }
  return { refusal: null, demoCode }
}

/**
 * check (the guard, then the inputs, the fiscal year and the bucket — all before anything is touched) → reset (the
 * guard again, so a step run on its own later cannot skip today's confirmation; the LINE channel taken into memory; the
 * wipe, which checks the organizations again in its own transaction; the base; the LINE channel put back) → history.
 * The secrets of the LINE channel never leave the reset step. A run that stops after the wipe can be started again with
 * the same confirmation the same day.
 */
export async function runStagingDemoReset(step: FirstSeedStep, deps: DemoResetDeps): Promise<DemoResetResult> {
  const check = await step.run('check', async () => {
    const result = await guard(deps)
    if (!result.refusal) await deps.preflight()
    return result
  })
  if (check.refusal) {
    logger.warn({ refusal: check.refusal }, 'staging-demo-reset did not reset')
    return { reset: false, refusal: check.refusal, ...(check.expected ? { expected: check.expected } : {}), ...(check.others ? { others: [...check.others] } : {}) }
  }
  const reset = await step.run('reset', async () => {
    const again = await guard(deps)
    if (again.refusal || !again.demoCode) throw new Error(`staging-demo-reset stopped before the wipe: ${again.refusal ?? 'NO_DEMO_CODE'}`)
    const before = await deps.demoOrganizationId(again.demoCode)
    const taken: LineChannelTake = before ? await deps.takeLine(before) : { state: 'NONE' }
    const tables = await deps.wipe(again.demoCode)
    const base = await deps.seedBase()
    if (taken.state === 'TAKEN') await deps.putLine(base.organizationId, taken.channel)
    const line: LineCarry = taken.state === 'TAKEN' ? 'KEPT' : taken.state
    return { tables, line, base }
  })
  const history = await step.run('history', () => deps.seedHistory(reset.base.organizationId))
  const result = { reset: true as const, tables: reset.tables, line: reset.line, ...reset.base, history: history.byStatus }
  logger.info(result, 'staging-demo-reset put staging back to its state before the demo')
  return result
}

function liveDeps(data: unknown): DemoResetDeps {
  const env = getEnv()
  const confirm = DemoResetEventData.safeParse(data)
  return {
    appEnv: env.APP_ENV,
    password: env.SEED_DEV_PASSWORD,
    confirm: confirm.success ? confirm.data : undefined,
    now: () => systemClock.now(),
    demoOrgCode,
    otherOrganizations,
    preflight: () => firstSeedPreflight(systemClock.now()),
    demoOrganizationId,
    takeLine: takeLineChannel,
    wipe: (demoCode) => wipeDemoData(env, demoCode),
    seedBase: () => liveSeedBase(env),
    putLine: putLineChannel,
    seedHistory: (organizationId) => seedDemoHistoryFromInputs(organizationId, env, systemClock),
  }
}

// retries 0: a failed run is looked at by people, never repeated by Inngest
export const stagingDemoReset = inngest.createFunction(
  { id: 'staging-demo-reset', retries: 0, concurrency: STAGING_DEMO_DATA_CONCURRENCY, triggers: [{ event: STAGING_DEMO_RESET_EVENT }] },
  async ({ event, step }) => runStagingDemoReset(jobStep(step), liveDeps(event.data)),
)
