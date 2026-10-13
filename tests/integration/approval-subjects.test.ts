import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DoaDocumentType } from '@/core/doa'
import { ALWAYS_STEP_UP_SUBJECTS } from '@/core/pin'
import { APPROVAL_SUBJECTS, type ApprovalSubject } from '@/core/sod'
import { DECISION_STEP_UP_METHODS, PIN_ONLY, policyStepUpMethods, STEP_UP_SUBJECT_TYPES } from '@/server/auth/step-up'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { decideByActionLink } from '@/server/services/approvals/action-link'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import { decideByLinePostback } from '@/server/services/approvals/line-postback'
import { startRoute } from '@/server/services/approvals/route'
import { outsideChannels, SUBJECT_ADAPTERS, TIER1_SUBJECTS } from '@/server/services/approvals/subjects'
import { applyTokenLifecycle, emailLinkSecret, hashLinkSecret } from '@/server/tokens/action-tokens'
import type { DoaOrg } from '../support/doa-org'
import { createP1Org } from '../support/p1-org'
import { pinStepUp, seedTestPins } from '../support/pin'

// The subject registry of the shared base (P1-07, ADR-068, docs/sub-specs/P1.md "ทะเบียน subject step-up และสัญญากลาง"):
// tasks of the seven phase-1 subjects decide through the same commands as tier 1, which call the subject's adapter;
// the empty adapters refuse and leave the task open; a refusal of an adapter rolls everything back; bank account and
// workflow changes take a step-up every time and have no chat button or e-mail link (BR-DOA-25). An organization of
// the phase-1 fixtures (createP1Org): BT-01 sends a transfer of up to 100,000.00 to the DM of the charged department,
// BA-01 a bank account change to the CFO, DOA-CHG-01 a workflow version to the CEO; stepUpThreshold 100,000.00.

const NOW = new Date('2026-10-05T03:00:00Z')
const ROOT = path.resolve(import.meta.dirname, '..', '..')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const NEW_SUBJECTS = APPROVAL_SUBJECTS.filter((s) => !(TIER1_SUBJECTS as readonly string[]).includes(s))

let org: DoaOrg
beforeAll(async () => {
  org = await createP1Org()
  await seedTestPins(org.organizationId)
})
afterEach(() => vi.restoreAllMocks())

/** A route of a phase-1 subject started as its lane's command will, with the tokens the pipeline would issue */
async function routed(type: ApprovalSubject, documentType: DoaDocumentType, input: { amount?: string; department?: string; requester?: string } = {}) {
  const subjectId = randomUUID()
  const requester = org.member[input.requester ?? 'fin_officer']!
  const ctx = org.ctxOf(input.requester ?? 'fin_officer', NOW)
  const started = await forTenant(org.organizationId).$transaction(async (tx) => {
    const r = await startRoute(
      tx,
      ctx,
      { type, id: subjectId, label: 'ทดสอบ' },
      {
        documentType,
        ...(input.amount ? { amount: { netSatang: BigInt(input.amount) * 100n, vatSatang: 0n } } : {}),
        requesterMemberId: requester,
        chargedDepartmentId: org.department[input.department ?? 'CON']!,
        conflictMemberIds: [requester],
        at: NOW,
      },
    )
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    await applyTokenLifecycle(tx, ctx, r.data.events, outsideChannels)
    return r.data
  })
  return { subjectId, taskId: started.firstTask.id, assignee: started.firstTask.assigneeMemberId, routeId: started.routeId }
}

const decidedEvents = (taskId: string) => prisma.event.count({ where: { aggregateType: 'ApprovalTask', aggregateId: taskId, type: 'approval_task.decided' } })
const taskStatus = async (taskId: string) => (await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId } })).status

describe('[FR-DOA-004/AC4] tasks of the new subjects decide through the same commands and their adapter', () => {
  it('the empty adapter refuses VALIDATION_FAILED reason SUBJECT: the task stays OPEN and nothing is written', async () => {
    const t = await routed('BUDGET_TRANSFER', 'BUDGET_TRANSFER', { amount: '50000' })
    expect(t.assignee).toBe(org.member.dm_con)
    expect(await decideTask(org.ctxOf('dm_con', NOW), { taskId: t.taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SUBJECT' } } })
    expect(await taskStatus(t.taskId)).toBe('OPEN')
    expect(await decidedEvents(t.taskId)).toBe(0)
    expect(await prisma.approvalRoute.findUniqueOrThrow({ where: { id: t.routeId } })).toMatchObject({ status: 'ACTIVE' })
  })

  it('an adapter whose decide refuses rolls the whole decision back (SoD and the step-up were checked before it)', async () => {
    const t = await routed('BUDGET_TRANSFER', 'BUDGET_TRANSFER', { amount: '60000' })
    vi.spyOn(SUBJECT_ADAPTERS.BUDGET_TRANSFER, 'decide').mockResolvedValue({ ok: false, error: { code: 'BUDGET_INSUFFICIENT', message: 'not enough budget' } })
    expect(await decideTask(org.ctxOf('dm_con', NOW), { taskId: t.taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'BUDGET_INSUFFICIENT' } })
    expect(await taskStatus(t.taskId)).toBe('OPEN')
    expect(await decidedEvents(t.taskId)).toBe(0)
  })

  it('an adapter that decides gets the route result once; the decision is recorded under the route DOA rule (FR-DOA-005 AC4)', async () => {
    const t = await routed('BUDGET_TRANSFER', 'BUDGET_TRANSFER', { amount: '70000' })
    const decide = vi.spyOn(SUBJECT_ADAPTERS.BUDGET_TRANSFER, 'decide').mockResolvedValue({ ok: true, documentStatus: 'APPROVED', events: [] })
    expect(await decideTask(org.ctxOf('dm_con', NOW), { taskId: t.taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide.mock.calls[0]![3]).toMatchObject({ outcome: 'APPROVED', reasonCommentId: null, facts: { type: 'BUDGET_TRANSFER', documentType: 'BUDGET_TRANSFER' } })
    const event = await prisma.event.findFirstOrThrow({ where: { aggregateId: t.taskId, type: 'approval_task.decided' } })
    const route = await prisma.approvalRoute.findUniqueOrThrow({ where: { id: t.routeId } })
    expect(event).toMatchObject({ doaVersionId: route.doaVersionId, doaRuleCode: 'BT-01' })
    expect(event.data).toMatchObject({ subjectType: 'BUDGET_TRANSFER', subjectId: t.subjectId, doaRuleCode: 'BT-01', decision: 'APPROVE', channel: 'WEB' })
    expect(route.status).toBe('COMPLETED')
  })

  it('separation of duties comes from the adapter: its requesters (BR-SOD-01) and its own rules', async () => {
    const t = await routed('BUDGET_TRANSFER', 'BUDGET_TRANSFER', { amount: '40000' })
    vi.spyOn(SUBJECT_ADAPTERS.BUDGET_TRANSFER, 'sodContext').mockReturnValueOnce({ requesterMemberIds: [org.member.dm_con!] })
    expect(await decideTask(org.ctxOf('dm_con', NOW), { taskId: t.taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-01' } } })
    vi.spyOn(SUBJECT_ADAPTERS.BUDGET_TRANSFER, 'sodContext').mockReturnValueOnce({ requesterMemberIds: [], extra: [{ rule: 'BR-SOD-09', memberIds: [org.member.dm_con!] }] })
    expect(await decideTask(org.ctxOf('dm_con', NOW), { taskId: t.taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-09' } } })
    expect(await taskStatus(t.taskId)).toBe('OPEN')
  })

  it('someone who is not the assignee or the delegator is FORBIDDEN', async () => {
    const t = await routed('BUDGET_TRANSFER', 'BUDGET_TRANSFER', { amount: '30000' })
    expect(await decideTask(org.ctxOf('vp_ops', NOW), { taskId: t.taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-DOA-004/AC5] what the central decide flow refuses for a new subject', () => {
  it('a question to the requester is VALIDATION_FAILED reason SUBJECT (allowsRequestInfo is false)', async () => {
    const t = await routed('BUDGET_TRANSFER', 'BUDGET_TRANSFER', { amount: '20000' })
    expect(await requestInfo(org.ctxOf('dm_con', NOW), { taskId: t.taskId, question: 'ขอรายละเอียดเพิ่ม' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SUBJECT' } } })
  })

  it('a subjectInput the adapter does not take is VALIDATION_FAILED, and so is one sent to a tier-1 task', async () => {
    const t = await routed('BUDGET_TRANSFER', 'BUDGET_TRANSFER', { amount: '21000' })
    expect(await decideTask(org.ctxOf('dm_con', NOW), { taskId: t.taskId, decision: 'APPROVE', subjectInput: { flagsKey: 'x' } }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'subjectInput' } } })
  })

  it('decide.ts, action-link.ts and line-postback.ts name no phase-1 subject', () => {
    for (const file of ['decide.ts', 'action-link.ts', 'line-postback.ts']) {
      const text = readFileSync(path.join(ROOT, 'src/server/services/approvals', file), 'utf8')
      expect(NEW_SUBJECTS.filter((s) => text.includes(`'${s}'`))).toEqual([])
    }
  })

  it('a subject routes only with a document type that lists it (BR-DOA-20, FR-DOA-003 AC5)', async () => {
    await expect(routed('INVOICE', 'PAYMENT_RUN', { amount: '1000', department: 'HQ' })).rejects.toThrow(/"reason":"SUBJECT"/)
  })
})

describe('[FR-AUTH-005/AC4] bank account and workflow changes take a step-up every time, never from the chat or an e-mail link', () => {
  it('both are in ALWAYS_STEP_UP_SUBJECTS; a decision without the PIN is STEP_UP_REQUIRED, with it the adapter is reached', async () => {
    expect(ALWAYS_STEP_UP_SUBJECTS).toEqual(expect.arrayContaining(['BANK_ACCOUNT_CHANGE', 'WORKFLOW_VERSION']))
    const bank = await routed('BANK_ACCOUNT_CHANGE', 'BANK_ACCOUNT_CHANGE', { department: 'HQ' })
    expect(bank.assignee).toBe(org.member.cfo)
    expect(await decideTask(org.ctxOf('cfo', NOW), { taskId: bank.taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
    await pinStepUp(org.organizationId, org.member.cfo!, 'BANK_ACCOUNT_CHANGE', bank.subjectId)
    // Past the step-up the empty adapter answers, so the PIN was taken (and rolled back with the refusal)
    expect(await decideTask(org.ctxOf('cfo', NOW), { taskId: bank.taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SUBJECT' } } })

    const workflow = await routed('WORKFLOW_VERSION', 'DOA_CHANGE', { department: 'IT', requester: 'admin' })
    expect(workflow.assignee).toBe(org.member.ceo)
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: workflow.taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
  })

  it('no e-mail or LINE token is issued for them, and a token that exists anyway is refused STEP_UP_REQUIRED', async () => {
    const bank = await routed('BANK_ACCOUNT_CHANGE', 'BANK_ACCOUNT_CHANGE', { department: 'HQ' })
    const transfer = await routed('BUDGET_TRANSFER', 'BUDGET_TRANSFER', { amount: '10000' })
    expect(await prisma.actionToken.count({ where: { taskId: { in: [bank.taskId, transfer.taskId] } } })).toBe(0)
    for (const t of [bank, transfer]) {
      const assignee = t === bank ? 'cfo' : 'dm_con'
      const id = randomUUID()
      const expiresAt = new Date(NOW.getTime() + 3_600_000)
      await prisma.actionToken.create({ data: { id, organizationId: org.organizationId, memberId: t.assignee, taskId: t.taskId, allowedActions: ['APPROVE', 'REJECT'], channel: 'EMAIL', secretHash: hashLinkSecret(emailLinkSecret(id)), expiresAt } })
      const email = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member[assignee]! }, channel: 'EMAIL', now: NOW })
      expect(await decideByActionLink(email, { link: `${id}.${emailLinkSecret(id)}`, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
      const line = await prisma.actionToken.create({ data: { organizationId: org.organizationId, memberId: t.assignee, taskId: t.taskId, allowedActions: ['APPROVE'], channel: 'LINE', secretHash: null, expiresAt } })
      const chat = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member[assignee]! }, channel: 'LINE_CHAT', now: NOW })
      expect(await decideByLinePostback(chat, { tokenId: line.id }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
      expect(await taskStatus(t.taskId)).toBe('OPEN')
    }
  })
})

describe('[FR-AUTH-005/AC5] one list of step-up proofs and subjects for every deciding command', () => {
  it('DECISION_STEP_UP_METHODS is the PIN until S17-15; policy reads it too; the grant subjects are all twelve', () => {
    expect(DECISION_STEP_UP_METHODS).toEqual(PIN_ONLY)
    expect(policyStepUpMethods('WEB')).toBe(DECISION_STEP_UP_METHODS)
    expect([...STEP_UP_SUBJECT_TYPES]).toEqual([...APPROVAL_SUBJECTS])
  })

  it('the deciding commands name DECISION_STEP_UP_METHODS, never PIN_ONLY', () => {
    for (const file of ['approvals/decide.ts', 'purchase-orders/decide.ts', 'receiving/variance-decide.ts']) {
      const text = readFileSync(path.join(ROOT, 'src/server/services', file), 'utf8')
      expect(text).toContain('DECISION_STEP_UP_METHODS')
      expect(text).not.toContain('PIN_ONLY')
    }
  })
})
