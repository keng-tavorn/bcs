import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { decideTask } from '@/server/services/approvals/decide'
import { startRoute } from '@/server/services/approvals/route'
import { getDoaSimulation } from '@/server/services/doa/simulate'
import { setModule } from '@/server/services/modules'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { P1_FIXTURES } from '../support/p1-org'
import { createP2Org } from '../support/p2-org'

// S11-02 (BR-DOA-28 · ADR-226 · BR-RSK-16): the DOA document type RISK_OVERRIDE and switching the RISK module. What the
// golden files doa-p2.yaml doa-p2-lint.yaml cannot hold (spec §7.4): an override routes on a real organization by its cap
// with VAT sent with VAT 0, step-up goes by that amount (never always · BR-RSK-11), a vacant COO is APPROVER_NOT_FOUND,
// a cap of zero is refused, a task of the subject stays with the empty adapter until S11-08, the DOA try-out takes the
// type, and organization.set_module switches RISK on only with SUPPLIER on, the RO rules, the three tiers and the gate
// policy confirmed and a questionnaire in effect, and off only when no assessment is with its reviewers and no override
// waits for its approvers. Tiers, policy and questions are test data of the organization (OQ-221 OQ-222), never code.

const NOW = new Date('2026-11-09T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const change = (module: 'SUPPLIER' | 'RISK', enabled: boolean) => ({ module, enabled, contractRef: 'CT-2569-011', reason: 'ตามสัญญาเพิ่มโมดูลความเสี่ยงคู่ค้า' })

async function platformCtxFor(organizationId: string) {
  const platformAdmin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
  return makeCtx({ organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: platformAdmin.id }, channel: 'WEB', now: NOW })
}

/** An override routed as S11-08's riskOverride.submit will: under RISK_OVERRIDE, the cap as the amount with VAT 0 */
async function routedOverride(org: DoaOrg, capSatang: bigint, requester = 'proc_officer', department = 'PROC') {
  const ctx = org.ctxOf(requester, NOW)
  return forTenant(org.organizationId).$transaction((tx) =>
    startRoute(
      tx,
      ctx,
      { type: 'RISK_OVERRIDE', id: randomUUID(), label: 'การอนุมัติข้ามด่านความเสี่ยง' },
      {
        documentType: 'RISK_OVERRIDE',
        amount: { netSatang: capSatang, vatSatang: 0n },
        requesterMemberId: org.member[requester]!,
        chargedDepartmentId: org.department[department]!,
        conflictMemberIds: [org.member[requester]!],
        at: NOW,
      },
    ),
  )
}

// the cap of the demo scene 17: one urgent PO 112,149.53 + VAT 7,850.47 = 120,000.00 with VAT
const SCENE_CAP = 12_000_000n

const TIERS = [
  { code: 'LOW' as const, minPoints: 0, reviewMonths: 36, blocksPo: false, requiresExplicitAnswers: false },
  { code: 'MEDIUM' as const, minPoints: 20, reviewMonths: 24, blocksPo: false, requiresExplicitAnswers: false },
  { code: 'HIGH' as const, minPoints: 40, reviewMonths: 12, blocksPo: true, requiresExplicitAnswers: true },
]

async function tiers(org: DoaOrg, confirmed: readonly ('LOW' | 'MEDIUM' | 'HIGH')[] = ['LOW', 'MEDIUM', 'HIGH']) {
  for (const t of TIERS) {
    const yes = confirmed.includes(t.code)
    await prisma.riskTier.create({
      data: { organizationId: org.organizationId, ...t, nameTh: t.code, nameEn: t.code, reminderDaysBefore: 30, updatedById: org.member.admin!, ...(yes ? { confirmedById: org.member.admin2!, confirmedAt: NOW } : {}) },
    })
  }
}

async function policy(org: DoaOrg, confirmed = true) {
  await prisma.riskPolicy.create({
    data: {
      organizationId: org.organizationId,
      screeningTierMap: { processesPersonalData: 'HIGH', accessesSystems: 'MEDIUM', accessesPremises: 'MEDIUM' },
      highRiskCategories: ['PROF'],
      registryFlagBlocks: true,
      mediumOverdueBlocks: false,
      overrideChatButton: false,
      updatedById: org.member.admin!,
      ...(confirmed ? { confirmedById: org.member.admin2!, confirmedAt: NOW } : {}),
    },
  })
}

async function questionnaire(org: DoaOrg, status: 'DRAFT' | 'PUBLISHED', effectiveFrom = new Date('2026-11-01T00:00:00+07:00'), versionNo = 1) {
  const published = status === 'PUBLISHED' ? { submittedById: org.member.admin!, submittedAt: NOW, publishedById: org.member.admin2!, publishedAt: NOW } : {}
  return prisma.riskQuestionnaire.create({ data: { organizationId: org.organizationId, code: 'RQ-T', versionNo, status, effectiveFrom, checksum: `test-${versionNo}`, ...published } })
}

describe('[FR-RSK-203/AC2] [BR-DOA-28] an override routes by its cap with VAT, sent with VAT 0, on a real organization', () => {
  it('the demo cap 120,000.00 routes under RO-01 to the COO; above stepUpThreshold (100,000.00) deciding asks for step-up by the amount (BR-RSK-11)', async () => {
    const org = await createP2Org()
    const routed = await routedOverride(org, SCENE_CAP)
    if (!routed.ok) throw new Error(JSON.stringify(routed.error))
    expect(routed.data.route).toMatchObject({ ruleCode: 'RO-01' })
    expect(routed.data.firstTask.assigneeMemberId).toBe(org.member.coo)
    const taskId = routed.data.firstTask.id
    expect(await decideTask(org.ctxOf('coo', NOW), { taskId, decision: 'APPROVE' }, key())).toMatchObject({
      ok: false,
      error: { code: 'STEP_UP_REQUIRED', details: { subjectType: 'RISK_OVERRIDE' } },
    })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: 'OPEN' })
  })

  it('below stepUpThreshold no step-up is asked (not in ALWAYS_STEP_UP_SUBJECTS); the empty adapter keeps the task open until S11-08', async () => {
    const org = await createP2Org()
    const routed = await routedOverride(org, 5_000_000n)
    if (!routed.ok) throw new Error(JSON.stringify(routed.error))
    const taskId = routed.data.firstTask.id
    expect(await decideTask(org.ctxOf('coo', NOW), { taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SUBJECT' } } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: 'OPEN' })
  })

  it('the boundary on the database: 1,000,000.00 stays with the COO (RO-01), one satang more goes to the CEO (RO-02)', async () => {
    const org = await createP2Org()
    const top = await routedOverride(org, 100_000_000n)
    const above = await routedOverride(org, 100_000_001n)
    if (!top.ok || !above.ok) throw new Error(JSON.stringify([top, above]))
    expect([top.data.route.ruleCode, top.data.firstTask.assigneeMemberId]).toEqual(['RO-01', org.member.coo])
    expect([above.data.route.ruleCode, above.data.firstTask.assigneeMemberId]).toEqual(['RO-02', org.member.ceo])
  })

  it('the COO asking goes to the next band, the CEO (BR-DOA-06 · GC-DOA-83 on the database)', async () => {
    const org = await createP2Org()
    const routed = await routedOverride(org, 50_000_000n, 'coo', 'HQ')
    if (!routed.ok) throw new Error(JSON.stringify(routed.error))
    expect(routed.data.firstTask.assigneeMemberId).toBe(org.member.ceo)
  })

  it('a cap of zero is refused AMOUNT_NOT_POSITIVE (BR-DOA-21) and nothing is written', async () => {
    const org = await createP2Org()
    expect(await routedOverride(org, 0n)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'AMOUNT_NOT_POSITIVE' } } })
    expect(await prisma.approvalRoute.count({ where: { organizationId: org.organizationId, subjectType: 'RISK_OVERRIDE' } })).toBe(0)
  })

  it('the COO position vacant → APPROVER_NOT_FOUND and nothing is written', async () => {
    const org = await createP2Org()
    const position = await prisma.position.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'COO' } })
    await prisma.positionAssignment.updateMany({ where: { organizationId: org.organizationId, positionId: position.id }, data: { validTo: new Date('2026-10-31T17:00:00Z') } })
    expect(await routedOverride(org, SCENE_CAP)).toMatchObject({ ok: false, error: { code: 'APPROVER_NOT_FOUND' } })
    expect(await prisma.approvalRoute.count({ where: { organizationId: org.organizationId, subjectType: 'RISK_OVERRIDE' } })).toBe(0)
  })

  it('the DOA try-out takes the type with the cap and finds RO-01', async () => {
    const org = await createP2Org()
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
    const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
    const r = await getDoaSimulation(org.ctxOf('admin', NOW), version.id, { type: 'RISK_OVERRIDE', department: org.department.PROC!, requester: org.member.proc_officer!, net: '120000.00', vat: '' })
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    expect(r.data.errors).toEqual({})
    expect(r.data.result?.version).toMatchObject({ ok: true, ruleCode: 'RO-01', steps: [{ assignee: { id: org.member.coo } }] })
  })
})

describe('[FR-PLT-011/AC4] [BR-DOA-24] [BR-RSK-16] RISK is switched on only with SUPPLIER, the RO rules, the tiers, the policy and a questionnaire', () => {
  it('DOA-P1 with SUPPLIER on has no RO rule: DOA_NOT_CONFIGURED names RISK_OVERRIDE and nothing is written', async () => {
    const org = await createDoaOrg({ fixtures: P1_FIXTURES })
    await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'SUPPLIER', enabled: true, enabledAt: NOW, contractRef: 'TEST-P1', reason: 'เปิดผู้ขายในเทสต์' } })
    await tiers(org)
    await policy(org)
    await questionnaire(org, 'PUBLISHED')
    const platform = await platformCtxFor(org.organizationId)
    expect(await setModule(platform, change('RISK', true), key())).toMatchObject({
      ok: false,
      error: { code: 'DOA_NOT_CONFIGURED', details: { reason: 'MODULE_RULES_MISSING', module: 'RISK', documentTypes: ['RISK_OVERRIDE'], versions: [{ code: 'DOA-P1', versionNo: 1 }] } },
    })
    expect(await prisma.orgModule.count({ where: { organizationId: org.organizationId, module: 'RISK' } })).toBe(0)
  })

  it('DOA-P2 with SUPPLIER off: MODULE_DISABLED names SUPPLIER before anything else is read', async () => {
    const org = await createP2Org({ modules: [] })
    const platform = await platformCtxFor(org.organizationId)
    expect(await setModule(platform, change('RISK', true), key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED', details: { module: 'SUPPLIER' } } })
  })

  it('tiers, then the policy, then a questionnaire in effect: each missing piece refuses with its own code and writes nothing', async () => {
    const org = await createP2Org()
    const orgId = org.organizationId
    const platform = await platformCtxFor(orgId)
    const tryOn = () => setModule(platform, change('RISK', true), key())
    const refusedWith = async (code: string, extra: Record<string, unknown> = {}) => {
      expect(await tryOn()).toMatchObject({ ok: false, error: { code, details: { module: 'RISK', ...extra } } })
      expect(await prisma.orgModule.count({ where: { organizationId: orgId, module: 'RISK' } })).toBe(0)
    }
    await refusedWith('RISK_TIER_NOT_CONFIGURED')
    // a tier proposed but never confirmed by a second person is not in effect (BR-RSK-02)
    await tiers(org, ['LOW', 'MEDIUM'])
    await refusedWith('RISK_TIER_NOT_CONFIGURED')
    await prisma.riskTier.updateMany({ where: { organizationId: orgId, code: 'HIGH' }, data: { confirmedById: org.member.admin2!, confirmedAt: NOW } })
    // a pending change on top of confirmed values changes nothing (the values in effect are confirmed)
    await prisma.riskTier.updateMany({ where: { organizationId: orgId, code: 'HIGH' }, data: { pendingChange: { minPoints: 45 }, pendingById: org.member.admin!, pendingAt: NOW } })
    await refusedWith('RISK_POLICY_NOT_CONFIGURED')
    await policy(org, false)
    await refusedWith('RISK_POLICY_NOT_CONFIGURED')
    await prisma.riskPolicy.updateMany({ where: { organizationId: orgId }, data: { confirmedById: org.member.admin2!, confirmedAt: NOW } })
    await refusedWith('RISK_QUESTIONNAIRE_NOT_PUBLISHED')
    // a draft, and a version published to take effect only later, are not in effect
    await questionnaire(org, 'DRAFT')
    await refusedWith('RISK_QUESTIONNAIRE_NOT_PUBLISHED')
    await questionnaire(org, 'PUBLISHED', new Date('2026-12-01T00:00:00+07:00'), 2)
    await refusedWith('RISK_QUESTIONNAIRE_NOT_PUBLISHED')
    await questionnaire(org, 'PUBLISHED', new Date('2026-11-01T00:00:00+07:00'), 3)
    expect(await tryOn()).toMatchObject({ ok: true, data: { module: 'RISK', enabled: true } })
    expect(await prisma.event.count({ where: { organizationId: orgId, type: 'organization.module_enabled', aggregateId: orgId } })).toBe(1)
    // RISK holds SUPPLIER on (§4.11 rule 2)
    expect(await setModule(platform, change('SUPPLIER', false), key())).toMatchObject({ ok: false, error: { code: 'MODULE_IN_USE', details: { reason: 'REQUIRED_BY', modules: ['RISK'] } } })
  })
})

describe('[FR-PLT-011/AC2] [BR-RSK-16] RISK is switched off only when no assessment is with its reviewers and no override waits (OQ-33)', () => {
  it('an assessment IN_REVIEW and an override PENDING_APPROVAL hold it by their numbers; drafts do not; then it switches off', async () => {
    const org = await createP2Org()
    const orgId = org.organizationId
    await tiers(org)
    await policy(org)
    const q = await questionnaire(org, 'PUBLISHED')
    const platform = await platformCtxFor(orgId)
    expect(await setModule(platform, change('RISK', true), key())).toMatchObject({ ok: true })
    const off = () => setModule(platform, change('RISK', false), key())

    const supplier = await prisma.supplier.create({ data: { organizationId: orgId, code: 'SP-RO-1', nameTh: 'ผู้ขายทดสอบ', isForeign: true } })
    const other = await prisma.supplier.create({ data: { organizationId: orgId, code: 'SP-RO-2', nameTh: 'ผู้ขายทดสอบสอง', isForeign: true } })
    const assessment = await prisma.riskAssessment.create({
      data: { organizationId: orgId, number: 'RSA-2569-00001', supplierId: supplier.id, questionnaireId: q.id, screening: { processesPersonalData: 'Y' }, payeeType: 'JURISTIC', inherentTier: 'HIGH', lastActivityAt: NOW, openedById: org.member.proc_officer! },
    })
    // a draft assessment and a draft override never hold the module
    await prisma.riskOverride.create({ data: { organizationId: orgId, supplierId: other.id, reason: 'งานด่วนหน้างาน รอประเมินครบในสัปดาห์หน้า', capGrossSatang: SCENE_CAP, expiresOn: new Date('2026-12-31'), requestedById: org.member.proc_officer! } })
    expect(await off()).toMatchObject({ ok: true })
    expect(await setModule(platform, change('RISK', true), key())).toMatchObject({ ok: true })

    await prisma.riskAssessment.update({ where: { id: assessment.id }, data: { status: 'IN_REVIEW', tier: 'HIGH', pointsTotal: 45, submittedAt: NOW } })
    expect(await off()).toMatchObject({ ok: false, error: { code: 'MODULE_IN_USE', details: { reason: 'OPEN_DOCUMENTS', documents: ['RSA-2569-00001'] } } })
    const override = await prisma.riskOverride.create({
      data: { organizationId: orgId, number: 'RO-2569-00001', supplierId: supplier.id, reason: 'งานด่วนหน้างาน รอประเมินครบในสัปดาห์หน้า', capGrossSatang: SCENE_CAP, expiresOn: new Date('2026-12-31'), requestedById: org.member.proc_officer!, status: 'PENDING_APPROVAL', submittedAt: NOW },
    })
    expect(await off()).toMatchObject({ ok: false, error: { details: { documents: ['RSA-2569-00001', 'RO-2569-00001'] } } })
    await prisma.riskAssessment.update({ where: { id: assessment.id }, data: { status: 'RETURNED' } })
    expect(await off()).toMatchObject({ ok: false, error: { details: { documents: ['RO-2569-00001'] } } })
    await prisma.riskOverride.update({ where: { id: override.id }, data: { status: 'REJECTED', decidedAt: NOW } })
    expect(await off()).toMatchObject({ ok: true })
    expect(await prisma.orgModule.findFirstOrThrow({ where: { organizationId: orgId, module: 'RISK' } })).toMatchObject({ enabled: false })
  })
})
