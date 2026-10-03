import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { orgChangeInput } from '@/app/(workspace)/admin/org-authority/draft-input'
import { getEnv } from '@/lib/env'
import { totp } from '@/lib/totp'
import { auth } from '@/server/auth/auth'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { holdsDoaReferencedPosition, resolveSession } from '@/server/auth/session'
import { grantStepUp } from '@/server/auth/step-up'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { doaNamedApprovers } from '@/server/doa/policy'
import { decideTask, provideInfo, requestInfo } from '@/server/services/approvals/decide'
import { createDelegation } from '@/server/services/delegations'
import { importDoaDraft, submitDoaVersion } from '@/server/services/doa'
import { previewOrgChange, proposeOrgChange } from '@/server/services/org-authority'
import { getOrgChangeFormForAdmin, listOrgChangesForAdmin } from '@/server/services/org-authority/view'
import { assignHolder, createCostCenter, createDepartment } from '@/server/services/org-structure'
import { getOrgStructureForAdmin } from '@/server/services/org-structure/view'
import { createDraft, submitRequest } from '@/server/services/requests'
import type { OrgChangeDraft } from '@/ui/admin-org/org-change-form'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S2-13 screens of the organization structure and of authority changes (FR-ADM-002, FR-DOA-010 AC1), read through the
// services the pages call: what each page shows, the impact a proposal shows before it is sent — the pending tasks that
// move to a new holder or stay when a slot becomes vacant — that a preview writes nothing but a refusal by separation of
// duties (recorded once per attempt), what a holder change does to pending tasks (open ones and ones waiting for the
// requester's answer), and that only an organization admin reads any of it. FR-AUTH-002 AC1: a member holding a
// position a DOA refers to must set up two-step sign-in like a member with a role.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const CEO_SECRET = 'Q'.repeat(32)
const PASSWORD = 'screen-test-password-1'

/** An organization of the §7.4 fixtures with an ORG_ADMIN (admin) and a CEO who signs in with an authenticator */
async function orgWithCeo(): Promise<DoaOrg> {
  const o = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: o.organizationId, memberId: o.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  const ceo = await prisma.member.findUniqueOrThrow({ where: { id: o.member.ceo! } })
  const userId = await upsertUserWithPassword({ email: ceo.email, name: ceo.displayNameTh, password: PASSWORD })
  await enableTotpWithSecret(userId, CEO_SECRET, [])
  await prisma.member.update({ where: { id: ceo.id }, data: { userId } })
  return o
}

/** The CEO approves the change's task with a step-up, as the governance approver */
async function ceoApproves(o: DoaOrg, changeId: string) {
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: changeId } } } })
  expect(await grantStepUp({ organizationId: o.organizationId, memberId: o.member.ceo!, subjectType: 'ORG_AUTHORITY_CHANGE', subjectId: changeId, code: totp(CEO_SECRET) }, new Date())).toMatchObject({ ok: true })
  expect(await decideTask(o.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
}

/** A request of `gross` baht from `requester`, waiting for its first approver; returns the request and its task */
async function waitingRequest(o: DoaOrg, requester: string, gross: string) {
  const draft = await createDraft(o.ctxOf(requester, NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', priceIncludesVat: true, lines: [{ description: 'วัสดุ', quantity: '1', uom: 'ชุด', unitPrice: gross }] }, key())
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
  const sent = await submitRequest(o.ctxOf(requester, NOW), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.data.requestId } } } })
  return { requestId: draft.data.requestId, task }
}

let org: DoaOrg
beforeAll(async () => {
  org = await orgWithCeo()
})

const admin = () => org.ctxOf('admin', NOW)
const counts = async () => ({
  changes: await prisma.orgAuthorityChange.count({ where: { organizationId: org.organizationId } }),
  events: await prisma.event.count({ where: { organizationId: org.organizationId } }),
})

describe('[FR-ADM-002/AC2] the positions page says which positions change holders at once and which need an approved change', () => {
  it('marks positions the DOA names, and positions open tasks came from, as carrying authority; lists holders by department', async () => {
    const position = await prisma.position.create({ data: { organizationId: org.organizationId, code: 'SITE_LEAD', nameTh: 'หัวหน้าหน้างาน', scope: 'DEPARTMENT' } })
    await prisma.positionAssignment.create({ data: { organizationId: org.organizationId, positionId: position.id, departmentId: org.department.CON!, memberId: org.member.asst_con!, validFrom: NOW } })
    const { task } = await waitingRequest(org, 'req_con', '300.00')
    // A task an earlier DOA version gave the SITE_LEAD of CON (BR-DOA-13 keeps it on that route)
    await prisma.approvalTask.update({ where: { id: task.id }, data: { resolvedFrom: 'POSITION:SITE_LEAD@CON', assigneeMemberId: org.member.asst_con! } })

    const view = await getOrgStructureForAdmin(admin())
    if (!view.ok) throw new Error(JSON.stringify(view.error))
    const byCode = new Map(view.data.positions.map((p) => [p.code, p]))
    for (const code of ['DM', 'VP', 'COO', 'CEO']) expect(byCode.get(code), code).toMatchObject({ authority: true, namedByDoa: true })
    expect(byCode.get('PROC_MGR')).toMatchObject({ authority: false, namedByDoa: false, openTasks: 0 })
    expect(byCode.get('SITE_LEAD')).toMatchObject({ authority: true, namedByDoa: false, openTasks: 1 })
    expect(byCode.get('SITE_LEAD')!.holders).toMatchObject([{ departmentCode: 'CON', member: { id: org.member.asst_con }, openTasks: 1 }])
    expect(byCode.get('DM')!.holders.map((h) => [h.departmentCode, h.member.id])).toEqual([
      ['CON', org.member.dm_con],
      ['FIN', org.member.dm_fin],
      ['IT', org.member.dm_it],
      ['PROC', org.member.dm_proc],
    ])
    // The departments come as a tree: every department right after its parent, one level deeper
    const depth = new Map(view.data.departments.map((d) => [d.code, d.depth]))
    expect(view.data.departments[0]).toMatchObject({ code: 'HQ', depth: 0, parentId: null })
    expect([depth.get('OPS'), depth.get('CON'), depth.get('IT')]).toEqual([1, 2, 2])
    for (const [i, d] of view.data.departments.entries()) {
      if (d.parentId) expect(view.data.departments.findIndex((p) => p.id === d.parentId), d.code).toBeLessThan(i)
    }
  })

  it('a holder assigned at once shows on the page with the event of the change', async () => {
    expect(await assignHolder(admin(), { positionCode: 'PROC_MGR', departmentId: org.department.HQ!, memberId: org.member.proc_officer! }, key())).toMatchObject({ ok: true })
    const view = await getOrgStructureForAdmin(admin())
    if (!view.ok) throw new Error('view failed')
    expect(view.data.positions.find((p) => p.code === 'PROC_MGR')!.holders.map((h) => h.member.id)).toEqual([org.member.proc_officer])
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'position.assigned', data: { path: ['memberId'], equals: org.member.proc_officer } } })).toBe(1)
  })

  it('only an organization admin reads the structure', async () => {
    expect(await getOrgStructureForAdmin(org.ctxOf('dm_it', NOW))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-ADM-002/AC1] the departments and cost centers pages show what was added at once', () => {
  it('lists a new department under its parent with its cost centers, and the cost center with its department', async () => {
    const created = await createDepartment(admin(), { code: 'SAFE', nameTh: 'ฝ่ายความปลอดภัย', parentId: org.department.OPS!, kind: 'DEPARTMENT' }, key())
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    expect(await createCostCenter(admin(), { code: 'CC-SAFE', nameTh: 'ศูนย์ต้นทุนความปลอดภัย', departmentId: created.data.departmentId }, key())).toMatchObject({ ok: true })
    const view = await getOrgStructureForAdmin(admin())
    if (!view.ok) throw new Error('view failed')
    expect(view.data.departments.find((d) => d.code === 'SAFE')).toMatchObject({ parentId: org.department.OPS, depth: 2, costCenters: 1, kind: 'DEPARTMENT' })
    expect(view.data.costCenters.find((c) => c.code === 'CC-SAFE')).toMatchObject({ active: true, department: { code: 'SAFE', nameTh: 'ฝ่ายความปลอดภัย' } })
    // Only active members are offered in the pickers
    expect(view.data.members.every((m) => typeof m.nameTh === 'string')).toBe(true)
  })
})

describe('[FR-DOA-010/AC1] before sending, the proposal shows its impact; the preview itself writes nothing', () => {
  it('appointing a new VP of OPS: the new holder gains, the old one loses, the pending task moves, the CEO approves under ORG-CHG-01', async () => {
    await waitingRequest(org, 'req_con', '45000.00')
    const input = { kind: 'POSITION_ASSIGN' as const, payload: { positionCode: 'VP', departmentId: org.department.OPS!, memberId: org.member.dm_proc! }, effectiveFrom: '2026-10-20T01:00:00Z', reason: 'แต่งตั้งตามคำสั่งบริษัท' }
    const before = await counts()
    const preview = await previewOrgChange(admin(), input, key())
    expect(preview).toMatchObject({
      ok: true,
      data: {
        effectiveFrom: '2026-10-20T01:00:00.000Z',
        warnings: [],
        gains: [{ id: org.member.dm_proc, nameTh: 'ผู้ใช้ dm_proc' }],
        loses: [{ id: org.member.vp_ops, nameTh: 'ผู้ใช้ vp_ops' }],
        openTasks: 1,
        openTasksStay: 0,
        route: { doaCode: 'DOA-DEMO', versionNo: 1, ruleCode: 'ORG-CHG-01', approvers: [{ id: org.member.ceo, onBehalfOf: null }] },
      },
    })
    expect(await counts()).toEqual(before)

    // Sending it stores the same impact and goes to the approver the preview named
    const sent = await proposeOrgChange(admin(), input, key())
    if (!sent.ok || !preview.ok) throw new Error(JSON.stringify(sent))
    expect(sent.data.assigneeMemberId).toBe(preview.data.route.approvers[0]!.id)
    expect((await prisma.orgAuthorityChange.findUniqueOrThrow({ where: { id: sent.data.changeId } })).impactSummary).toEqual({ gains: [org.member.dm_proc], loses: [org.member.vp_ops], openTasks: 1, openTasksStay: 0 })
  })

  it('ending the DM of IT without a replacement asks for the vacancy to be acknowledged, before and when sending', async () => {
    const input = { kind: 'POSITION_END' as const, payload: { positionCode: 'DM', departmentId: org.department.IT! }, effectiveFrom: '2026-10-21T01:00:00Z', reason: 'ลาออก' }
    const preview = await previewOrgChange(admin(), input, key())
    expect(preview).toMatchObject({ ok: true, data: { warnings: ['POSITION_VACANT:DM@IT'], gains: [], loses: [{ id: org.member.dm_it }], openTasks: 0 } })
    expect(await proposeOrgChange(admin(), input, key())).toMatchObject({ ok: false, error: { details: { reason: 'WARNINGS_NOT_ACKNOWLEDGED', warnings: ['POSITION_VACANT:DM@IT'] } } })
    expect(await proposeOrgChange(admin(), { ...input, acknowledgedWarnings: ['POSITION_VACANT:DM@IT'] }, key())).toMatchObject({ ok: true })
  })

  it('[FR-DOA-007/AC2] a proposal that would benefit the proposer is refused in the preview too, and the refusal is recorded once per attempt', async () => {
    const blocked = () => prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'security.sod_blocked' }, orderBy: { seq: 'asc' }, select: { data: true, actorMemberId: true } })
    const own = { kind: 'POSITION_ASSIGN' as const, payload: { positionCode: 'DM', departmentId: org.department.IT!, memberId: org.member.admin! }, effectiveFrom: '2026-10-22T01:00:00Z', reason: 'แต่งตั้ง' }
    const before = await blocked()
    const changes = (await counts()).changes
    const attempt = key()
    expect(await previewOrgChange(admin(), own, attempt)).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-08' } } })
    const after = await blocked()
    expect(after).toHaveLength(before.length + 1)
    expect(after.at(-1)).toMatchObject({ actorMemberId: org.member.admin, data: { rule: 'BR-SOD-08', action: 'org_authority.preview', subjectType: 'ORG_AUTHORITY_CHANGE', actorMemberId: org.member.admin } })
    // The same attempt again (a retry after a lost answer) is answered the same and recorded once
    expect(await previewOrgChange(admin(), own, attempt)).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-08' } } })
    expect(await blocked()).toHaveLength(before.length + 1)
    // A new attempt is a new refusal; sending it is refused and recorded as a proposal
    await previewOrgChange(admin(), own, key())
    expect(await proposeOrgChange(admin(), own, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION' } })
    expect((await blocked()).slice(before.length).map((e) => (e.data as { action: string }).action)).toEqual(['org_authority.preview', 'org_authority.preview', 'org_authority.propose'])
    expect((await counts()).changes).toBe(changes)
    // A preview another rule refuses records nothing
    const none = await blocked()
    expect(await previewOrgChange(admin(), { kind: 'POSITION_ASSIGN', payload: { positionCode: 'VP', departmentId: org.department.SUP!, memberId: org.member.dm_fin! }, effectiveFrom: '2026-10-01T00:00:00Z', reason: 'ย้อนหลัง' }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { reason: 'EFFECTIVE_IN_PAST' } },
    })
    expect(await previewOrgChange(admin(), { kind: 'IDENTITY_RESET', payload: { memberId: 'not-a-member' }, reason: 'x' } as never, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await blocked()).toHaveLength(none.length)
  })

  it('a move under its own child is refused in the preview with the reason the page shows', async () => {
    expect(await previewOrgChange(admin(), { kind: 'DEPARTMENT_REPARENT', payload: { departmentId: org.department.OPS!, newParentId: org.department.CON! }, effectiveFrom: '2026-10-22T01:00:00Z', reason: 'ปรับโครงสร้าง' }, key())).toMatchObject({
      ok: false,
      error: { details: { reason: 'CYCLE' } },
    })
  })

  it('a delegation on behalf filled in on the form — Thai times, an amount with separators — is sent through the form adapter as the service reads it', async () => {
    const draft: OrgChangeDraft = {
      kind: 'DELEGATION_ON_BEHALF',
      positionCode: '',
      departmentId: '',
      memberId: '',
      replacementMemberId: '',
      newParentId: '',
      delegatorMemberId: org.member.vp_sup!,
      delegateMemberId: org.member.dm_fin!,
      startsAt: '2026-11-02T08:30',
      endsAt: '2026-11-06T17:00',
      documentTypes: ['PURCHASE_REQUEST'],
      maxAmount: '50,000.50',
      // The delegation's own start governs: a chosen effective time is ignored for this kind
      effectiveMode: 'AT',
      effectiveAt: '2026-12-01T09:00',
      reason: 'รองประธานสายสนับสนุนลาพักร้อน',
    }
    const built = orgChangeInput(draft, NOW, [])
    expect(built).toEqual({
      ok: true,
      input: {
        kind: 'DELEGATION_ON_BEHALF',
        payload: { delegatorMemberId: org.member.vp_sup, delegateMemberId: org.member.dm_fin, startsAt: '2026-11-02T01:30:00.000Z', endsAt: '2026-11-06T10:00:00.000Z', documentTypes: ['PURCHASE_REQUEST'], maxAmount: '50000.50' },
        effectiveFrom: NOW.toISOString(),
        reason: 'รองประธานสายสนับสนุนลาพักร้อน',
        acknowledgedWarnings: [],
      },
    })
    if (!built.ok) return
    expect(await previewOrgChange(admin(), built.input, key())).toMatchObject({ ok: true, data: { gains: [{ id: org.member.dm_fin }], loses: [], openTasks: 0, openTasksStay: 0 } })
    const sent = await proposeOrgChange(admin(), built.input, key())
    if (!sent.ok) throw new Error(JSON.stringify(sent.error))
    const change = await prisma.orgAuthorityChange.findUniqueOrThrow({ where: { id: sent.data.changeId } })
    expect(change).toMatchObject({ kind: 'DELEGATION_ON_BEHALF', status: 'PENDING_APPROVAL', effectiveFrom: NOW, payload: { startsAt: '2026-11-02T01:30:00.000Z', maxAmount: '50000.50' } })
    // The list says it is recorded on approval, not at the sending time
    const list = await listOrgChangesForAdmin(admin())
    if (!list.ok) throw new Error('list failed')
    expect(list.data.find((c) => c.id === sent.data.changeId)).toMatchObject({ onApproval: true, details: { kind: 'DELEGATION_ON_BEHALF', maxAmount: '5000050' } })

    // A time that is not a real date or time is answered at its field, as the service would
    expect(orgChangeInput({ ...draft, startsAt: '2026-02-30T08:00' }, NOW, [])).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'INVALID_PERIOD' })
    expect(orgChangeInput({ ...draft, kind: 'POSITION_ASSIGN', effectiveAt: '2026-12-01T25:00' }, NOW, [])).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'effectiveFrom' })
    expect(orgChangeInput({ ...draft, kind: 'POSITION_ASSIGN', effectiveAt: '2026-12-01T09:00' }, NOW, [])).toMatchObject({ ok: true, input: { effectiveFrom: '2026-12-01T02:00:00.000Z' } })
    expect(orgChangeInput({ ...draft, kind: 'POSITION_ASSIGN', effectiveMode: 'ON_APPROVAL' }, NOW, [])).toMatchObject({ ok: true, input: { effectiveFrom: NOW.toISOString() } })
  })

  it('only an organization admin previews, lists or opens the proposal form', async () => {
    const other = org.ctxOf('dm_it', NOW)
    expect(await previewOrgChange(other, { kind: 'IDENTITY_RESET', payload: { memberId: org.member.dm_con! }, reason: 'ทำโทรศัพท์หาย' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await listOrgChangesForAdmin(other)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getOrgChangeFormForAdmin(other)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-DOA-010/AC2] the list of changes shows each change with its status and route', () => {
  it('shows what the change does, who decides under which rule, and the decision once made', async () => {
    const sent = await proposeOrgChange(admin(), { kind: 'POSITION_ASSIGN', payload: { positionCode: 'VP', departmentId: org.department.SUP!, memberId: org.member.dm_fin! }, effectiveFrom: '2026-10-25T01:00:00Z', reason: 'แต่งตั้ง VP สายสนับสนุน' }, key())
    if (!sent.ok) throw new Error(JSON.stringify(sent.error))
    const listed = async () => {
      const list = await listOrgChangesForAdmin(admin())
      if (!list.ok) throw new Error('list failed')
      return list.data.find((c) => c.id === sent.data.changeId)!
    }
    expect(await listed()).toMatchObject({
      kind: 'POSITION_ASSIGN',
      status: 'PENDING_APPROVAL',
      reason: 'แต่งตั้ง VP สายสนับสนุน',
      onApproval: false,
      submittedBy: { id: org.member.admin },
      details: { kind: 'POSITION_ASSIGN', position: { code: 'VP' }, department: { code: 'SUP' }, member: { id: org.member.dm_fin } },
      impact: { gains: [{ id: org.member.dm_fin }], loses: [{ id: org.member.vp_sup }] },
      route: { ruleCode: 'ORG-CHG-01', doaCode: 'DOA-DEMO', versionNo: 1, initialPackage: false, tasks: [{ assignee: { id: org.member.ceo }, status: 'OPEN', decidedBy: null }] },
    })

    // The CEO approves with a step-up: the change waits for its effective time and the route shows the decision
    await ceoApproves(org, sent.data.changeId)
    expect(await listed()).toMatchObject({ status: 'SCHEDULED', appliedAt: null, route: { tasks: [{ status: 'APPROVED', decidedBy: { id: org.member.ceo } }] } })
  })

  it('a change sent to take effect on approval says so, and once applied shows when it took effect', async () => {
    const sent = await proposeOrgChange(admin(), { kind: 'POSITION_ASSIGN', payload: { positionCode: 'VP', departmentId: org.department.OPS!, memberId: org.member.coo! }, effectiveFrom: NOW.toISOString(), reason: 'แต่งตั้งทันทีเมื่ออนุมัติ' }, key())
    if (!sent.ok) throw new Error(JSON.stringify(sent.error))
    const listed = async () => {
      const list = await listOrgChangesForAdmin(admin())
      if (!list.ok) throw new Error('list failed')
      return list.data.find((c) => c.id === sent.data.changeId)!
    }
    expect(await listed()).toMatchObject({ onApproval: true, appliedAt: null })
    await ceoApproves(org, sent.data.changeId)
    expect(await listed()).toMatchObject({ status: 'APPLIED', onApproval: true, appliedAt: NOW.toISOString() })
  })

  it('the proposal form offers the departments as a tree, the positions with their authority and the current holders', async () => {
    const form = await getOrgChangeFormForAdmin(admin())
    if (!form.ok) throw new Error('form failed')
    expect(form.data.departments[0]).toMatchObject({ code: 'HQ', depth: 0, parentId: null })
    expect(form.data.positions.find((p) => p.code === 'CEO')).toMatchObject({ scope: 'ORG', authority: true })
    expect(form.data.holders.find((h) => h.positionCode === 'CEO')).toMatchObject({ departmentId: org.department.HQ, member: { id: org.member.ceo } })
  })
})

// ---------- FR-ADM-002 AC3 / BR-DOA-17: what a holder change does to pending tasks ----------

describe('[FR-ADM-002/AC3] [FR-DOA-010/AC4] every pending task of a slot follows its new holder, including tasks waiting for the requester', () => {
  it('moves open tasks, a task waiting for an answer and a task a delegate holds; the former holder decides none of them', async () => {
    const o = await orgWithCeo()
    const first = await waitingRequest(o, 'req_con', '300.00')
    const second = await waitingRequest(o, 'req_con', '500.00')
    expect([first.task.assigneeMemberId, second.task.assigneeMemberId]).toEqual([o.member.dm_con, o.member.dm_con])
    // dm_con asks the requester a question on the second request: the task waits, with the business time it had left
    const asked = await requestInfo(o.ctxOf('dm_con', NOW), { taskId: second.task.id, question: 'ขอใบเสนอราคาเพิ่มอีกหนึ่งใบ' }, key())
    if (!asked.ok) throw new Error(JSON.stringify(asked.error))
    const waiting = await prisma.approvalTask.findUniqueOrThrow({ where: { id: second.task.id } })
    expect(waiting).toMatchObject({ status: 'INFO_REQUESTED' })
    // dm_con is away: asst_con acts for dm_con, so a third request goes to asst_con on dm_con's behalf
    expect(await createDelegation(o.ctxOf('dm_con', NOW), { delegateMemberId: o.member.asst_con!, startsAt: '2026-10-05T00:00:00+07:00', endsAt: '2026-10-09T00:00:00+07:00', reason: 'ลาพักร้อน' }, key())).toMatchObject({ ok: true })
    const third = await waitingRequest(o, 'req_con', '700.00')
    expect(third.task).toMatchObject({ assigneeMemberId: o.member.asst_con, principalMemberId: o.member.dm_con, resolvedFrom: 'POSITION:DM@CON' })

    // The preview counts the three pending tasks of the slot as moving to the new holder
    const input = { kind: 'POSITION_ASSIGN' as const, payload: { positionCode: 'DM', departmentId: o.department.CON!, memberId: o.member.receiver_con! }, effectiveFrom: NOW.toISOString(), reason: 'แต่งตั้งผู้จัดการฝ่ายก่อสร้างคนใหม่' }
    expect(await previewOrgChange(o.ctxOf('admin', NOW), input, key())).toMatchObject({ ok: true, data: { gains: [{ id: o.member.receiver_con }], loses: [{ id: o.member.dm_con }], openTasks: 3, openTasksStay: 0 } })
    const sent = await proposeOrgChange(o.ctxOf('admin', NOW), input, key())
    if (!sent.ok) throw new Error(JSON.stringify(sent.error))
    await ceoApproves(o, sent.data.changeId)
    expect(await prisma.orgAuthorityChange.findUniqueOrThrow({ where: { id: sent.data.changeId } })).toMatchObject({ status: 'APPLIED' })

    // Every one of them now waits for receiver_con in their own name, with the same DOA reference and state
    for (const old of [first.task, second.task, third.task]) expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: 'REASSIGNED' })
    const moved = async (oldId: string) => prisma.approvalTask.findFirstOrThrow({ where: { reassignedFromTaskId: oldId } })
    expect(await moved(first.task.id)).toMatchObject({ status: 'OPEN', assigneeMemberId: o.member.receiver_con, principalMemberId: null, resolvedFrom: 'POSITION:DM@CON', stepId: first.task.stepId })
    const movedSecond = await moved(second.task.id)
    expect(movedSecond).toMatchObject({ status: 'INFO_REQUESTED', assigneeMemberId: o.member.receiver_con, remainingBusinessMinutes: waiting.remainingBusinessMinutes, stepId: second.task.stepId })
    expect(await moved(third.task.id)).toMatchObject({ status: 'OPEN', assigneeMemberId: o.member.receiver_con, principalMemberId: null })
    expect(await prisma.infoRequest.findUniqueOrThrow({ where: { id: asked.data.infoRequestId } })).toMatchObject({ taskId: movedSecond.id, answeredAt: null })
    const reassigned = await prisma.event.findMany({ where: { organizationId: o.organizationId, type: 'approval_task.reassigned' }, select: { data: true } })
    expect(reassigned.map((e) => e.data)).toEqual(expect.arrayContaining([expect.objectContaining({ fromTaskId: second.task.id, toMemberId: o.member.receiver_con, why: 'ORG_AUTHORITY_CHANGE', changeId: sent.data.changeId })]))

    // The former holder and the former delegate decide nothing any more
    expect(await decideTask(o.ctxOf('dm_con', NOW), { taskId: first.task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await decideTask(o.ctxOf('dm_con', NOW), { taskId: (await moved(first.task.id)).id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await decideTask(o.ctxOf('asst_con', NOW), { taskId: (await moved(third.task.id)).id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })

    // The requester answers: the new holder's task opens again, they are told, and they decide it
    expect(await provideInfo(o.ctxOf('req_con', NOW), { infoRequestId: asked.data.infoRequestId, answer: 'แนบใบเสนอราคาเพิ่มแล้ว' }, key())).toMatchObject({ ok: true, data: { taskId: movedSecond.id } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: movedSecond.id } })).toMatchObject({ status: 'OPEN', remainingBusinessMinutes: null })
    expect(await prisma.notification.count({ where: { recipientMemberId: o.member.receiver_con, templateKey: 'request.info_provided' } })).toBe(1)
    expect(await decideTask(o.ctxOf('receiver_con', NOW), { taskId: movedSecond.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
  })

  it('ending a holder with nobody new: the preview and the list say the pending tasks stay, and the next holder takes them', async () => {
    const o = await orgWithCeo()
    const pending = await waitingRequest(o, 'admin', '300.00')
    expect(pending.task).toMatchObject({ assigneeMemberId: o.member.dm_it, resolvedFrom: 'POSITION:DM@IT' })

    const end = { kind: 'POSITION_END' as const, payload: { positionCode: 'DM', departmentId: o.department.IT! }, effectiveFrom: NOW.toISOString(), reason: 'ผู้จัดการฝ่ายไอทีลาออก', acknowledgedWarnings: ['POSITION_VACANT:DM@IT'] }
    expect(await previewOrgChange(o.ctxOf('admin', NOW), end, key())).toMatchObject({ ok: true, data: { warnings: ['POSITION_VACANT:DM@IT'], gains: [], loses: [{ id: o.member.dm_it }], openTasks: 0, openTasksStay: 1 } })
    const ended = await proposeOrgChange(o.ctxOf('admin', NOW), end, key())
    if (!ended.ok) throw new Error(JSON.stringify(ended.error))
    await ceoApproves(o, ended.data.changeId)
    // The slot is vacant: the task stays where it was, and the admins are told how many stay
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: pending.task.id } })).toMatchObject({ status: 'OPEN', assigneeMemberId: o.member.dm_it })
    const notice = await prisma.notification.findFirstOrThrow({ where: { recipientMemberId: o.member.admin, templateKey: 'position.vacant', subjectId: ended.data.changeId } })
    expect(notice.data).toMatchObject({ positionCode: 'DM', departmentId: o.department.IT, openTasks: 1 })
    const list = await listOrgChangesForAdmin(o.ctxOf('admin', NOW))
    if (!list.ok) throw new Error('list failed')
    expect(list.data.find((c) => c.id === ended.data.changeId)).toMatchObject({ status: 'APPLIED', impact: { openTasks: 0, openTasksStay: 1, loses: [{ id: o.member.dm_it }] } })

    // A new DM of IT takes the task that stayed with the former holder
    const appoint = { kind: 'POSITION_ASSIGN' as const, payload: { positionCode: 'DM', departmentId: o.department.IT!, memberId: o.member.dm_fin! }, effectiveFrom: NOW.toISOString(), reason: 'แต่งตั้งผู้จัดการฝ่ายไอทีคนใหม่' }
    expect(await previewOrgChange(o.ctxOf('admin', NOW), appoint, key())).toMatchObject({ ok: true, data: { loses: [], openTasks: 1, openTasksStay: 0 } })
    const appointed = await proposeOrgChange(o.ctxOf('admin', NOW), appoint, key())
    if (!appointed.ok) throw new Error(JSON.stringify(appointed.error))
    await ceoApproves(o, appointed.data.changeId)
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: pending.task.id } })).toMatchObject({ status: 'REASSIGNED' })
    expect(await prisma.approvalTask.findFirstOrThrow({ where: { reassignedFromTaskId: pending.task.id } })).toMatchObject({ status: 'OPEN', assigneeMemberId: o.member.dm_fin })
  })
})

// ---------- FR-AUTH-002 AC1 ----------

/** Signs in through Better Auth's HTTP handler (the path a browser uses) and returns the session cookie. */
async function signIn(email: string): Promise<string> {
  const env = getEnv()
  const res = await auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.APP_URL, 'x-forwarded-for': `198.18.40.${Math.floor(Math.random() * 200) + 1}` },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  )
  expect(res.status).toBe(200)
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}

/** The member of the fixture signs in with a password only (no authenticator yet) */
async function sessionKind(solo: DoaOrg, code: string): Promise<string> {
  const member = await prisma.member.findUniqueOrThrow({ where: { id: solo.member[code]! } })
  if (!member.userId) {
    const userId = await upsertUserWithPassword({ email: member.email, name: member.displayNameTh, password: PASSWORD })
    await prisma.member.update({ where: { id: member.id }, data: { userId } })
  }
  return (await resolveSession(new Headers({ cookie: await signIn(member.email) }))).kind
}

/** What doaNamedApprovers says for every member of the organization, against the check sign-in runs */
async function expectSameAsNamedApprovers(solo: DoaOrg) {
  const named = await forTenant(solo.organizationId).$transaction((tx) => doaNamedApprovers(tx, NOW))
  const held = await prisma.positionAssignment.findMany({ where: { organizationId: solo.organizationId, validTo: null }, select: { memberId: true, position: { select: { code: true } } } })
  for (const [code, id] of Object.entries(solo.member)) {
    const expected = named.members.has(id) || held.some((h) => h.memberId === id && named.positions.has(h.position.code))
    expect(await holdsDoaReferencedPosition(solo.organizationId, id, NOW), code).toBe(expected)
  }
}

const FIXTURE = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions.yaml'), 'utf8')

describe('[FR-AUTH-002/AC1] holders of positions a DOA refers to set up two-step sign-in like members with roles', () => {
  it('a DM must set it up; a plain requester and the holder of a position no DOA names are not asked', async () => {
    const solo = await createDoaOrg()
    const position = await prisma.position.create({ data: { organizationId: solo.organizationId, code: 'SITE_LEAD', nameTh: 'หัวหน้าหน้างาน', scope: 'DEPARTMENT' } })
    await prisma.positionAssignment.create({ data: { organizationId: solo.organizationId, positionId: position.id, departmentId: solo.department.CON!, memberId: solo.member.receiver_con!, validFrom: new Date('2026-01-01T00:00:00Z') } })
    expect(await sessionKind(solo, 'dm_it')).toBe('needs-2fa-setup')
    expect(await sessionKind(solo, 'vp_ops')).toBe('needs-2fa-setup')
    expect(await sessionKind(solo, 'req_con')).toBe('member')
    expect(await sessionKind(solo, 'receiver_con')).toBe('member')
    await expectSameAsNamedApprovers(solo)

    // A version awaiting approval names SITE_LEAD, and names asst_con directly: both must set it up from now on
    await prisma.roleAssignment.create({ data: { organizationId: solo.organizationId, memberId: solo.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
    const v2 = `versions:\n${FIXTURE.slice(FIXTURE.indexOf('  - code: DOA-DEMO\n    version: 2'))}`.replace(
      '      - { code: GRV-01, documentType: GR_VARIANCE, priority: 100, when: {}, approver: { kind: POSITION_OF_DEPARTMENT, position: DM }, slaBusinessHours: 8 }',
      '      - { code: GRV-01, documentType: GR_VARIANCE, priority: 100, when: {}, approver: { kind: POSITION_OF_DEPARTMENT, position: SITE_LEAD }, slaBusinessHours: 8 }\n      - { code: GRV-02, documentType: GR_VARIANCE, priority: 200, when: {}, approver: { kind: MEMBER, member: asst_con }, slaBusinessHours: 8 }',
    )
    expect(v2).toContain('GRV-02')
    const imported = await importDoaDraft(solo.ctxOf('admin', NOW), { yaml: v2, changeReason: 'หัวหน้าหน้างานอนุมัติผลต่างการตรวจรับ' }, key())
    if (!imported.ok) throw new Error(JSON.stringify(imported.error))
    // A draft names nobody yet
    expect(await sessionKind(solo, 'receiver_con')).toBe('member')
    await expectSameAsNamedApprovers(solo)
    const submitted = await submitDoaVersion(solo.ctxOf('admin', NOW), { versionId: imported.data.versionIds[0]!, acknowledgedWarnings: ['DOA_LINT_MEMBER_APPROVER:GRV-02'] }, key())
    expect(submitted).toMatchObject({ ok: true })
    expect(await sessionKind(solo, 'receiver_con')).toBe('needs-2fa-setup')
    expect(await sessionKind(solo, 'asst_con')).toBe('needs-2fa-setup')
    expect(await sessionKind(solo, 'req_con')).toBe('member')
    await expectSameAsNamedApprovers(solo)
  })

  it('once the authenticator is set up, the holder works as a member', async () => {
    const solo = await createDoaOrg()
    const member = await prisma.member.findUniqueOrThrow({ where: { id: solo.member.dm_con! } })
    const userId = await upsertUserWithPassword({ email: member.email, name: member.displayNameTh, password: PASSWORD })
    await prisma.member.update({ where: { id: member.id }, data: { userId } })
    expect(await sessionKind(solo, 'dm_con')).toBe('needs-2fa-setup')
    const secret = 'H'.repeat(32)
    await enableTotpWithSecret(userId, secret, [])
    const first = await signIn(member.email)
    const verified = (await auth.api.verifyTOTP({ body: { code: totp(secret) }, headers: new Headers({ cookie: first }), asResponse: true })) as Response
    expect(verified.status).toBe(200)
    const cookie = (verified.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    expect((await resolveSession(new Headers({ cookie }))).kind).toBe('member')
  })
})
