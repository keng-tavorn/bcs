import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { lintDoaVersion } from '@/core/doa'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { decideTask } from '@/server/services/approvals/decide'
import { startRoute } from '@/server/services/approvals/route'
import { getDoaSimulation } from '@/server/services/doa/simulate'
import { setModule } from '@/server/services/modules'
import { orgSnapshot, versionSnapshots } from '../golden/doa-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { P1_FIXTURES } from '../support/p1-org'
import { createP2Org, P2_FIXTURES } from '../support/p2-org'

// S10-02 (BR-DOA-27 · ADR-202): the DOA document type RFX_AWARD. What the golden files doa-p2.yaml doa-p2-lint.yaml
// cannot hold (spec §7.4): the version without the RA rules lints clean while SOURCING is off, an award routes on a
// real organization by its amount with VAT, a vacant PROC_MGR is APPROVER_NOT_FOUND, an award of no amount is refused,
// a task of the subject with no award behind it stays open (S10-10's adapter refuses it as the empty one did), the DOA try-out takes the type, and
// organization.set_module switches SOURCING on only with the RA rules and off only when no RFx or award is open.

const NOW = new Date('2026-11-08T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const change = (module: 'SUPPLIER' | 'SOURCING', enabled: boolean) => ({ module, enabled, contractRef: 'CT-2569-010', reason: 'ตามสัญญาเพิ่มโมดูลจัดหา' })

async function platformCtxFor(organizationId: string) {
  const platformAdmin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
  return makeCtx({ organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: platformAdmin.id }, channel: 'WEB', now: NOW })
}

/** An award routed as S10-10's award.submit will: under RFX_AWARD, the department of the RFx, the submitter in conflict */
async function routedAward(org: DoaOrg, amount: { netSatang: bigint; vatSatang: bigint }, conflicts: readonly string[] = []) {
  const ctx = org.ctxOf('proc_officer', NOW)
  return forTenant(org.organizationId).$transaction((tx) =>
    startRoute(
      tx,
      ctx,
      { type: 'AWARD_DECISION', id: randomUUID(), label: 'ผลการจัดหา' },
      {
        documentType: 'RFX_AWARD',
        amount,
        requesterMemberId: org.member.proc_officer!,
        chargedDepartmentId: org.department.PROC!,
        conflictMemberIds: [org.member.proc_officer!, ...conflicts.map((c) => org.member[c]!)],
        at: NOW,
      },
    ),
  )
}

// the award of the demo scene (GC-SRC-21): 300,950.00 + VAT 21,066.50 = 322,016.50 with VAT
const SCENE_AWARD = { netSatang: 30_095_000n, vatSatang: 2_106_650n }

describe('[BR-DOA-27] RA rules are needed only while SOURCING is on (BR-DOA-23)', () => {
  it('DOA-P2 without RA-01..03 lints clean with PAY and SUPPLIER on, and misses RFX_AWARD once SOURCING is on', () => {
    const p2 = versionSnapshots(P2_FIXTURES.versions)[0]!
    const withoutRa = { ...p2, rules: p2.rules.filter((r) => r.documentType !== 'RFX_AWARD') }
    const org = orgSnapshot([], P1_FIXTURES.org)
    expect(lintDoaVersion(withoutRa, org, p2.effectiveFrom, { modules: ['PAY', 'SUPPLIER'] }).errors).toEqual([])
    expect(lintDoaVersion(withoutRa, org, p2.effectiveFrom, { modules: ['PAY', 'SUPPLIER', 'SOURCING'] }).errors).toMatchObject([{ code: 'DOA_LINT_MISSING_DOCTYPE', documentType: 'RFX_AWARD' }])
    expect(lintDoaVersion(p2, org, p2.effectiveFrom, { modules: ['PAY', 'SUPPLIER', 'SOURCING'] }).errors).toEqual([])
  })
})

describe('[BR-DOA-27] an award routes by its amount with VAT on a real organization', () => {
  it('the demo award 322,016.50 routes under RA-01 to dm_proc, and above stepUpThreshold (100,000.00) deciding asks for step-up like a PO (BR-TOK-05)', async () => {
    const org = await createP2Org()
    const routed = await routedAward(org, SCENE_AWARD)
    if (!routed.ok) throw new Error(JSON.stringify(routed.error))
    expect(routed.data.route).toMatchObject({ ruleCode: 'RA-01' })
    expect(routed.data.firstTask.assigneeMemberId).toBe(org.member.dm_proc)
    const taskId = routed.data.firstTask.id
    expect(await decideTask(org.ctxOf('dm_proc', NOW), { taskId, decision: 'APPROVE' }, key())).toMatchObject({
      ok: false,
      error: { code: 'STEP_UP_REQUIRED', details: { subjectType: 'AWARD_DECISION' } },
    })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: 'OPEN' })
  })

  it('below stepUpThreshold the decision reaches the adapter, which keeps a task with no award behind it open (VALIDATION_FAILED SUBJECT · S10-10)', async () => {
    const org = await createP2Org()
    const routed = await routedAward(org, { netSatang: 4_672_897n, vatSatang: 327_103n })
    if (!routed.ok) throw new Error(JSON.stringify(routed.error))
    const taskId = routed.data.firstTask.id
    expect(await decideTask(org.ctxOf('dm_proc', NOW), { taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SUBJECT' } } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: 'OPEN' })
  })

  it('the band is decided with VAT (GROSS): 480,000.00 + VAT 33,600.00 goes to RA-02, the COO', async () => {
    const org = await createP2Org()
    const routed = await routedAward(org, { netSatang: 48_000_000n, vatSatang: 3_360_000n })
    if (!routed.ok) throw new Error(JSON.stringify(routed.error))
    expect(routed.data.route).toMatchObject({ ruleCode: 'RA-02' })
    expect(routed.data.firstTask.assigneeMemberId).toBe(org.member.coo)
  })

  it('[GC-DOA-77] [GC-DOA-78] [GC-DOA-79] the band edges on the database: 500,000.00 is RA-01, 500,000.01 is RA-02, and the CEO in conflict at the top band is NO_HIGHER_AUTHORITY (S10-10)', async () => {
    const org = await createP2Org()
    const edge = await routedAward(org, { netSatang: 46_728_972n, vatSatang: 3_271_028n })
    if (!edge.ok) throw new Error(JSON.stringify(edge.error))
    expect(edge.data.route).toMatchObject({ ruleCode: 'RA-01', basisAmountSatang: 50_000_000n })
    expect(edge.data.firstTask.assigneeMemberId).toBe(org.member.dm_proc)
    const above = await routedAward(org, { netSatang: 46_728_973n, vatSatang: 3_271_028n })
    if (!above.ok) throw new Error(JSON.stringify(above.error))
    expect(above.data.route).toMatchObject({ ruleCode: 'RA-02', basisAmountSatang: 50_000_001n })
    expect(above.data.firstTask.assigneeMemberId).toBe(org.member.coo)
    expect(await routedAward(org, { netSatang: 467_289_721n, vatSatang: 32_710_280n }, ['ceo'])).toMatchObject({ ok: false, error: { code: 'NO_HIGHER_AUTHORITY' } })
  })

  it('an award of no amount is refused (REQUIRED · BR-DOA-21) and nothing is written', async () => {
    const org = await createP2Org()
    expect(await routedAward(org, { netSatang: 0n, vatSatang: 0n })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await prisma.approvalRoute.count({ where: { organizationId: org.organizationId, subjectType: 'AWARD_DECISION' } })).toBe(0)
  })

  it('the procurement manager position vacant → APPROVER_NOT_FOUND and nothing is written', async () => {
    const org = await createP2Org()
    const position = await prisma.position.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'PROC_MGR' } })
    await prisma.positionAssignment.updateMany({ where: { organizationId: org.organizationId, positionId: position.id }, data: { validTo: new Date('2026-10-31T17:00:00Z') } })
    expect(await routedAward(org, SCENE_AWARD)).toMatchObject({ ok: false, error: { code: 'APPROVER_NOT_FOUND' } })
    expect(await prisma.approvalRoute.count({ where: { organizationId: org.organizationId, subjectType: 'AWARD_DECISION' } })).toBe(0)
  })

  it('the procurement manager who scored the bids is skipped to the COO (BR-SOD-13 at routing · GC-DOA-76 on the database)', async () => {
    const org = await createP2Org()
    const routed = await routedAward(org, SCENE_AWARD, ['dm_proc'])
    if (!routed.ok) throw new Error(JSON.stringify(routed.error))
    expect(routed.data.firstTask.assigneeMemberId).toBe(org.member.coo)
  })

  it('the DOA try-out takes the type with its amount and finds RA-01 on the amount with VAT', async () => {
    const org = await createP2Org()
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
    const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
    const r = await getDoaSimulation(org.ctxOf('admin', NOW), version.id, { type: 'RFX_AWARD', department: org.department.PROC!, requester: org.member.proc_officer!, net: '300950.00', vat: '21066.50' })
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    expect(r.data.errors).toEqual({})
    expect(r.data.result?.version).toMatchObject({ ok: true, ruleCode: 'RA-01', steps: [{ assignee: { id: org.member.dm_proc } }] })
  })
})

describe('[FR-PLT-011/AC4] [BR-DOA-24] SOURCING is switched on only with SUPPLIER on and the RA rules', () => {
  it('DOA-P1 with SUPPLIER on has no RA rule: DOA_NOT_CONFIGURED names RFX_AWARD and nothing is written', async () => {
    const org = await createDoaOrg({ fixtures: P1_FIXTURES })
    await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'SUPPLIER', enabled: true, enabledAt: NOW, contractRef: 'TEST-P1', reason: 'เปิดผู้ขายในเทสต์' } })
    const platform = await platformCtxFor(org.organizationId)
    expect(await setModule(platform, change('SOURCING', true), key())).toMatchObject({
      ok: false,
      error: { code: 'DOA_NOT_CONFIGURED', details: { reason: 'MODULE_RULES_MISSING', module: 'SOURCING', documentTypes: ['RFX_AWARD'], versions: [{ code: 'DOA-P1', versionNo: 1 }] } },
    })
    expect(await prisma.orgModule.count({ where: { organizationId: org.organizationId, module: 'SOURCING' } })).toBe(0)
  })

  it('DOA-P2 with SUPPLIER off: MODULE_DISABLED names SUPPLIER; with SUPPLIER on SOURCING switches on', async () => {
    const org = await createP2Org({ modules: [] })
    const platform = await platformCtxFor(org.organizationId)
    expect(await setModule(platform, change('SOURCING', true), key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED', details: { module: 'SUPPLIER' } } })
    expect(await setModule(platform, change('SUPPLIER', true), key())).toMatchObject({ ok: true })
    expect(await setModule(platform, change('SOURCING', true), key())).toMatchObject({ ok: true })
  })
})

describe('[FR-PLT-011/AC2] SOURCING is switched off only when no RFx or award is open (MODULE_IN_USE · OQ-33)', () => {
  it('an open RFx holds it by its id then its number, an open award by its number, an award waiting for its PO prices too; then it switches off', async () => {
    const org = await createP2Org()
    const orgId = org.organizationId
    const platform = await platformCtxFor(orgId)
    expect(await setModule(platform, change('SOURCING', true), key())).toMatchObject({ ok: true })
    const rfx = await prisma.rfxEvent.create({
      data: { organizationId: orgId, kind: 'RFQ', title: 'เหล็กเส้น', description: 'ขอราคา', categoryCode: 'STEEL', sourceKind: 'NEED', requestingDepartmentId: org.department.PROC!, createdById: org.member.proc_officer!, minInvites: 3 },
    })
    expect(await setModule(platform, change('SOURCING', false), key())).toMatchObject({ ok: false, error: { code: 'MODULE_IN_USE', details: { reason: 'OPEN_DOCUMENTS', documents: [rfx.id] } } })
    const opened = { status: 'CLOSED' as const, number: 'RFX-2569-00001', openedAt: NOW, openedById: org.member.proc_officer!, closesAt: new Date('2026-11-12T03:00:00Z'), closedAt: new Date('2026-11-12T03:00:00Z') }
    await prisma.rfxEvent.update({ where: { id: rfx.id }, data: opened })
    expect(await setModule(platform, change('SOURCING', false), key())).toMatchObject({ ok: false, error: { details: { documents: ['RFX-2569-00001'] } } })
    const award = await prisma.awardDecision.create({
      data: { organizationId: orgId, rfxEventId: rfx.id, number: 'AWD-2569-00001', status: 'PENDING_APPROVAL', submittedById: org.member.proc_officer!, submittedAt: NOW, createdById: org.member.proc_officer!, ...SCENE_AWARD, grossSatang: 32_201_650n },
    })
    expect(await setModule(platform, change('SOURCING', false), key())).toMatchObject({ ok: false, error: { details: { documents: ['RFX-2569-00001', 'AWD-2569-00001'] } } })
    await prisma.awardDecision.update({ where: { id: award.id }, data: { status: 'APPROVED', decidedAt: NOW, poStatus: 'PENDING_PRICE' } })
    await prisma.rfxEvent.update({ where: { id: rfx.id }, data: { status: 'AWARDED', awardDecisionId: award.id } })
    expect(await setModule(platform, change('SOURCING', false), key())).toMatchObject({ ok: false, error: { details: { documents: ['AWD-2569-00001'] } } })
    await prisma.awardDecision.update({ where: { id: award.id }, data: { poStatus: 'CREATED' } })
    expect(await setModule(platform, change('SOURCING', false), key())).toMatchObject({ ok: true })
  })
})
