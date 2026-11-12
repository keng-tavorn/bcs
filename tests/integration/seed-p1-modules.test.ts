import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { lintDoaVersion } from '@/core/doa'
import { lintWorkflowVersion } from '@/core/workflow'
import { forTenant } from '@/server/db/tenant'
import { loadOrgSnapshot } from '@/server/doa/policy'
import { versionSnapshotFromRows } from '@/server/doa/snapshot'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { parseOrgStructureInput, seedOrgStructure } from '@/server/seed/org-structure'
import { P1_SEED_MODULES, seedP1Modules } from '@/server/seed/p1-modules'
import { parseRiskSheets } from '@/server/seed/risk'
import { parseWorkflowReviewers, seedWorkflow } from '@/server/seed/workflow'
import { INPUT_WORKBOOKS, loadInputWorkbook, type InputProfile } from '@/server/seed/workbook'
import { riskReady, seedRiskConfig } from '@/server/services/demo-seed/risk'
import { loadRequestTypeFields } from '@/server/workflow/policy'
import { workflowVersionFromRows } from '@/server/workflow/snapshot'

// FR-PLT-007 AC4 AC5 (P1-07, ADR-070): the seed of the phase-1 workbook gives DOA-SIMEC version 1 with the 25 rules of
// sheet DOA — the 14 of the six new document types among them, SA-01 of phase 2 (S7-13) and RO-01 RO-02 (S11-12) — and
// switches PAY AI BCS_GO SUPPLIER on once, after the DOA, and RISK when the risk sheets are seeded (S11-12 · BR-RSK-16), with
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

describe('[FR-PLT-007/AC4] the phase-1 seed: DOA-SIMEC version 1 with 25 rules, and PAY AI BCS_GO SUPPLIER on', () => {
  let p1: Awaited<ReturnType<typeof seededOrg>>
  beforeAll(async () => {
    p1 = await seededOrg('p1')
    expect(await seedP1Modules(p1.organizationId, NOW)).toEqual({ enabled: 4 })
  })

  it('has the 25 rules of sheet DOA, which pass the full lint with the modules that are on', async () => {
    const db = forTenant(p1.organizationId)
    const version = await db.doaVersion.findFirstOrThrow({ where: { status: 'PUBLISHED' }, include: { rules: true } })
    expect([version.code, version.versionNo, version.rules.length]).toEqual(['DOA-SIMEC', 1, 25])
    expect(new Set(version.rules.map((r) => r.documentType))).toEqual(
      new Set(['PURCHASE_REQUEST', 'PURCHASE_ORDER', 'GR_VARIANCE', 'DOA_CHANGE', 'ORG_AUTHORITY_CHANGE', 'BUDGET_TRANSFER', 'OVER_BUDGET', 'INVOICE_EXCEPTION', 'PO_CHANGE', 'PAYMENT_RUN', 'BANK_ACCOUNT_CHANGE', 'SUPPLIER_APPROVAL', 'RISK_OVERRIDE']),
    )
    const org = await db.$transaction((tx) => loadOrgSnapshot(tx))
    expect(lintDoaVersion(versionSnapshotFromRows(version, version.rules), org, NOW, { modules: ['CORE', ...P1_SEED_MODULES] }).errors).toEqual([])
  })

  it('switches on CORE PAY AI BCS_GO SUPPLIER, each with organization.module_enabled', async () => {
    const db = forTenant(p1.organizationId)
    const on = await db.orgModule.findMany({ where: { enabled: true }, select: { module: true, contractRef: true } })
    expect(on.map((m) => m.module).sort()).toEqual(['AI', 'BCS_GO', 'CORE', 'PAY', 'SUPPLIER'])
    expect(on.filter((m) => m.module !== 'CORE').every((m) => m.contractRef === 'SEED-P1')).toBe(true)
    const events = await db.event.findMany({ where: { type: 'organization.module_enabled' }, select: { data: true } })
    expect(events.map((e) => (e.data as { module: string }).module).sort()).toEqual(['AI', 'BCS_GO', 'CORE', 'PAY', 'SUPPLIER'])
  })

  it('the demo workbook keeps CORE alone', async () => {
    const demo = await seededOrg('demo')
    const on = await forTenant(demo.organizationId).orgModule.findMany({ where: { enabled: true }, select: { module: true } })
    expect(on.map((m) => m.module)).toEqual(['CORE'])
  })
})

describe('[FR-PLT-007/AC4] S11-12: RISK of the phase-1 seed', () => {
  it('stays off until the risk sheets are seeded, then is on with organization.module_enabled; tiers policy and questionnaire are in effect', async () => {
    const p1 = await seededOrg('p1')
    const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
    const db = forTenant(p1.organizationId)
    // a run without the check of the risk sheets (a part of the seed) leaves RISK off
    expect(await seedP1Modules(p1.organizationId, NOW)).toEqual({ enabled: 4 })
    expect(await db.orgModule.findFirst({ where: { module: 'RISK' } })).toBeNull()
    // the check names what is missing, and the seed stops
    await expect(seedP1Modules(p1.organizationId, NOW, { riskReady })).rejects.toThrow(/RISK_TIER_NOT_CONFIGURED/)
    const sheets = parseRiskSheets(workbook)!
    const code = (await db.organization.findFirstOrThrow({ select: { code: true } })).code
    expect(await seedRiskConfig(p1.organizationId, sheets, code, [{ code: 'ISO_CERT', singleInstance: false, linkedRiskQuestionCodes: ['RQ-IS-01', 'RQ-PRM-02'] }], NOW)).toEqual({ created: true })
    expect(await seedRiskConfig(p1.organizationId, sheets, code, [], NOW)).toEqual({ created: false })
    expect(await seedP1Modules(p1.organizationId, NOW, { riskReady })).toEqual({ enabled: 1 })
    const tiers = await db.riskTier.findMany({ orderBy: { minPoints: 'asc' }, select: { code: true, minPoints: true, reviewMonths: true, blocksPo: true, confirmedById: true, pendingChange: true } })
    expect(tiers.map((t) => [t.code, t.minPoints, t.reviewMonths, t.blocksPo])).toEqual([['LOW', 0, 36, false], ['MEDIUM', 20, 24, false], ['HIGH', 40, 12, true]])
    expect(tiers.every((t) => t.confirmedById !== null && t.pendingChange === null)).toBe(true)
    const policy = await db.riskPolicy.findFirstOrThrow()
    expect([policy.highRiskCategories, policy.registryFlagBlocks, policy.mediumOverdueBlocks, policy.overrideChatButton]).toEqual([['PROF'], true, false, false])
    const questionnaire = await db.riskQuestionnaire.findFirstOrThrow({ include: { questions: true } })
    expect([questionnaire.code, questionnaire.status, questionnaire.questions.length, questionnaire.checksum !== null]).toEqual([`RQ-${code}`, 'PUBLISHED', 12, true])
    // in effect from the first day an assessment of the history opens (SP0132's, before DOA version 1)
    expect(questionnaire.effectiveFrom.getTime()).toBeLessThan((await db.doaVersion.findFirstOrThrow({ where: { versionNo: 1 } })).effectiveFrom.getTime())
    expect(await db.event.count({ where: { type: { in: ['risk_tier.confirmed', 'risk_policy.confirmed', 'risk_questionnaire.published'] } } })).toBe(5)
  })
})

describe('[FR-PLT-007/AC5] seeding again adds no rule and no module', () => {
  it('a second run leaves 25 rules, five modules and five events', async () => {
    const p1 = await seededOrg('p1')
    await seedP1Modules(p1.organizationId, NOW)
    await seedOrgStructure(p1.organizationId, p1.users, p1.structure, NOW)
    expect(await seedP1Modules(p1.organizationId, NOW)).toEqual({ enabled: 0 })
    const db = forTenant(p1.organizationId)
    expect(await db.doaRule.count()).toBe(25)
    expect(await db.orgModule.count()).toBe(5)
    expect(await db.event.count({ where: { type: 'organization.module_enabled' } })).toBe(5)
  })
})

describe('[FR-WF-103/AC4] the phase-1 seed: workflow version 1 with the 7 reviewer rules of sheet Workflow_Reviewers and the 4 of Risk_Reviewers', () => {
  it('publishes them from the start of DOA version 1, they pass the lint, and a second run adds nothing; the demo has none', async () => {
    const p1 = await seededOrg('p1')
    const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
    const code = (await forTenant(p1.organizationId).organization.findFirstOrThrow({ select: { code: true } })).code
    const input = parseWorkflowReviewers(workbook, code)!
    expect(await seedWorkflow(p1.organizationId, input, NOW)).toEqual({ created: true, rules: 11 })
    expect(await seedWorkflow(p1.organizationId, input, NOW)).toEqual({ created: false, rules: 11 })
    const db = forTenant(p1.organizationId)
    const version = await db.workflowVersion.findFirstOrThrow({ include: { rules: { orderBy: { sortOrder: 'asc' } } } })
    const doa = await db.doaVersion.findFirstOrThrow({ where: { versionNo: 1 } })
    expect([version.code, version.versionNo, version.status, version.effectiveFrom]).toEqual([`WF-${code}`, 1, 'PUBLISHED', doa.effectiveFrom])
    expect(version.rules.map((r) => r.code)).toEqual(['RV-01', 'RV-02', 'RV-03', 'RV-04', 'RV-05', 'RV-06', 'RV-07', 'RR-01', 'RR-02', 'RR-03', 'RR-04'])
    expect(version.rules.filter((r) => r.scope === 'RISK_ASSESSMENT').map((r) => r.riskDomains)).toEqual([['PRIVACY'], ['INFOSEC'], ['PREMISES'], ['FINANCE']])
    const lint = await db.$transaction(async (tx) => lintWorkflowVersion(workflowVersionFromRows(version, version.rules), await loadOrgSnapshot(tx), await loadRequestTypeFields(tx), NOW))
    expect(lint.errors).toEqual([])
    expect(await db.event.count({ where: { type: 'workflow_version.published', aggregateId: version.id } })).toBe(1)
    expect(parseWorkflowReviewers(await loadInputWorkbook(INPUT_WORKBOOKS.demo), 'DEMO')).toBeNull()
  })
})
