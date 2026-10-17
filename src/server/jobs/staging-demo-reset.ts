import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { getEnv, type AppEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { inngest } from '@/server/inngest'
import { INPUT_WORKBOOKS, inputProfileOf, type InputProfile } from '@/server/seed/workbook'
import { joinHistoryReports, type DemoHistoryPart, type DemoHistoryReport } from '@/server/services/demo-history'
import {
  demoHistoryPartsFromInputs,
  demoOrganizationId,
  demoOrgCode,
  demoResetConfirmation,
  firstSeedPreflight,
  otherOrganizations,
  putLineChannel,
  sampleOrgCodes,
  seedDemoHistoryPartFromInputs,
  seedP1Sandbox,
  takeLineChannel,
  wipeDemoData,
  type CarriedLineChannel,
  type LineChannelTake,
} from '@/server/services/demo-seed'
import { environmentRefusal, jobStep, liveSeedBase, STAGING_DEMO_DATA_CONCURRENCY, type FirstSeedBase, type FirstSeedRefusal, type FirstSeedStep } from './staging-first-seed'

// Job `staging-demo-reset` (D-07, ADR-056, the user chose it 2026-10-07): puts staging back to its state before the
// demo — every table emptied as the migrator, then the sample organization of an input workbook seeded with its history,
// the same seed as `pnpm db:reset` (or `pnpm db:reset:p1`) on this machine; the LINE channel the owner set up is carried
// over. It runs on Vercel next to the database because the database secrets exist only there (ADR-055). Registered only
// when APP_ENV=staging and started by hand: Inngest dashboard → staging → Functions → staging-demo-reset → Invoke with
// {"data": {"confirm": "<org code>-<today in Thai time>"}} for the demo workbook, or
// {"data": {"inputs": "p1", "confirm": "<code of the phase-1 organization>-<today>"}} for the synthetic data of phase 1
// (P1-11, ADR-073; docs/DEMO_RUNBOOK.md §2). Wiping staging needs the owner's approval every time (spec §17.4): typing
// today's confirmation, which names the organization the chosen workbook makes, is that approval.
// P1-11: the seed runs in steps that each end inside one call of /api/inngest (maxDuration 300 s): the base, the UAT
// sandbox of phase 1, then the history in parts (demoHistoryParts). Checkpointing runs steps one after another in a call
// for at most CHECKPOINT_MAX_RUNTIME, then goes on in a new call, so no call holds more than one long step past that.
export const STAGING_DEMO_RESET_EVENT = 'bcs/staging.demo_reset_requested'

/** How long one call of /api/inngest keeps running further steps before Inngest calls again (the SDK's own default for serve) */
export const CHECKPOINT_MAX_RUNTIME = '10s'

const ResetFields = z.object({ confirm: z.string().optional(), inputs: z.string().optional() })

// The Invoke box is the event payload, so {"data": {"confirm": …}} arrives as data.confirm; a payload that was taken as
// the data itself carries it one level down. Anything else is no confirmation. `inputs` names the workbook (unset: demo).
export const DemoResetEventData = ResetFields.extend({ data: ResetFields.loose().optional() })
  .loose()
  .transform((d) => {
    const fields = d.confirm !== undefined || d.inputs !== undefined ? d : (d.data ?? {})
    return { confirm: fields.confirm?.trim(), inputs: fields.inputs?.trim() }
  })

export type DemoResetRefusal = FirstSeedRefusal | 'UNKNOWN_INPUTS' | 'CONFIRMATION_MISMATCH' | 'OTHER_ORGANIZATIONS'

/** Whether the LINE channel of the sample organization came through the reset (NOT_OPENED: it had one whose secrets did not open, so it is gone) */
export type LineCarry = 'KEPT' | 'NONE' | 'NOT_OPENED'

export interface DemoResetDeps {
  readonly appEnv: AppEnv
  readonly password: string | undefined
  readonly confirm: string | undefined
  /** The input workbook to seed, as typed: unset or empty is the demo workbook */
  readonly inputs: string | undefined
  readonly now: () => Date
  /** The code of the organization a workbook makes */
  readonly orgCode: (inputs: InputProfile) => Promise<string>
  /** Every organization the seed makes from the workbooks: the reset refuses while staging holds another */
  readonly sampleOrgCodes: () => Promise<readonly string[]>
  readonly otherOrganizations: (sampleCodes: readonly string[]) => Promise<string[]>
  readonly preflight: (inputs: InputProfile) => Promise<void>
  readonly historyParts: (inputs: InputProfile) => Promise<readonly DemoHistoryPart[]>
  readonly organizationId: (code: string) => Promise<string | null>
  readonly takeLine: (organizationId: string) => Promise<LineChannelTake>
  readonly wipe: (sampleCodes: readonly string[]) => Promise<number>
  readonly seedBase: (inputs: InputProfile) => Promise<FirstSeedBase>
  readonly putLine: (organizationId: string, carried: CarriedLineChannel) => Promise<void>
  /** The UAT sandbox of the phase-1 organization (S6-21), its code */
  readonly seedSandbox: (organizationId: string) => Promise<string>
  readonly seedHistoryPart: (organizationId: string, inputs: InputProfile, index: number, now: Date) => Promise<DemoHistoryReport>
}

export type DemoResetResult =
  | { readonly reset: false; readonly refusal: DemoResetRefusal; readonly expected?: string; readonly others?: readonly string[] }
  | ({
      readonly reset: true
      readonly inputs: InputProfile
      readonly tables: number
      readonly line: LineCarry
      readonly sandbox: string | null
      readonly historyParts: number
      readonly history: Readonly<Record<string, number>>
    } & FirstSeedBase)

interface Guard {
  readonly refusal: DemoResetRefusal | null
  readonly inputs?: InputProfile
  readonly code?: string
  readonly samples?: readonly string[]
  readonly expected?: string
  readonly others?: readonly string[]
}

/** Environment, a known workbook, today's confirmation and no organization but sample ones; reads only, writes nothing */
async function guard(deps: DemoResetDeps): Promise<Guard> {
  const early = environmentRefusal(deps.appEnv, deps.password)
  if (early) return { refusal: early }
  let inputs: InputProfile
  try {
    inputs = inputProfileOf(deps.inputs)
  } catch {
    return { refusal: 'UNKNOWN_INPUTS' }
  }
  const code = await deps.orgCode(inputs)
  const expected = demoResetConfirmation(code, deps.now())
  if (deps.confirm !== expected) return { refusal: 'CONFIRMATION_MISMATCH', expected }
  // Staging holds sample data only (OQ-19); an organization the seed does not make is someone's, so nothing is wiped.
  // The sample ones are those of both workbooks, so staging can go from one to the other (P1-11, ADR-073).
  const samples = await deps.sampleOrgCodes()
  const others = await deps.otherOrganizations(samples)
  if (others.length > 0) return { refusal: 'OTHER_ORGANIZATIONS', others }
  return { refusal: null, inputs, code, samples }
}

/**
 * The LINE channel to carry: that of the organization being seeded if staging has it, otherwise that of the other
 * workbook's organization (staging went from one workbook to the other); the sandbox has no LINE (BR-UAT-01)
 */
async function takeCarriedLine(deps: DemoResetDeps, inputs: InputProfile): Promise<LineChannelTake> {
  const profiles = [inputs, ...(Object.keys(INPUT_WORKBOOKS) as InputProfile[]).filter((p) => p !== inputs)]
  for (const profile of profiles) {
    const id = await deps.organizationId(await deps.orgCode(profile))
    if (!id) continue
    const taken = await deps.takeLine(id)
    if (taken.state !== 'NONE') return taken
  }
  return { state: 'NONE' }
}

/**
 * check (the guard, then the inputs, the fiscal year and the bucket — all before anything is touched — and the parts of
 * the history) → reset (the guard and those checks again, so a step run on its own later skips none of them; the LINE
 * channel taken into memory; the wipe, which checks the organizations again in its own transaction; the base; the LINE
 * channel put back) → sandbox (phase 1) → history, one step a part, every part at the time the reset step ended.
 * The secrets of the LINE channel never leave the reset step. A run that stops after the wipe can be started again with
 * the same confirmation the same day.
 */
export async function runStagingDemoReset(step: FirstSeedStep, deps: DemoResetDeps): Promise<DemoResetResult> {
  const check = await step.run('check', async () => {
    const result = await guard(deps)
    if (result.refusal || !result.inputs) return { ...result, parts: [] as DemoHistoryPart['kind'][] }
    await deps.preflight(result.inputs)
    return { ...result, parts: (await deps.historyParts(result.inputs)).map((p) => p.kind) }
  })
  if (check.refusal || !check.inputs) {
    const refusal = check.refusal ?? 'UNKNOWN_INPUTS'
    logger.warn({ refusal }, 'staging-demo-reset did not reset')
    return { reset: false, refusal, ...(check.expected ? { expected: check.expected } : {}), ...(check.others ? { others: [...check.others] } : {}) }
  }
  const inputs = check.inputs
  const reset = await step.run('reset', async () => {
    const again = await guard(deps)
    if (again.refusal || !again.samples || again.inputs !== inputs) throw new Error(`staging-demo-reset stopped before the wipe: ${again.refusal ?? 'INPUTS_CHANGED'}`)
    await deps.preflight(inputs)
    const taken = await takeCarriedLine(deps, inputs)
    const tables = await deps.wipe(again.samples)
    const base = await deps.seedBase(inputs)
    if (taken.state === 'TAKEN') await deps.putLine(base.organizationId, taken.channel)
    const line: LineCarry = taken.state === 'TAKEN' ? 'KEPT' : taken.state
    // The history of every part counts back from this instant, as the whole history does from the end of the base
    return { tables, line, base, seededAt: deps.now().toISOString() }
  })
  const sandbox = inputs === 'p1' ? await step.run('sandbox', () => deps.seedSandbox(reset.base.organizationId)) : null
  const reports: DemoHistoryReport[] = []
  for (const [index, kind] of check.parts.entries()) {
    reports.push(await step.run(`history-${index + 1}-${kind.toLowerCase()}`, () => deps.seedHistoryPart(reset.base.organizationId, inputs, index, new Date(reset.seededAt))))
  }
  const history = joinHistoryReports(reports)
  const result = { reset: true as const, inputs, tables: reset.tables, line: reset.line, ...reset.base, sandbox, historyParts: check.parts.length, history: history.byStatus }
  logger.info(result, 'staging-demo-reset put staging back to its state before the demo')
  return result
}

function liveDeps(data: unknown): DemoResetDeps {
  const env = getEnv()
  const fields = DemoResetEventData.safeParse(data)
  return {
    appEnv: env.APP_ENV,
    password: env.SEED_DEV_PASSWORD,
    confirm: fields.success ? fields.data.confirm : undefined,
    inputs: fields.success ? fields.data.inputs : undefined,
    now: () => systemClock.now(),
    orgCode: demoOrgCode,
    sampleOrgCodes,
    otherOrganizations,
    preflight: (inputs) => firstSeedPreflight(systemClock.now(), inputs),
    historyParts: demoHistoryPartsFromInputs,
    organizationId: demoOrganizationId,
    takeLine: takeLineChannel,
    wipe: (sampleCodes) => wipeDemoData(env, sampleCodes),
    seedBase: (inputs) => liveSeedBase(env, inputs, { sandbox: false }),
    putLine: (organizationId, carried) => putLineChannel(organizationId, carried, systemClock.now()),
    seedSandbox: async (organizationId) => {
      const totpKey = env.SEED_TOTP_KEY
      const made = await seedP1Sandbox(organizationId, { password: env.SEED_DEV_PASSWORD ?? '', ...(totpKey ? { totpKey } : {}), pin: env.SEED_DEV_PIN ?? null, now: systemClock.now() })
      return made.code
    },
    seedHistoryPart: (organizationId, inputs, index, now) => seedDemoHistoryPartFromInputs(organizationId, env, now, inputs, index),
  }
}

// retries 0: a failed run is looked at by people, never repeated by Inngest
export const stagingDemoReset = inngest.createFunction(
  {
    id: 'staging-demo-reset',
    retries: 0,
    concurrency: STAGING_DEMO_DATA_CONCURRENCY,
    checkpointing: { maxRuntime: CHECKPOINT_MAX_RUNTIME },
    triggers: [{ event: STAGING_DEMO_RESET_EVENT }],
  },
  async ({ event, step }) => runStagingDemoReset(jobStep(step), liveDeps(event.data)),
)
