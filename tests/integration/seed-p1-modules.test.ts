import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { lintDoaVersion } from '@/core/doa'
import { forTenant } from '@/server/db/tenant'
import { loadOrgSnapshot } from '@/server/doa/policy'
import { versionSnapshotFromRows } from '@/server/doa/snapshot'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { P1_SEED_MODULES, seedP1Modules } from '@/server/seed/p1-modules'
import { INPUT_WORKBOOKS, loadInputWorkbook, type InputProfile } from '@/server/seed/workbook'

// FR-PLT-007 AC4 AC5 (P1-07, ADR-070): the seed of the phase-1 workbook gives DOA-SIMEC version 1 with the 22 rules of
// sheet DOA — the 14 of the six new document types among them — and switches PAY AI BCS_GO on once, after the DOA, with
// organization.module_enabled per module; the demo organization keeps CORE alone; a second seed adds nothing. The same
// seed functions as prisma/seed.ts, under another organization code and e-mail addresses (without the history, which
// tests/integration/seed-p1-year-*.test.ts cover).

const NOW = new Date('2026-12-14T03:00:00Z')

async function seededOrg(profile: InputProfile) {
  const workbook = await loadInputWorkbook(INPUT_WORKBOOKS[profile])
  const input = parseDemoOrgInput(workbook, loadOrgSettingsYaml())
  const code = `M${randomUUID().slice(0, 7).toUpperCase()}`
  const renamed = { ...input, org: { ...input.org, code }, users: input.users.map((u) => ({ ...u, email: `${code.toLowerCase()}.${u.email}` })) }
  const org = await seedDemoOrganization(renamed, { password: 'seed-p1-modules-password-01', now: NOW })
  const structure = parseOrgStructureInput(workbook)
  await seedOrgStructure(org.organizationId, renamed.users, structure, NOW)
  return { organizationId: org.organizationId, users: renamed.users, structure }
}

describe('[FR-PLT-007/AC4] the phase-1 seed: DOA-SIMEC version 1 with 22 rules, and PAY AI BCS_GO on', () => {
  let p1: Awaited<ReturnType<typeof seededOrg>>
  beforeAll(async () => {
    p1 = await seededOrg('p1')
    expect(await seedP1Modules(p1.organizationId, NOW)).toEqual({ enabled: 3 })
  })

  it('has the 22 rules of sheet DOA, which pass the full lint with the modules that are on', async () => {
    const db = forTenant(p1.organizationId)
    const version = await db.doaVersion.findFirstOrThrow({ where: { status: 'PUBLISHED' }, include: { rules: true } })
    expect([version.code, version.versionNo, version.rules.length]).toEqual(['DOA-SIMEC', 1, 22])
    expect(new Set(version.rules.map((r) => r.documentType))).toEqual(
      new Set(['PURCHASE_REQUEST', 'PURCHASE_ORDER', 'GR_VARIANCE', 'DOA_CHANGE', 'ORG_AUTHORITY_CHANGE', 'BUDGET_TRANSFER', 'OVER_BUDGET', 'INVOICE_EXCEPTION', 'PO_CHANGE', 'PAYMENT_RUN', 'BANK_ACCOUNT_CHANGE']),
    )
    const org = await db.$transaction((tx) => loadOrgSnapshot(tx))
    expect(lintDoaVersion(versionSnapshotFromRows(version, version.rules), org, NOW, { modules: ['CORE', ...P1_SEED_MODULES] }).errors).toEqual([])
  })

  it('switches on CORE PAY AI BCS_GO, each with organization.module_enabled', async () => {
    const db = forTenant(p1.organizationId)
    const on = await db.orgModule.findMany({ where: { enabled: true }, select: { module: true, contractRef: true } })
    expect(on.map((m) => m.module).sort()).toEqual(['AI', 'BCS_GO', 'CORE', 'PAY'])
    expect(on.filter((m) => m.module !== 'CORE').every((m) => m.contractRef === 'SEED-P1')).toBe(true)
    const events = await db.event.findMany({ where: { type: 'organization.module_enabled' }, select: { data: true } })
    expect(events.map((e) => (e.data as { module: string }).module).sort()).toEqual(['AI', 'BCS_GO', 'CORE', 'PAY'])
  })

  it('the demo workbook keeps CORE alone', async () => {
    const demo = await seededOrg('demo')
    const on = await forTenant(demo.organizationId).orgModule.findMany({ where: { enabled: true }, select: { module: true } })
    expect(on.map((m) => m.module)).toEqual(['CORE'])
  })
})

describe('[FR-PLT-007/AC5] seeding again adds no rule and no module', () => {
  it('a second run leaves 22 rules, four modules and four events', async () => {
    const p1 = await seededOrg('p1')
    await seedP1Modules(p1.organizationId, NOW)
    await seedOrgStructure(p1.organizationId, p1.users, p1.structure, NOW)
    expect(await seedP1Modules(p1.organizationId, NOW)).toEqual({ enabled: 0 })
    const db = forTenant(p1.organizationId)
    expect(await db.doaRule.count()).toBe(22)
    expect(await db.orgModule.count()).toBe(4)
    expect(await db.event.count({ where: { type: 'organization.module_enabled' } })).toBe(4)
  })
})
