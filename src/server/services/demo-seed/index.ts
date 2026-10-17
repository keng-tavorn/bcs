import { THAI_TIME_ZONE } from '@/core/thai/date'
import type { Clock } from '@/lib/clock'
import { MS_PER_DAY } from '@/lib/constants'
import type { Env } from '@/lib/env'
import { sandboxSettingsOf } from '@/lib/uat'
import { checkBucket } from '@/integrations/storage'
import { listOrganizationsForPlatform } from '@/server/db/lookups'
import { wipeAllData } from '@/server/db/sql/staging-wipe'
import { forTenant } from '@/server/db/tenant'
import { fiscalYearDates, seedBudget } from '@/server/seed/budget'
import { budgetLineOn } from '@/server/seed/budget-keys'
import { restoreLineChannelRow } from '@/server/seed/line-channel-restore'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { seedP1Ai } from '@/server/seed/p1-ai'
import { seedP1Modules } from '@/server/seed/p1-modules'
import { approversWithoutPin, seedDevPins } from '@/server/seed/pins'
import { linkHistoryToCatalog, seedCatalog } from '@/server/seed/catalog'
import { parseBudget, parseCatalogItems, parseCostCenters, parseGlAccounts, parseHistory, parseSites, parseSuppliers } from '@/server/seed/sheets'
import { seedSuppliers } from '@/server/seed/suppliers'
import { seedAccountCodes } from '@/server/seed/account-codes'
import { parseApProfile, seedApProfile } from '@/server/seed/ap-profile'
import { parseBankAccounts, seedBankAccounts } from '@/server/seed/bank-accounts'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { parseWorkflowReviewers, seedWorkflow } from '@/server/seed/workflow'
import { INPUT_WORKBOOKS, loadInputWorkbook, type InputProfile } from '@/server/seed/workbook'
import { budgetKeyLines, demoHistoryParts, demoHistoryStarted, seedDemoHistory, seedDemoHistoryPart, type DemoHistoryPart, type DemoHistoryReport } from '@/server/services/demo-history'
import { seedLineChannel } from '@/server/services/line-channel'
import { openLineSecret, sealLineSecret } from '@/server/services/line-channel/secrets'

// The demo seed (spec §5.4, Appendix A) in two parts, shared by `pnpm db:seed` (prisma/seed.ts) and the staging seed job
// (src/server/jobs/staging-first-seed.ts, ADR-055): the base — VAT rates, the demo organization with its users,
// structure, DOA version 1, forms, holidays, budget, suppliers, delivery sites, LINE channel and PINs from
// docs/inputs/BCS_inputs_v1_demo.xlsx — then the requests of the past of sheet Demo_History through the real services
// (D-01). The base is safe to run again (nothing is duplicated); the history refuses to finish one a run left half done.
// The callers check APP_ENV and SEED_DEV_PASSWORD and turn errors into words. `pnpm db:seed` may name the synthetic
// workbook of phase 1 instead (profile p1, P1-02: organization SIMEC, two fiscal years, sheet Request_History); the first seed
// of staging keeps the demo workbook, and its reset seeds either (P1-11, ADR-073).

export type DemoSeedBase = Awaited<ReturnType<typeof seedDemoBase>>

/** `sandbox: false` leaves out the UAT sandbox of phase 1, which the staging reset makes in a step of its own (seedP1Sandbox, P1-11) */
export async function seedDemoBase(env: Env, password: string, clock: Clock, profile: InputProfile = 'demo', options: { readonly sandbox?: boolean } = {}) {
  const taxRates = await seedTaxRates()
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS[profile])
  const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const totpKey = env.SEED_TOTP_KEY
  const report = await seedDemoOrganization(input, { password, ...(totpKey ? { totpKey } : {}), now: clock.now() })
  const structure = await seedOrgStructure(report.organizationId, input.users, parseOrgStructureInput(workbook), clock.now())
  // The phase-1 organization switches PAY AI BCS_GO on once its DOA has their rules (ADR-070); the demo keeps CORE alone
  const modules = profile === 'p1' ? await seedP1Modules(report.organizationId, clock.now()) : { enabled: 0 }
  // The parallel reviewers of the phase-1 organization from its sheet Workflow_Reviewers (S6-04); the demo has none
  const workflowInput = parseWorkflowReviewers(workbook, input.org.code)
  const workflow = workflowInput ? await seedWorkflow(report.organizationId, workflowInput, clock.now()) : null
  // Its agents switched on and the month's AI credits (S13-02); the demo organization has no AI
  const ai = profile === 'p1' ? await seedP1Ai(report.organizationId, clock.now()) : null
  const budget = await seedBudget(report.organizationId, parseBudget(workbook), clock.now(), parseCostCenters(workbook))
  const suppliers = await seedSuppliers(report.organizationId, { suppliers: parseSuppliers(workbook), sites: parseSites(workbook) }, clock.now())
  // The account codes invoice lines are coded with (S8-04, sheet GL_Accounts of phase 1; the demo workbook has none)
  const accountCodes = await seedAccountCodes(report.organizationId, parseGlAccounts(workbook))
  // The catalogue and its agreed prices for this fiscal year (S6-10, sheet Items of phase 1; the demo workbook has none)
  const catalog = await seedCatalog(report.organizationId, parseCatalogItems(workbook), clock.now())
  // S8-12: payee types, income types, credit days, e-Tax and registry flags of the suppliers, and retention by request type
  const apProfile = await seedApProfile(report.organizationId, parseApProfile(workbook), clock.now())
  // S9-01: the organization's own accounts and one account per supplier (sheets CompanyBankAccounts, SupplierPayment)
  const bankAccounts = await seedBankAccounts(report.organizationId, parseBankAccounts(workbook), clock.now())
  // The LINE channel from the LINE_* values of the environment, when they are set (S5-01)
  const lineChannel = await seedLineChannel(report.organizationId, env, clock.now())
  // The transaction PIN of the demo approvers (S5-05, FR-AUTH-005, ADR-047 item 9): SEED_DEV_PIN when it is set, and the
  // approvers who do not hold it then (another PIN of their own, or locked) by employee code; without it nobody gets a
  // PIN, the approvers set their own at /settings/pin, and the history steps up with a one-time PIN. Never printed.
  const seedPin = env.SEED_DEV_PIN ?? null
  const pins = seedPin ? await seedDevPins(report.organizationId, seedPin, clock.now()) : null
  const pinless = seedPin ? await approversWithoutPin(report.organizationId, seedPin, clock.now()) : []
  // S6-21 (BR-UAT-01 BR-UAT-04): SIMEC-UAT, the UAT sandbox of the phase-1 organization, on this machine
  const sandbox = profile === 'p1' && options.sandbox !== false ? await seedP1Sandbox(report.organizationId, { password, ...(totpKey ? { totpKey } : {}), pin: seedPin, now: clock.now() }) : null
  return { orgCode: input.org.code, organizationId: report.organizationId, taxRates, report, structure, modules, workflow, ai, budget, suppliers, accountCodes, catalog, apProfile, bankAccounts, lineChannel, pins, pinless, sandbox }
}

/** The code of the phase-1 organization's sandbox: its own code and "-UAT" */
export const sandboxCode = (code: string) => `${code}-UAT`

/**
 * S6-21: the UAT sandbox of the phase-1 organization on this machine (BR-UAT-04's exception for the sample organization):
 * the same structure, positions, DOA version 1 and workflow version 1 from the same workbook, test users of the same
 * employee codes at @<domain>-uat (simec-uat.bcs.local), and nothing else — no budget, supplier, catalogue, request or
 * history. In a real deployment the customer sets their sandbox up themselves (platform.sandbox.manage makes it empty).
 */
export async function seedP1Sandbox(
  productionOrganizationId: string,
  options: { password: string; totpKey?: string; pin: string | null; now: Date; /** Tests seed under their own code and e-mail prefix */ rename?: { code: string; emailPrefix: string } },
) {
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
  const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const uatEmail = (email: string) => email.replace(/@([^.@]+)\./, '@$1-uat.')
  const sandbox = {
    ...input,
    // Production's settings with LINE and the chat off, as the sandbox command makes them (BR-UAT-01 · ADR-174)
    settings: sandboxSettingsOf(input.settings),
    org: { ...input.org, code: options.rename?.code ?? sandboxCode(input.org.code), legalNameTh: `${input.org.legalNameTh} (ระบบทดลอง)`, displayName: `${input.org.displayName ?? input.org.code} UAT` },
    users: input.users.map((u) => ({ ...u, email: `${options.rename?.emailPrefix ?? ''}${uatEmail(u.email)}` })),
  }
  const report = await seedDemoOrganization(sandbox, { password: options.password, ...(options.totpKey ? { totpKey: options.totpKey } : {}), now: options.now, sandboxOf: productionOrganizationId })
  const structure = await seedOrgStructure(report.organizationId, sandbox.users, parseOrgStructureInput(workbook), options.now)
  // The workflow keeps the production code (WF-SIMEC), so what is tried here imports there as its next version
  const workflowInput = parseWorkflowReviewers(workbook, input.org.code)
  const workflow = workflowInput ? await seedWorkflow(report.organizationId, workflowInput, options.now) : null
  if (options.pin) await seedDevPins(report.organizationId, options.pin, options.now)
  return { organizationId: report.organizationId, code: sandbox.org.code, created: report.organizationCreated, structure, workflow }
}

/** The requests of the past (sheet Demo_History, or History of phase 1), made through the real services for the organization of the base */
export async function seedDemoHistoryFromInputs(organizationId: string, env: Env, clock: Clock, profile: InputProfile = 'demo'): Promise<DemoHistoryReport> {
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS[profile])
  const report = await seedDemoHistory(organizationId, parseHistory(workbook), clock.now(), { pin: env.SEED_DEV_PIN ?? null, budgetKeys: budgetKeyLines(parseBudget(workbook)) })
  // The history's lines of catalogue items point at them (S6-10); the demo has no catalogue
  await linkHistoryToCatalog(organizationId)
  return report
}

/** P1-11: the parts the history of a workbook is made in (seedDemoHistoryPart) */
export async function demoHistoryPartsFromInputs(profile: InputProfile): Promise<DemoHistoryPart[]> {
  return demoHistoryParts(parseHistory(await loadInputWorkbook(INPUT_WORKBOOKS[profile])))
}

/**
 * P1-11: part `index` of the history of a workbook, made for the organization of the base with every part's `now` the
 * same; the last part also points the history's lines at the catalogue, as seedDemoHistoryFromInputs does
 */
export async function seedDemoHistoryPartFromInputs(organizationId: string, env: Env, now: Date, profile: InputProfile, index: number): Promise<DemoHistoryReport> {
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS[profile])
  const rows = parseHistory(workbook)
  const report = await seedDemoHistoryPart(organizationId, rows, now, { pin: env.SEED_DEV_PIN ?? null, budgetKeys: budgetKeyLines(parseBudget(workbook)) }, index)
  if (index === demoHistoryParts(rows).length - 1) await linkHistoryToCatalog(organizationId)
  return report
}

/** What the staging seed job looks at before it writes anything (ADR-055) */
export interface FirstSeedState {
  /** Organizations in the database, of every tenant */
  readonly organizations: number
  /**
   * The only organization is the demo organization of the input workbook, its history has not started and it has no
   * request: what a first seed leaves when it stopped before its history (the base is safe to run again)
   */
  readonly unfinishedFirstSeed: boolean
}

export async function firstSeedState(): Promise<FirstSeedState> {
  const organizations = await listOrganizationsForPlatform()
  const only = organizations.length === 1 ? organizations[0] : undefined
  if (!only) return { organizations: organizations.length, unfinishedFirstSeed: false }
  const demoCode = parseDemoOrgInput(await loadInputWorkbook(), loadOrgSettingsYaml()).org.code
  const unfinished = only.code === demoCode && !(await demoHistoryStarted(only.id)) && (await forTenant(only.id).request.count()) === 0
  return { organizations: 1, unfinishedFirstSeed: unfinished }
}

/**
 * A day the demo history needs — today, or the first day of a row (daysAgo calendar days back, as the history counts
 * it) — lies outside the fiscal year of the row's budget line: the sheets need the current year (as
 * DemoHistoryOutOfYearError says when the history itself finds it, after the base is seeded)
 */
export class DemoYearError extends Error {
  constructor(
    readonly day: string,
    readonly fiscalYear: string,
    readonly ref: string | null,
  ) {
    super(
      `${ref ? `แถว ${ref} ของประวัติ demo ต้องใช้วันที่ ${day}` : `วันนี้ ${day}`} ซึ่งอยู่นอกปีงบ ${fiscalYear} จึงยังไม่ได้แตะข้อมูล · แก้ชีต Budget Holidays และ Demo_History ในไฟล์ inputs ให้เป็นปีปัจจุบัน (ช่วงต้นปีงบให้ daysAgo ของทุกแถวไม่ย้อนไปก่อนวันเริ่มปีงบ) แล้วรัน pnpm inputs:check commit และ deploy ใหม่`,
    )
    this.name = 'DemoYearError'
  }
}

/**
 * What has to work before a staging seed job writes or wipes anything: the input workbook reads (organization and
 * history), today lies inside the fiscal year of every budget line the history uses, and the bucket answers — so the
 * likeliest failures stop the job while the database is untouched. A row of phase 1 names a budget key (P1-11): its
 * key has a line in the fiscal year of its first day and of today.
 */
export async function firstSeedPreflight(now: Date, profile: InputProfile = 'demo'): Promise<void> {
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS[profile])
  parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const history = parseHistory(workbook)
  const budget = parseBudget(workbook)
  const yearOfLine = new Map(budget.map((line) => [line.code, line.fiscalYear]))
  const today = thaiDay(now)
  const keyLines = {
    budgetLines: new Map<string, string>(),
    linesByYear: new Map(budget.map((line) => [`${line.fiscalYear}|${line.code}`, line.code])),
    fiscalYears: [...new Set(budget.map((line) => line.fiscalYear))].map((code) => {
      const { startsOn, endsOn } = fiscalYearDates(code)
      return { code, startsOn: startsOn.toISOString().slice(0, 10), endsOn: endsOn.toISOString().slice(0, 10) }
    }),
    budgetKeys: budgetKeyLines(budget),
  }
  for (const row of history) {
    if ('key' in row.budget) {
      const firstDay = thaiDay(new Date(now.getTime() - row.daysAgo * MS_PER_DAY))
      for (const day of [firstDay, today]) {
        if (budgetLineOn(keyLines, row.budget, day) === undefined) throw new DemoYearError(day, keyLines.fiscalYears.find((y) => y.startsOn <= day && day <= y.endsOn)?.code ?? '-', row.ref)
      }
      continue
    }
    const code = yearOfLine.get(row.budget.line)
    if (!code) continue
    const { startsOn, endsOn } = fiscalYearDates(code)
    const [first, last] = [startsOn.toISOString().slice(0, 10), endsOn.toISOString().slice(0, 10)]
    if (today < first || today > last) throw new DemoYearError(today, code, null)
    const firstDay = thaiDay(new Date(now.getTime() - row.daysAgo * MS_PER_DAY))
    if (firstDay < first) throw new DemoYearError(firstDay, code, row.ref)
  }
  await checkBucket()
}

// ---------- staging demo reset (ADR-056) ----------

/** The organization's code of an input workbook (the demo one unless named), read from it (never from code, NG-12) */
export async function demoOrgCode(profile: InputProfile = 'demo'): Promise<string> {
  return parseDemoOrgInput(await loadInputWorkbook(INPUT_WORKBOOKS[profile]), loadOrgSettingsYaml()).org.code
}

/**
 * P1-11 (ADR-073, the user approved 2026-10-17): the codes of every organization the seed makes from the input workbooks —
 * the organization of each workbook, and the UAT sandbox seedDemoBase makes for the phase-1 one (SIMEC and SIMEC-UAT next
 * to the demo organization). Staging may hold these and nothing else for its reset to wipe it.
 */
export async function sampleOrgCodes(): Promise<string[]> {
  const codes: string[] = []
  for (const profile of Object.keys(INPUT_WORKBOOKS) as InputProfile[]) {
    const code = await demoOrgCode(profile)
    codes.push(code, ...(profile === 'p1' ? [sandboxCode(code)] : []))
  }
  return [...new Set(codes)]
}

/** The day of an instant in Thai time, as YYYY-MM-DD */
export function thaiDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: THAI_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** What the person types to reset staging: the demo organization's code and today in Thai time, as pnpm demo:reset asks */
export function demoResetConfirmation(orgCode: string, now: Date): string {
  return `${orgCode}-${thaiDay(now)}`
}

/** Codes of the organizations in the database that are not sample ones (sampleOrgCodes): the reset refuses while there is one */
export async function otherOrganizations(sampleCodes: readonly string[]): Promise<string[]> {
  const samples = new Set(sampleCodes)
  return (await listOrganizationsForPlatform()).map((o) => o.code).filter((code) => !samples.has(code))
}

/**
 * Empties every table but the migration record, as the migrator, refusing in the same transaction while an organization
 * that is not a sample one exists; the caller has checked APP_ENV and the confirmation
 */
export async function wipeDemoData(env: Env, sampleCodes: readonly string[]): Promise<number> {
  return wipeAllData(env.DIRECT_URL, sampleCodes)
}

/** The id of the organization of this code when it exists */
export async function demoOrganizationId(code: string): Promise<string | null> {
  return (await listOrganizationsForPlatform()).find((o) => o.code === code)?.id ?? null
}

/**
 * The LINE channel the owner set up for the demo organization (line-demo-setup part 3), held in memory across a reset:
 * the webhook path (channelKey) registered at LINE and the rich menus made there stay valid. It holds secrets in
 * clear, so it is never a step result, a log field or an error message.
 */
export interface CarriedLineChannel {
  readonly channelKey: string
  readonly providerId: string
  readonly messagingChannelId: string
  readonly channelSecret: string
  readonly channelAccessToken: string
  readonly liffId: string | null
  readonly liffChannelId: string | null
  readonly richMenuLinkedId: string | null
  readonly richMenuUnlinkedId: string | null
  readonly active: boolean
  /** S17-04: the rich menu sets by role (LineRichMenuVariant), so members keep their menus through the reset */
  readonly richMenuSets?: readonly { readonly variantKey: string; readonly richMenuId: string; readonly madeAt: Date }[]
}

export type LineChannelTake = { readonly state: 'NONE' } | { readonly state: 'NOT_OPENED' } | { readonly state: 'TAKEN'; readonly channel: CarriedLineChannel }

/** The organization's LINE channel with its secrets opened; NOT_OPENED when a secret does not open with ENCRYPTION_KEY */
export async function takeLineChannel(organizationId: string): Promise<LineChannelTake> {
  const row = await forTenant(organizationId).lineChannelConfig.findFirst()
  if (!row) return { state: 'NONE' }
  const channelSecret = openLineSecret(organizationId, 'channelSecret', row.channelSecretEnc)
  const channelAccessToken = openLineSecret(organizationId, 'channelAccessToken', row.channelAccessTokenEnc)
  if (channelSecret === null || channelAccessToken === null) return { state: 'NOT_OPENED' }
  const { channelKey, providerId, messagingChannelId, liffId, liffChannelId, richMenuLinkedId, richMenuUnlinkedId, active } = row
  const richMenuSets = await forTenant(organizationId).lineRichMenuVariant.findMany({ select: { variantKey: true, richMenuId: true, madeAt: true }, orderBy: { variantKey: 'asc' } })
  return { state: 'TAKEN', channel: { channelKey, providerId, messagingChannelId, channelSecret, channelAccessToken, liffId, liffChannelId, richMenuLinkedId, richMenuUnlinkedId, active, richMenuSets } }
}

/**
 * Puts a carried LINE channel on the (new) demo organization after the reset's seed: its secrets sealed again for this
 * organization (NFR-SEC-07 binds them to it), replacing what the seed made from the LINE_* values, if anything
 */
export async function putLineChannel(organizationId: string, carried: CarriedLineChannel, now: Date): Promise<void> {
  const { channelSecret, channelAccessToken, richMenuSets = [], ...values } = carried
  await restoreLineChannelRow(
    organizationId,
    {
      ...values,
      channelSecretEnc: sealLineSecret(organizationId, 'channelSecret', channelSecret),
      channelAccessTokenEnc: sealLineSecret(organizationId, 'channelAccessToken', channelAccessToken),
    },
    now,
    richMenuSets,
  )
}
