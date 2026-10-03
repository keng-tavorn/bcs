import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { amountToSatang } from '@/core/money/dto'
import { totp } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { grantStepUp } from '@/server/auth/step-up'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { submitDoaVersion } from '@/server/services/doa'
import { draftDoaCopy, getDoaEditor, type DraftCopyInput } from '@/server/services/doa/editor'
import { getDoaSimulation, type SimulatedRouteView } from '@/server/services/doa/simulate'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S3-09 · FR-DOA-009 AC2 (BR-DOA-14): the try-out — document type, amount, charged department and requester in; the
// route and Thai explanation of the version in effect and of a draft out, with the engine of real routing. The draft is
// the demo's: the DM band of purchase requests moved from 20,000 to 30,000 baht. Real Postgres, the §7.4 fixture org.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const CEO_SECRET = 'S'.repeat(32)

let org: DoaOrg
let draftId: string
beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  const ceo = await prisma.member.findUniqueOrThrow({ where: { id: org.member.ceo! } })
  const userId = await upsertUserWithPassword({ email: ceo.email, name: ceo.displayNameTh, password: 'ceo-password-123456' })
  await enableTotpWithSecret(userId, CEO_SECRET, [])
  await prisma.member.update({ where: { id: ceo.id }, data: { userId } })
  const v1 = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })
  const view = await getDoaEditor(org.ctxOf('admin', NOW), v1.id)
  if (!view.ok) throw new Error('editor failed')
  const input: DraftCopyInput = {
    sourceVersionId: v1.id,
    effectiveDate: '2026-11-01',
    changeReason: 'ขยายวงเงิน DM เป็น 30,000 บาท',
    policy: { ...view.data.policy },
    rules: view.data.rules.map((r) => ({
      code: r.code,
      documentType: r.documentType,
      band: r.band && r.code === 'PR-01' ? { ...r.band, upper: '3000000' } : r.band && r.code === 'PR-02' ? { ...r.band, lower: '3000000' } : r.band,
      steps: r.steps.map((s) => ({ approver: s.approver, slaMinutes: s.slaMinutes })),
    })),
  }
  const saved = await draftDoaCopy(org.ctxOf('admin', NOW), input, key())
  if (!saved.ok) throw new Error(JSON.stringify(saved.error))
  draftId = saved.data.versionId
})

const admin = () => org.ctxOf('admin', NOW)
const query = (q: Record<string, string>) => ({ type: 'PURCHASE_REQUEST', department: org.department.CON!, requester: org.member.req_con!, ...q })

async function simulate(q: Record<string, string>, versionId = draftId) {
  const r = await getDoaSimulation(admin(), versionId, q)
  if (!r.ok) throw new Error(`simulation failed: ${JSON.stringify(r.error)}`)
  return r.data
}

const ok = (r: SimulatedRouteView | null | undefined) => {
  if (!r?.ok) throw new Error(`expected a route, got ${JSON.stringify(r)}`)
  return r
}

describe('[FR-DOA-009/AC2] the try-out shows the route of the version in effect and of the draft, with the engine of real routing', () => {
  it('25,000 baht: version 1 sends it to the VP, the draft to the DM, each with its Thai explanation', async () => {
    const view = await simulate(query({ net: '25,000' }))
    expect(view.errors).toEqual({})
    expect(view.inEffect).toMatchObject({ code: 'DOA-DEMO', versionNo: 1 })
    const before = ok(view.result?.inEffect)
    const after = ok(view.result?.version)
    expect(before).toMatchObject({ doaCode: 'DOA-DEMO', versionNo: 1, ruleCode: 'PR-02', escalatedFromRuleCode: null, amountBasis: 'GROSS', basisAmount: '2500000' })
    expect(before.steps.map((s) => s.assignee.id)).toEqual([org.member.vp_ops])
    expect(before.steps[0]).toMatchObject({ position: { code: 'VP' }, department: { code: 'OPS' }, slaMinutes: 480, principal: null })
    expect(before.explanationTh).toBe('DOA-DEMO ฉบับ 1 ข้อ PR-02: คำขอซื้อยอด 25,000.00 บาท (รวม VAT) อยู่ในช่วงมากกว่า 20,000.00 ถึงไม่เกิน 100,000.00 → VP ของสายปฏิบัติการ')
    expect(after).toMatchObject({ doaCode: 'DOA-DEMO', versionNo: 2, ruleCode: 'PR-01' })
    expect(after.steps.map((s) => s.assignee.id)).toEqual([org.member.dm_con])
    expect(after.explanationTh).toBe('DOA-DEMO ฉบับ 2 ข้อ PR-01: คำขอซื้อยอด 25,000.00 บาท (รวม VAT) อยู่ในช่วงไม่เกิน 30,000.00 → DM ของฝ่ายก่อสร้าง')
    expect(view.result?.sameApprovers).toBe(false)
    // Reading only: the try-out writes nothing
    expect(await prisma.approvalRoute.count({ where: { organizationId: org.organizationId } })).toBe(0)
  })

  it('net and VAT follow the version’s amount basis: 19,000 + 1,330 VAT is above 20,000 including VAT', async () => {
    const view = await simulate(query({ net: '19000', vat: '1330' }))
    expect(ok(view.result?.inEffect)).toMatchObject({ ruleCode: 'PR-02', basisAmount: '2033000' })
    expect(ok(view.result?.version)).toMatchObject({ ruleCode: 'PR-01', basisAmount: '2033000' })
  })

  it('a requester who is the approver is moved up a band in both versions (BR-DOA-06), so both reach the same VP', async () => {
    const view = await simulate(query({ net: '15000', requester: org.member.dm_con! }))
    expect(ok(view.result?.inEffect)).toMatchObject({ ruleCode: 'PR-02', escalatedFromRuleCode: 'PR-01' })
    expect(ok(view.result?.version)).toMatchObject({ ruleCode: 'PR-02', escalatedFromRuleCode: 'PR-01' })
    expect(view.result?.sameApprovers).toBe(true)
  })

  it('a policy change has no amount and goes to the CEO in both', async () => {
    const view = await simulate({ type: 'DOA_CHANGE', net: '999', department: org.department.IT!, requester: org.member.admin! })
    expect(ok(view.result?.inEffect)).toMatchObject({ ruleCode: 'DOA-CHG-01', basisAmount: null })
    expect(ok(view.result?.version).steps.map((s) => s.assignee.id)).toEqual([org.member.ceo])
  })

  it('what the engine refuses comes back with what is missing: nobody holds DM at the root', async () => {
    const view = await simulate(query({ net: '10000', department: org.department.HQ!, requester: org.member.coo! }))
    expect(view.result?.inEffect).toEqual({ ok: false, code: 'APPROVER_NOT_FOUND', reason: null, ruleCode: 'PR-01', position: 'DM', departments: ['HQ'], rules: [] })
    expect(view.result?.version).toMatchObject({ ok: false, code: 'APPROVER_NOT_FOUND' })
  })

  it('the form says what to fix and routes nothing until it can', async () => {
    expect(await simulate({})).toMatchObject({ errors: {}, result: null, input: { type: 'PURCHASE_REQUEST', net: '', vat: '', department: '', requester: '' } })
    expect(await simulate({ type: 'PURCHASE_REQUEST', net: '25000' })).toMatchObject({ errors: { department: 'REQUIRED', requester: 'REQUIRED' }, result: null })
    expect(await simulate(query({ net: 'abc' }))).toMatchObject({ errors: { net: 'INVALID' }, result: null })
    expect(await simulate(query({ net: '0' }))).toMatchObject({ errors: { net: 'AMOUNT_NOT_POSITIVE' }, result: null })
    expect(await simulate(query({}))).toMatchObject({ errors: { net: 'REQUIRED' }, result: null })
    expect(await simulate(query({ net: '1000', vat: '1.234' }))).toMatchObject({ errors: { vat: 'INVALID' }, result: null })
    expect(await simulate(query({ net: '1000', type: 'NOT_A_TYPE' }))).toMatchObject({ errors: { type: 'INVALID' }, result: null })
    expect(await simulate(query({ net: '1000', requester: randomUUID(), department: randomUUID() }))).toMatchObject({ errors: { requester: 'INVALID', department: 'INVALID' }, result: null })
  })

  it('only an organization admin tries out a version (admin.doa.simulate); the BCS team cannot', async () => {
    expect(await getDoaSimulation(org.ctxOf('dm_it', NOW), draftId, query({ net: '25000' }))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getDoaSimulation(org.ctxOf('req_con', NOW), draftId, {})).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const platform = makeCtx({ organizationId: org.organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: randomUUID() }, channel: 'WEB', now: NOW })
    expect(await getDoaSimulation(platform, draftId, {})).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getDoaSimulation(admin(), randomUUID(), {})).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('an admin of another organization gets NOT_FOUND for this organization’s draft, with or without a document', async () => {
    const other = await createDoaOrg()
    await prisma.roleAssignment.create({ data: { organizationId: other.organizationId, memberId: other.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
    const otherAdmin = other.ctxOf('admin', NOW)
    expect(await getDoaSimulation(otherAdmin, draftId, {})).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    // Even with this organization's department and requester in the address, nothing of it is routed or shown
    expect(await getDoaSimulation(otherAdmin, draftId, query({ net: '25000' }))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('once the draft is approved and in effect, a real request takes exactly the route the try-out showed', async () => {
    const tried = ok((await simulate(query({ net: '25000' }))).result?.version)
    expect(await submitDoaVersion(admin(), { versionId: draftId, boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draftId } } } })
    await grantStepUp({ organizationId: org.organizationId, memberId: org.member.ceo!, subjectType: 'DOA_VERSION', subjectId: draftId, code: totp(CEO_SECRET) }, new Date())
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'PUBLISHED' } })

    // 2 November: version 2 is in effect
    const later = new Date('2026-11-02T03:00:00Z')
    const draft = await createDraft(org.ctxOf('req_con', later), { requestTypeCode: 'BUY_GOODS', title: 'ไม้แบบ', priceIncludesVat: true, lines: [{ description: 'ไม้แบบ', quantity: '1', uom: 'ชุด', unitPrice: '25000.00' }] }, key())
    if (!draft.ok) throw new Error(JSON.stringify(draft.error))
    expect(await submitRequest(org.ctxOf('req_con', later), { requestId: draft.data.requestId }, key())).toMatchObject({ ok: true })
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: draft.data.requestId }, include: { steps: { include: { tasks: true } } } })
    expect(route).toMatchObject({ doaVersionId: draftId, ruleCode: tried.ruleCode, explanationTh: tried.explanationTh })
    expect(route.steps.flatMap((s) => s.tasks.map((t) => t.assigneeMemberId))).toEqual(tried.steps.map((s) => s.assignee.id))
    expect(amountToSatang('25000.00').toString()).toBe(tried.basisAmount)
  })
})
