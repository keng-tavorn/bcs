import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { lintDoaVersion, resolveRoute, type DoaDocumentType } from '@/core/doa'
import { amountToSatang } from '@/core/money/dto'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import { startRoute } from '@/server/services/approvals/route'
import { getDoaSimulation } from '@/server/services/doa/simulate'
import { setModule } from '@/server/services/modules'
import { loadYaml, orgSnapshot, versionSnapshots } from '../golden/doa-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { createP1Org, P1_FIXTURES } from '../support/p1-org'
import { createP2Org, P2_FIXTURES } from '../support/p2-org'

// S7-02 (BR-DOA-26 · ADR-182 · BR-SUP ข้อ 16): the DOA document type SUPPLIER_APPROVAL. What the golden files
// doa-p2.yaml doa-p2-lint.yaml cannot hold (spec §7.4): the cases of phase 1 give the same results on the phase-2
// fixture, a version without SA-01 lints clean while SUPPLIER is off, a vacant PROC_MGR is APPROVER_NOT_FOUND on a real
// route, a task of the subject stays with the empty adapter until S7-05, and organization.set_module switches SUPPLIER
// on only with the SA and BA rules and off only when nothing of it is open.

const NOW = new Date('2026-11-02T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const hex = () => createHash('sha256').update(randomUUID()).digest('hex')
const change = (module: 'SUPPLIER' | 'SOURCING' | 'RISK', enabled: boolean) => ({ module, enabled, contractRef: 'CT-2569-002', reason: 'ตามสัญญาเพิ่มโมดูลผู้ขาย' })

async function platformCtxFor(organizationId: string) {
  const platformAdmin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
  return makeCtx({ organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: platformAdmin.id }, channel: 'WEB', now: NOW })
}

/** A supplier application routed as S7-05's verifyAndRoute will: under SUPPLIER_APPROVAL, the inviter in conflict */
async function routedApplication(org: DoaOrg, inviter = 'proc_officer') {
  const ctx = org.ctxOf(inviter, NOW)
  return forTenant(org.organizationId).$transaction((tx) =>
    startRoute(
      tx,
      ctx,
      { type: 'SUPPLIER_APPLICATION', id: randomUUID(), label: 'ใบสมัครผู้ขาย' },
      { documentType: 'SUPPLIER_APPROVAL', requesterMemberId: org.member[inviter]!, chargedDepartmentId: org.department.PROC!, conflictMemberIds: [org.member[inviter]!], at: NOW },
    ),
  )
}

interface RouteCase {
  id: string
  input: Record<string, unknown>
  expect: Record<string, unknown>
}
interface LintCase {
  id: string
  fn: 'lintDoaVersion' | 'boundaryTable'
  input: { base: number; removeRules?: string[]; vacate?: string[]; modules?: string[]; replaceRules?: unknown[] }
  expect: Record<string, unknown>
}

describe('[BR-DOA-26] the phase-1 golden cases give the same results on doa-versions-p2.yaml (ADR-069)', () => {
  it('every resolveRoute case of doa-p1.yaml resolves alike on DOA-P2', () => {
    const file = loadYaml<{ defaults: Record<string, unknown>; cases: RouteCase[] }>('doa-p1.yaml')
    const [p1, p2] = [versionSnapshots(P1_FIXTURES.versions), versionSnapshots(P2_FIXTURES.versions)]
    let compared = 0
    for (const c of file.cases) {
      const i = { ...file.defaults, ...c.input } as { documentType: DoaDocumentType; requester: string; department: string; at: string; amount?: string; net?: string; vat?: string; alsoConflicting?: string[]; vacate?: string[]; amountBasis?: string }
      if (i.amountBasis || i.net) continue // the cases on another basis edit the version; the plain ones cover the rules
      const input = {
        documentType: i.documentType,
        ...(i.amount ? { amount: { netSatang: amountToSatang(i.amount), vatSatang: 0n } } : {}),
        requesterMemberId: i.requester,
        chargedDepartmentId: i.department,
        conflictMemberIds: [i.requester, ...(i.alsoConflicting ?? [])],
        at: new Date(i.at),
      }
      const org = orgSnapshot(i.vacate ?? [], P1_FIXTURES.org)
      const outcome = (versions: typeof p1) => {
        const r = resolveRoute(input, { versions, org, delegations: [] })
        return r.ok ? { version: r.data.versionNo, rule: r.data.ruleCode, approvers: r.data.steps.map((s) => s.assigneeMemberId) } : { error: r.error.code }
      }
      expect(outcome(p2), c.id).toEqual(outcome(p1))
      compared++
    }
    expect(compared).toBeGreaterThan(10)
  })

  it('every lint case of doa-p1-lint.yaml finds the same errors and warnings on DOA-P2 (SA-01 adds none while SUPPLIER is off)', () => {
    const file = loadYaml<{ cases: LintCase[] }>('doa-p1-lint.yaml')
    const [p1, p2] = [versionSnapshots(P1_FIXTURES.versions)[0]!, versionSnapshots(P2_FIXTURES.versions)[0]!]
    for (const c of file.cases.filter((x) => x.fn === 'lintDoaVersion' && !x.input.replaceRules)) {
      const run = (v: typeof p1) => {
        const version = { ...v, rules: v.rules.filter((r) => !(c.input.removeRules ?? []).includes(r.code)) }
        const r = lintDoaVersion(version, orgSnapshot(c.input.vacate ?? [], P1_FIXTURES.org), version.effectiveFrom, { modules: c.input.modules ?? [] })
        return { errors: r.errors.map((e) => [e.code, e.documentType ?? null, e.rule ?? null]), warnings: r.warnings.map((e) => [e.code, e.documentType ?? null, e.rule ?? null]) }
      }
      expect(run(p2), c.id).toEqual(run(p1))
    }
  })

  it('without SUPPLIER no version needs SA-01: DOA-P2 without it lints clean with PAY on, and with SUPPLIER on it is missing', () => {
    const p2 = versionSnapshots(P2_FIXTURES.versions)[0]!
    const withoutSa = { ...p2, rules: p2.rules.filter((r) => r.code !== 'SA-01') }
    const org = orgSnapshot([], P1_FIXTURES.org)
    expect(lintDoaVersion(withoutSa, org, p2.effectiveFrom, { modules: ['PAY'] }).errors).toEqual([])
    expect(lintDoaVersion(withoutSa, org, p2.effectiveFrom, { modules: ['PAY', 'SUPPLIER'] }).errors).toMatchObject([{ code: 'DOA_LINT_MISSING_DOCTYPE', documentType: 'SUPPLIER_APPROVAL' }])
  })
})

describe('[BR-DOA-26] a supplier application routes to the procurement manager on a real organization', () => {
  it('routes under SA-01 to dm_proc, and the empty adapter keeps the task open until S7-05 (deciding and asking are VALIDATION_FAILED SUBJECT)', async () => {
    const org = await createP2Org()
    const routed = await routedApplication(org)
    if (!routed.ok) throw new Error(JSON.stringify(routed.error))
    expect(routed.data.route).toMatchObject({ ruleCode: 'SA-01' })
    expect(routed.data.firstTask.assigneeMemberId).toBe(org.member.dm_proc)
    const taskId = routed.data.firstTask.id
    expect(await decideTask(org.ctxOf('dm_proc', NOW), { taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SUBJECT' } } })
    expect(await requestInfo(org.ctxOf('dm_proc', NOW), { taskId, question: 'ขอเอกสารเพิ่ม' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SUBJECT' } } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ status: 'OPEN' })
  })

  it('the procurement manager position vacant → APPROVER_NOT_FOUND and nothing is written', async () => {
    const org = await createP2Org()
    const position = await prisma.position.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'PROC_MGR' } })
    await prisma.positionAssignment.updateMany({ where: { organizationId: org.organizationId, positionId: position.id }, data: { validTo: new Date('2026-10-31T17:00:00Z') } })
    const routed = await routedApplication(org)
    expect(routed).toMatchObject({ ok: false, error: { code: 'APPROVER_NOT_FOUND' } })
    expect(await prisma.approvalRoute.count({ where: { organizationId: org.organizationId, subjectType: 'SUPPLIER_APPLICATION' } })).toBe(0)
  })

  it('the DOA try-out takes the type without an amount (an amount typed is ignored, as for BANK_ACCOUNT_CHANGE) and finds SA-01', async () => {
    const org = await createP2Org()
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
    const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
    const r = await getDoaSimulation(org.ctxOf('admin', NOW), version.id, { type: 'SUPPLIER_APPROVAL', department: org.department.PROC!, requester: org.member.proc_officer!, net: '5000' })
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    expect(r.data.errors).toEqual({})
    expect(r.data.result?.version).toMatchObject({ ok: true, ruleCode: 'SA-01', basisAmount: null, steps: [{ assignee: { id: org.member.dm_proc } }] })
  })

  it('the inviter who is the procurement manager has no one above: NO_HIGHER_AUTHORITY (GC-DOA-70 on the database)', async () => {
    const org = await createP2Org()
    expect(await routedApplication(org, 'dm_proc')).toMatchObject({ ok: false, error: { code: 'NO_HIGHER_AUTHORITY' } })
  })
})

describe('[FR-PLT-011/AC4] [BR-DOA-24] [BR-SUP-16] SUPPLIER is switched on only with the SA and BA rules', () => {
  it('the tier-1 DOA lacks both: DOA_NOT_CONFIGURED names BANK_ACCOUNT_CHANGE then SUPPLIER_APPROVAL', async () => {
    const org = await createDoaOrg()
    const platform = await platformCtxFor(org.organizationId)
    expect(await setModule(platform, change('SUPPLIER', true), key())).toMatchObject({
      ok: false,
      error: { code: 'DOA_NOT_CONFIGURED', details: { reason: 'MODULE_RULES_MISSING', module: 'SUPPLIER', documentTypes: ['BANK_ACCOUNT_CHANGE', 'SUPPLIER_APPROVAL'], versions: [{ code: 'DOA-DEMO', versionNo: 1 }] } },
    })
    expect(await prisma.orgModule.count({ where: { organizationId: org.organizationId, module: 'SUPPLIER' } })).toBe(0)
  })

  it('DOA-P1 has BA-01 but no SA rule: only SUPPLIER_APPROVAL is missing; PAY switches on as before', async () => {
    const org = await createP1Org({ modules: [] })
    const platform = await platformCtxFor(org.organizationId)
    expect(await setModule(platform, change('SUPPLIER', true), key())).toMatchObject({ ok: false, error: { code: 'DOA_NOT_CONFIGURED', details: { documentTypes: ['SUPPLIER_APPROVAL'], versions: [{ code: 'DOA-P1', versionNo: 1 }] } } })
    expect(await setModule(platform, { ...change('SUPPLIER', true), module: 'PAY' }, key())).toMatchObject({ ok: true })
  })

  it('DOA-P2 has both: SUPPLIER switches on', async () => {
    const org = await createP2Org({ modules: [] })
    const platform = await platformCtxFor(org.organizationId)
    expect(await setModule(platform, change('SUPPLIER', true), key())).toMatchObject({ ok: true, data: { module: 'SUPPLIER', enabled: true } })
  })
})

describe('[FR-PLT-011/AC2] [BR-SUP-16] SUPPLIER is switched off only when nothing of it is open (MODULE_IN_USE · OQ-33)', () => {
  it('SOURCING or RISK on holds it; an open application holds it by its id, then by its number; an open portal session holds it; then it switches off', async () => {
    const org = await createP2Org()
    const orgId = org.organizationId
    const platform = await platformCtxFor(orgId)
    for (const dependent of ['SOURCING', 'RISK'] as const) {
      expect(await setModule(platform, change(dependent, true), key())).toMatchObject({ ok: true })
      expect(await setModule(platform, change('SUPPLIER', false), key())).toMatchObject({ ok: false, error: { code: 'MODULE_IN_USE', details: { reason: 'REQUIRED_BY', modules: [dependent] } } })
      expect(await setModule(platform, change(dependent, false), key())).toMatchObject({ ok: true })
    }

    const application = await prisma.supplierApplication.create({
      data: { organizationId: orgId, kind: 'NEW', invitedById: org.member.proc_officer!, invitedAt: NOW, lastActivityAt: NOW, expiresAt: new Date('2026-12-02T03:00:00Z'), nameTh: 'บริษัท ผู้สมัคร จำกัด' },
    })
    expect(await setModule(platform, change('SUPPLIER', false), key())).toMatchObject({ ok: false, error: { code: 'MODULE_IN_USE', details: { reason: 'OPEN_DOCUMENTS', documents: [application.id] } } })
    await prisma.supplierApplication.update({ where: { id: application.id }, data: { status: 'SUBMITTED', number: 'SUP-2569-00001', submittedAt: NOW } })
    expect(await setModule(platform, change('SUPPLIER', false), key())).toMatchObject({ ok: false, error: { details: { documents: ['SUP-2569-00001'] } } })
    await prisma.supplierApplication.update({ where: { id: application.id }, data: { status: 'CANCELLED' } })

    const supplier = await prisma.supplier.create({ data: { organizationId: orgId, code: 'S7-02', nameTh: 'ผู้ขายพอร์ทัล', taxId: '0105555000011' } })
    const contact = await prisma.supplierContact.create({ data: { organizationId: orgId, supplierId: supplier.id, nameTh: 'ผู้ติดต่อ', email: `c-${randomUUID().slice(0, 8)}@supplier.test` } })
    const session = await prisma.portalSession.create({
      data: { organizationId: orgId, contactId: contact.id, sessionHash: hex(), csrfTokenHash: hex(), lastSeenAt: NOW, expiresAt: new Date(NOW.getTime() + 24 * 3_600_000), userAgentHash: hex(), ipHash: hex() },
    })
    // an expired session and one idle past supplier.sessionIdleMinutes (30) hold nothing; the open one is counted, never named
    await prisma.portalSession.create({
      data: { organizationId: orgId, contactId: contact.id, sessionHash: hex(), csrfTokenHash: hex(), lastSeenAt: new Date(NOW.getTime() - 30 * 60_000), expiresAt: new Date(NOW.getTime() + 3_600_000), userAgentHash: hex(), ipHash: hex() },
    })
    await prisma.portalSession.create({
      data: { organizationId: orgId, contactId: contact.id, sessionHash: hex(), csrfTokenHash: hex(), lastSeenAt: NOW, expiresAt: new Date(NOW.getTime() - 1), userAgentHash: hex(), ipHash: hex() },
    })
    expect(await setModule(platform, change('SUPPLIER', false), key())).toMatchObject({ ok: false, error: { details: { reason: 'OPEN_DOCUMENTS', documents: ['PORTAL_SESSIONS:1'] } } })
    await prisma.portalSession.update({ where: { id: session.id }, data: { revokedAt: NOW, revokedReason: 'LOGOUT' } })
    expect(await setModule(platform, change('SUPPLIER', false), key())).toMatchObject({ ok: true, data: { module: 'SUPPLIER', enabled: false } })
  })
})
