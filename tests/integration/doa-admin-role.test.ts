import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { draftDoaCopy, getDoaEditor, type DoaEditorView, type DraftCopyInput } from '@/server/services/doa/editor'
import { grantRole, revokeRole } from '@/server/services/members/roles'
import { createDraft, submitRequest } from '../support/requests'
import { draftWorkflowVersion } from '@/server/services/workflow'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S6-09 (FR-ADM-101 · BR-WF-16 · BR-WF-17 · OQ-109): the role DOA_ADMIN against Postgres, through the services the pages
// call. It drafts the DOA and the workflow but decides nothing; ORG_ADMIN gives it to others, never to themselves, and
// every AUDITOR hears of it at once. A DOA version in effect that separates the DOA administrators takes the DOA and the
// workflow from ORG_ADMIN, and from then on nobody holds both roles; the lint refuses a separating version without an
// active DOA_ADMIN or with someone holding both. On the §7.4 fixture: `admin` is the ORG_ADMIN, `admin2` becomes the
// DOA_ADMIN, `auditor` the AUDITOR.

const NOW = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let v1: string
beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW },
      { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: NOW },
    ],
  })
  v1 = (await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })).id
})

const as = (code: string) => org.ctxOf(code, NOW)
async function editor(code: string): Promise<DoaEditorView> {
  return ok(await getDoaEditor(as(code), v1))
}
/** The editor's table as loaded, with the policy changed by `policy` */
function inputOf(view: DoaEditorView, policy: Partial<DraftCopyInput['policy']> = {}): DraftCopyInput {
  return {
    sourceVersionId: view.source.id,
    effectiveDate: view.defaultEffectiveDate,
    changeReason: 'แยกผู้ดูแลผังอำนาจ',
    policy: { ...view.policy, ...policy },
    rules: view.rules.map((r) => ({ code: r.code, documentType: r.documentType, band: r.band ? { ...r.band } : null, steps: r.steps.map((s) => ({ approver: { ...s.approver }, slaMinutes: s.slaMinutes })) })),
  }
}
const auditorNotices = (change: string) =>
  prisma.notification.findMany({ where: { organizationId: org.organizationId, templateKey: 'audit.policy_changed', data: { path: ['change'], equals: change } }, select: { recipientMemberId: true, data: true } })

describe('[FR-ADM-101/AC1] DOA_ADMIN drafts the DOA and the workflow, and approves nothing', () => {
  it('given by ORG_ADMIN, the DOA_ADMIN opens the editor, saves a DOA draft and a workflow draft', async () => {
    ok(await grantRole(as('admin'), { memberId: org.member.admin2!, role: 'DOA_ADMIN' }, key()))
    const view = await editor('admin2')
    expect(ok(await draftDoaCopy(as('admin2'), inputOf(view), key()))).toMatchObject({ versionNo: 2 })
    ok(await draftWorkflowVersion(as('admin2'), { code: 'WF-ADM' }, key()))
  })

  it('a DOA_ADMIN who is not the assignee cannot decide an approval task (BR-AUTH-02)', async () => {
    const draft = ok(await createDraft(as('req_con'), { requestTypeCode: 'BUY_GOODS', title: 'สว่านไฟฟ้า', lines: [{ description: 'สว่านไฟฟ้า', quantity: '1', uom: 'เครื่อง', unitPrice: '4500.00' }] }, key()))
    ok(await submitRequest(as('req_con'), { requestId: draft.requestId }, key()))
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
    expect(task.assigneeMemberId).not.toBe(org.member.admin2)
    expect(await decideTask(as('admin2'), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'OPEN' })
  })
})

describe('[FR-ADM-101/AC2] ORG_ADMIN gives DOA_ADMIN to others only, and every AUDITOR is told', () => {
  it('an ORG_ADMIN giving DOA_ADMIN to themselves is refused SOD_VIOLATION, kept as a security event', async () => {
    expect(await grantRole(as('admin'), { memberId: org.member.admin!, role: 'DOA_ADMIN' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { reason: 'SELF_GRANT' } } })
    expect(await prisma.roleAssignment.count({ where: { memberId: org.member.admin!, role: 'DOA_ADMIN' } })).toBe(0)
    expect(await prisma.event.findFirst({ where: { organizationId: org.organizationId, type: 'security.sod_blocked', aggregateId: org.member.admin! } })).toMatchObject({ data: { rule: 'BR-WF-16', action: 'member.grant_role' } })
  })

  it('giving and taking DOA_ADMIN are events, and the AUDITOR hears of each at once', async () => {
    expect(await prisma.event.findFirst({ where: { type: 'member.role_granted', aggregateId: org.member.admin2! } })).toMatchObject({ data: { role: 'DOA_ADMIN' } })
    expect(await auditorNotices('DOA_ADMIN_GRANTED')).toEqual([expect.objectContaining({ recipientMemberId: org.member.auditor, data: expect.objectContaining({ memberId: org.member.admin2 }) })])
    ok(await revokeRole(as('admin'), { memberId: org.member.admin2!, role: 'DOA_ADMIN' }, key()))
    expect(await prisma.event.findFirst({ where: { type: 'member.role_revoked', aggregateId: org.member.admin2! } })).toMatchObject({ data: { role: 'DOA_ADMIN' } })
    expect((await auditorNotices('DOA_ADMIN_REVOKED')).map((n) => n.recipientMemberId)).toEqual([org.member.auditor])
    // Another role tells nobody
    ok(await grantRole(as('admin'), { memberId: org.member.admin2!, role: 'FINANCE' }, key()))
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, templateKey: 'audit.policy_changed' } })).toBe(2)
  })
})

describe('[FR-ADM-101/AC3] a DOA version in effect that separates the DOA administrators', () => {
  it('the lint refuses a separating version without an active DOA_ADMIN, or with someone holding both roles (OQ-109)', async () => {
    const view = await editor('admin')
    expect(await draftDoaCopy(as('admin'), inputOf(view, { doaAdminSeparated: true }), key())).toMatchObject({ ok: false, error: { code: 'DOA_LINT_FAILED', details: { errors: [{ code: 'DOA_LINT_NO_DOA_ADMIN' }] } } })
    ok(await grantRole(as('admin'), { memberId: org.member.admin2!, role: 'DOA_ADMIN' }, key()))
    // Not separated yet: one member may still hold both, but a separating version cannot be drafted while they do
    ok(await grantRole(as('admin'), { memberId: org.member.admin2!, role: 'ORG_ADMIN' }, key()))
    expect(await draftDoaCopy(as('admin'), inputOf(view, { doaAdminSeparated: true }), key())).toMatchObject({ ok: false, error: { code: 'DOA_LINT_FAILED', details: { errors: [{ code: 'DOA_LINT_ADMIN_ROLES_COMBINED' }] } } })
    ok(await revokeRole(as('admin'), { memberId: org.member.admin2!, role: 'ORG_ADMIN' }, key()))
    const saved = ok(await draftDoaCopy(as('admin'), inputOf(view, { doaAdminSeparated: true }), key()))
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: saved.versionId } })).toMatchObject({ sodPolicy: { doaAdminSeparated: true } })
  })

  it('in effect, ORG_ADMIN is refused admin.doa.* and admin.workflow.*; the DOA_ADMIN keeps them', async () => {
    // The fixture's version in effect separates them, as a version approved under DOA_CHANGE would
    await prisma.doaVersion.update({ where: { id: v1 }, data: { sodPolicy: { approverMayReceive: false, requesterMayReceive: true, doaAdminSeparated: true } } })
    const view = await editor('admin2')
    const separated = { ok: false, error: { code: 'FORBIDDEN', details: { reason: 'DOA_ADMIN_SEPARATED' } } }
    expect(await getDoaEditor(as('admin'), v1)).toMatchObject(separated)
    expect(await draftDoaCopy(as('admin'), inputOf(view), key())).toMatchObject(separated)
    expect(await draftWorkflowVersion(as('admin'), { code: 'WF-ADM' }, key())).toMatchObject(separated)
    ok(await draftWorkflowVersion(as('admin2'), { code: 'WF-ADM' }, key()))
    // ORG_ADMIN keeps the rest of its rights
    ok(await grantRole(as('admin'), { memberId: org.member.dm_it!, role: 'RECEIVER' }, key()))
  })

  it('from then on nobody holds both roles, and the last DOA_ADMIN stays', async () => {
    expect(await grantRole(as('admin'), { memberId: org.member.admin2!, role: 'ORG_ADMIN' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { reason: 'ADMIN_ROLES_COMBINED' } } })
    expect(await grantRole(as('admin'), { memberId: org.member.admin!, role: 'DOA_ADMIN' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { reason: 'SELF_GRANT' } } })
    expect(await revokeRole(as('admin'), { memberId: org.member.admin2!, role: 'DOA_ADMIN' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'LAST_DOA_ADMIN' } } })
    expect(await prisma.roleAssignment.count({ where: { memberId: org.member.admin2!, revokedAt: null, role: { in: ['ORG_ADMIN', 'DOA_ADMIN'] } } })).toBe(1)
  })
})
