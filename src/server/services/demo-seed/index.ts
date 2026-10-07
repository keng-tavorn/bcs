import type { Clock } from '@/lib/clock'
import type { Env } from '@/lib/env'
import { listOrganizationsForPlatform } from '@/server/db/lookups'
import { seedBudget } from '@/server/seed/budget'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { approversWithoutPin, seedDevPins } from '@/server/seed/pins'
import { parseBudget, parseDemoHistory, parseSites, parseSuppliers } from '@/server/seed/sheets'
import { seedSuppliers } from '@/server/seed/suppliers'
import { seedTaxRates } from '@/server/seed/tax-rates'
import { loadInputWorkbook } from '@/server/seed/workbook'
import { seedDemoHistory, type DemoHistoryReport } from '@/server/services/demo-history'
import { seedLineChannel } from '@/server/services/line-channel'

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

/** How many organizations the database holds: the staging seed job seeds only a database that has none */
export async function organizationCount(): Promise<number> {
  return (await listOrganizationsForPlatform()).length
}
