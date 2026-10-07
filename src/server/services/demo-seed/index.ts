import { THAI_TIME_ZONE } from '@/core/thai/date'
import type { Clock } from '@/lib/clock'
import { MS_PER_DAY } from '@/lib/constants'
import type { Env } from '@/lib/env'
import { checkBucket } from '@/integrations/storage'
import { listOrganizationsForPlatform } from '@/server/db/lookups'
import { wipeAllData } from '@/server/db/sql/staging-wipe'
import { forTenant } from '@/server/db/tenant'
import { fiscalYearDates, seedBudget } from '@/server/seed/budget'
import { restoreLineChannelRow } from '@/server/seed/line-channel-restore'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { approversWithoutPin, seedDevPins } from '@/server/seed/pins'
import { parseBudget, parseDemoHistory, parseSites, parseSuppliers } from '@/server/seed/sheets'
import { seedSuppliers } from '@/server/seed/suppliers'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { loadInputWorkbook } from '@/server/seed/workbook'
import { demoHistoryStarted, seedDemoHistory, type DemoHistoryReport } from '@/server/services/demo-history'
import { seedLineChannel } from '@/server/services/line-channel'
import { openLineSecret, sealLineSecret } from '@/server/services/line-channel/secrets'

// The demo seed (spec §5.4, Appendix A) in two parts, shared by `pnpm db:seed` (prisma/seed.ts) and the staging seed job
// (src/server/jobs/staging-first-seed.ts, ADR-055): the base — VAT rates, the demo organization with its users,
// structure, DOA version 1, forms, holidays, budget, suppliers, delivery sites, LINE channel and PINs from
// docs/inputs/BCS_inputs_v1_demo.xlsx — then the requests of the past of sheet Demo_History through the real services
// (D-01). The base is safe to run again (nothing is duplicated); the history refuses to finish one a run left half done.
// The callers check APP_ENV and SEED_DEV_PASSWORD and turn errors into words.

export type DemoSeedBase = Awaited<ReturnType<typeof seedDemoBase>>

export async function seedDemoBase(env: Env, password: string, clock: Clock) {
  const taxRates = await seedTaxRates()
  const workbook = await loadInputWorkbook()
  const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const totpKey = env.SEED_TOTP_KEY
  const report = await seedDemoOrganization(input, { password, ...(totpKey ? { totpKey } : {}), now: clock.now() })
  const structure = await seedOrgStructure(report.organizationId, input.users, parseOrgStructureInput(workbook), clock.now())
  const budget = await seedBudget(report.organizationId, parseBudget(workbook), clock.now())
  const suppliers = await seedSuppliers(report.organizationId, { suppliers: parseSuppliers(workbook), sites: parseSites(workbook) }, clock.now())
  // The LINE channel from the LINE_* values of the environment, when they are set (S5-01)
  const lineChannel = await seedLineChannel(report.organizationId, env, clock.now())
  // The transaction PIN of the demo approvers (S5-05, FR-AUTH-005, ADR-047 item 9): SEED_DEV_PIN when it is set, and the
  // approvers who do not hold it then (another PIN of their own, or locked) by employee code; without it nobody gets a
  // PIN, the approvers set their own at /settings/pin, and the history steps up with a one-time PIN. Never printed.
  const seedPin = env.SEED_DEV_PIN ?? null
  const pins = seedPin ? await seedDevPins(report.organizationId, seedPin, clock.now()) : null
  const pinless = seedPin ? await approversWithoutPin(report.organizationId, seedPin, clock.now()) : []
  return { orgCode: input.org.code, organizationId: report.organizationId, taxRates, report, structure, budget, suppliers, lineChannel, pins, pinless }
}

/** The requests of the past of sheet Demo_History, made through the real services for the organization of the base */
export async function seedDemoHistoryFromInputs(organizationId: string, env: Env, clock: Clock): Promise<DemoHistoryReport> {
  const workbook = await loadInputWorkbook()
  return seedDemoHistory(organizationId, parseDemoHistory(workbook), clock.now(), { pin: env.SEED_DEV_PIN ?? null })
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
 * likeliest failures stop the job while the database is untouched
 */
export async function firstSeedPreflight(now: Date): Promise<void> {
  const workbook = await loadInputWorkbook()
  parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const history = parseDemoHistory(workbook)
  const yearOfLine = new Map(parseBudget(workbook).map((line) => [line.code, line.fiscalYear]))
  const today = thaiDay(now)
  for (const row of history) {
    const code = yearOfLine.get(row.budgetLine)
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

/** The demo organization's code, from the input workbook the seed reads (never from code, NG-12) */
export async function demoOrgCode(): Promise<string> {
  return parseDemoOrgInput(await loadInputWorkbook(), loadOrgSettingsYaml()).org.code
}

/** The day of an instant in Thai time, as YYYY-MM-DD */
export function thaiDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: THAI_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** What the person types to reset staging: the demo organization's code and today in Thai time, as pnpm demo:reset asks */
export function demoResetConfirmation(orgCode: string, now: Date): string {
  return `${orgCode}-${thaiDay(now)}`
}

/** Codes of the organizations in the database that are not the demo organization: the reset refuses while there is one */
export async function otherOrganizations(demoCode: string): Promise<string[]> {
  return (await listOrganizationsForPlatform()).map((o) => o.code).filter((code) => code !== demoCode)
}

/**
 * Empties every table but the migration record, as the migrator, refusing in the same transaction while an organization
 * other than the demo one exists; the caller has checked APP_ENV and the confirmation
 */
export async function wipeDemoData(env: Env, demoCode: string): Promise<number> {
  return wipeAllData(env.DIRECT_URL, demoCode)
}

/** The id of the demo organization when it exists */
export async function demoOrganizationId(demoCode: string): Promise<string | null> {
  return (await listOrganizationsForPlatform()).find((o) => o.code === demoCode)?.id ?? null
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
  return { state: 'TAKEN', channel: { channelKey, providerId, messagingChannelId, channelSecret, channelAccessToken, liffId, liffChannelId, richMenuLinkedId, richMenuUnlinkedId, active } }
}

/**
 * Puts a carried LINE channel on the (new) demo organization after the reset's seed: its secrets sealed again for this
 * organization (NFR-SEC-07 binds them to it), replacing what the seed made from the LINE_* values, if anything
 */
export async function putLineChannel(organizationId: string, carried: CarriedLineChannel, now: Date): Promise<void> {
  const { channelSecret, channelAccessToken, ...values } = carried
  await restoreLineChannelRow(
    organizationId,
    {
      ...values,
      channelSecretEnc: sealLineSecret(organizationId, 'channelSecret', channelSecret),
      channelAccessTokenEnc: sealLineSecret(organizationId, 'channelAccessToken', channelAccessToken),
    },
    now,
  )
}
