import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { renderNotification } from '@/server/notifications/templates'
import { decideTask } from '@/server/services/approvals/decide'
import { importDoaDraft, submitDoaVersion } from '@/server/services/doa'
import { proposeOrgChange } from '@/server/services/org-authority'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { escalateTask, markTaskOverdue, planTaskSla, remindTaskSla } from '@/server/services/sla'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// The SLA job on the other documents an approval task can be on (spec §4.6, BR-SLA-04, FR-NOTI-003): a purchase order
// climbs the bands of PURCHASE_ORDER (PO-01 COO → PO-02 CEO) and its creator is told as its requester; a DOA version,
// approved under DOA-CHG-01 which has no amount band, has no band above, so the organization admins and its submitter
// are told. Monday 5 Oct 2026, 10:00 Thai time.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const FIXTURE = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions.yaml'), 'utf8')

let org: DoaOrg
beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg()
  for (const admin of ['admin', 'admin2']) await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member[admin]!, role: 'ORG_ADMIN', grantedAt: new Date('2026-01-01T00:00:00Z') } })
})

const told = async (subjectId: string) =>
  (await prisma.notification.findMany({ where: { templateKey: 'task.escalated', subjectId }, orderBy: { dedupeKey: 'asc' } })).map((n) => ({ to: n.recipientMemberId, ...(n.data as { role: string; number: string | null; title: string | null }) }))

describe('[FR-NOTI-003/AC2] a purchase order and a policy change escalate by their own rules (BR-SLA-04)', () => {
  it('a PO of PO-01 gets the CEO of PO-02 as co-assignee; its creator is told; the first decision decides the PO', async () => {
    const flow = p2p(org, NOW)
    const request = await flow.approvedRequest(await flow.fundedLine(500_000n), [{ quantity: '1', unitPrice: '50000.00' }])
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S-SLA', nameTh: 'ผู้ขายทดสอบ', taxId: '0999999000012' } })
    const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์ทดสอบ', address: 'ถนนทดสอบ' } })
    await prisma.request.update({ where: { id: request.id }, data: { deliverySiteId: site.id } })
    const proc = org.ctxOf('proc_officer', NOW)
    ok(await assignSupplier(proc, { requestLineIds: request.lines.map((l) => l.id), supplierId: supplier.id }, key()))
    const run = ok(await consolidateNow(proc, key()))
    const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id } })
    ok(await submitPo(proc, { poId: po.id }, key()))
    const submitted = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'PURCHASE_ORDER', subjectId: po.id } } } })
    expect(task).toMatchObject({ assigneeMemberId: org.member.coo, resolvedFrom: 'POSITION:COO@HQ' })

    const plan = await planTaskSla(org.organizationId, task.id, NOW)
    expect(plan).toMatchObject({ open: true })
    expect(await remindTaskSla(org.organizationId, task.id, new Date(plan.remindAt!))).toEqual({ done: true })
    expect((await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.reminder', subjectId: po.id } })).data).toMatchObject({ subjectType: 'PURCHASE_ORDER', number: submitted.number, taskId: task.id })
    expect(await markTaskOverdue(org.organizationId, task.id, new Date(plan.dueAt!))).toEqual({ done: true, escalateAt: plan.escalateAt })
    // the acknowledgement goes to the CEO, the approver of PO-02
    expect(await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.overdue', subjectId: po.id, recipientMemberId: org.member.ceo } })).toMatchObject({ data: { role: 'ACK' } })

    const escalated = await escalateTask(org.organizationId, task.id, new Date(plan.escalateAt!))
    expect(escalated).toMatchObject({ done: true, outcome: 'CO_ASSIGNED' })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: escalated.coAssigneeTaskId! } })).toMatchObject({ assigneeMemberId: org.member.ceo, resolvedFrom: 'POSITION:CEO@HQ' })
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.escalated', aggregateId: task.id } })).data).toMatchObject({ subjectType: 'PURCHASE_ORDER', doaRuleCode: 'PO-01', nextRuleCode: 'PO-02' })
    expect((await told(po.id)).map((t) => [t.to, t.role, t.number])).toEqual(
      expect.arrayContaining([
        [org.member.ceo, 'CO_ASSIGNEE', submitted.number],
        [org.member.coo, 'ASSIGNEE', submitted.number],
        [org.member.proc_officer, 'REQUESTER', submitted.number],
      ]),
    )
    const requesterNote = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.escalated', subjectId: po.id, recipientMemberId: org.member.proc_officer } })
    expect(renderNotification(requesterNote, 'th').href).toBe(`/procurement/pos/${po.id}`)

    const later = new Date(new Date(plan.escalateAt!).getTime() + 60_000)
    expect(await decideTask(org.ctxOf('ceo', later), { taskId: escalated.coAssigneeTaskId!, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'CANCELLED' })
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).toMatchObject({ status: 'APPROVED' })
  })

  it('a DOA version (DOA-CHG-01, no amount band) has no band above: the admins and its submitter are told', async () => {
    const v2 = FIXTURE.slice(FIXTURE.indexOf('  - code: DOA-DEMO\n    version: 2'))
    const imported = ok(await importDoaDraft(org.ctxOf('admin', NOW), { yaml: `versions:\n${v2.replace('version: 2', 'version: 30')}` }, key()))
    const versionId = imported.versionIds[0]!
    ok(await submitDoaVersion(org.ctxOf('admin', NOW), { versionId }, key()))
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'DOA_VERSION', subjectId: versionId } } } })
    expect(task).toMatchObject({ assigneeMemberId: org.member.ceo })
    const plan = await planTaskSla(org.organizationId, task.id, NOW)
    expect(await markTaskOverdue(org.organizationId, task.id, new Date(plan.dueAt!))).toEqual({ done: true, escalateAt: plan.escalateAt })
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.overdue', aggregateId: task.id } })).data).toMatchObject({ subjectType: 'DOA_VERSION', nextBandMemberId: null })
    expect(await escalateTask(org.organizationId, task.id, new Date(plan.escalateAt!))).toMatchObject({ done: true, outcome: 'NO_NEXT_BAND', coAssigneeTaskId: null })
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.escalated', aggregateId: task.id } })).data).toMatchObject({ subjectType: 'DOA_VERSION', reason: 'NO_HIGHER_BAND', doaRuleCode: 'DOA-CHG-01' })
    // admin submitted it (told as its requester); admin2 as an organization admin
    const notes = await told(versionId)
    expect(notes.map((t) => [t.to, t.role, t.title])).toEqual(
      expect.arrayContaining([
        [org.member.admin, 'REQUESTER', 'DOA-DEMO #30'],
        [org.member.admin2, 'ADMIN', 'DOA-DEMO #30'],
      ]),
    )
    expect(notes).toHaveLength(2)
    const adminNote = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.escalated', subjectId: versionId, recipientMemberId: org.member.admin2 } })
    expect(adminNote.data).toMatchObject({ role: 'ADMIN', outcome: 'NO_NEXT_BAND', reason: 'NO_HIGHER_BAND' })
    expect(renderNotification(adminNote, 'en')).toMatchObject({ title: 'DOA-DEMO #30 is overdue and has no higher approval level to escalate to', href: `/admin/doa/${versionId}` })
  })

  it('an authority change (ORG-CHG-01) is named by its kind in words, never by its code; a variance links to its purchase order', async () => {
    const proposed = ok(
      await proposeOrgChange(
        org.ctxOf('admin', NOW),
        { kind: 'POSITION_ASSIGN', payload: { positionCode: 'VP', departmentId: org.department.SUP!, memberId: org.member.dm_fin! }, effectiveFrom: '2026-10-20T01:00:00Z', reason: 'แต่งตั้งตามคำสั่งบริษัท' },
        key(),
      ),
    )
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'ORG_AUTHORITY_CHANGE', subjectId: proposed.changeId } } } })
    const plan = await planTaskSla(org.organizationId, task.id, NOW)
    expect(await markTaskOverdue(org.organizationId, task.id, new Date(plan.dueAt!))).toMatchObject({ done: true })
    expect(await escalateTask(org.organizationId, task.id, new Date(plan.escalateAt!))).toMatchObject({ done: true, outcome: 'NO_NEXT_BAND' })
    // admin proposed it (told as its requester); admin2 as an organization admin
    const notes = await told(proposed.changeId)
    expect(notes.map((t) => [t.to, t.role])).toEqual(
      expect.arrayContaining([
        [org.member.admin, 'REQUESTER'],
        [org.member.admin2, 'ADMIN'],
      ]),
    )
    const adminNote = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.escalated', subjectId: proposed.changeId, recipientMemberId: org.member.admin2 } })
    expect(adminNote.data).toMatchObject({ subjectType: 'ORG_AUTHORITY_CHANGE', number: null, title: null, changeKind: 'POSITION_ASSIGN', reason: 'NO_HIGHER_BAND' })
    expect(renderNotification(adminNote, 'th')).toMatchObject({ title: 'การเปลี่ยนโครงสร้างอำนาจ (แต่งตั้งผู้ดำรงตำแหน่ง) เลยกำหนดและไม่มีผู้อนุมัติระดับถัดไปให้ส่งต่อ', href: '/admin/org-authority' })
    expect(renderNotification(adminNote, 'en')).toMatchObject({ title: 'Authority change (appointment) is overdue and has no higher approval level to escalate to' })
    const requesterNote = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.escalated', subjectId: proposed.changeId, recipientMemberId: org.member.admin } })
    expect(renderNotification(requesterNote, 'th').title).toBe('การเปลี่ยนโครงสร้างอำนาจ (แต่งตั้งผู้ดำรงตำแหน่ง) เลยกำหนดพิจารณา ผู้ดูแลระบบได้รับแจ้งแล้ว')
    // A variance is settled on its purchase order's page (the notification carries the PO's id)
    const variance = { templateKey: 'task.overdue', data: { subjectType: 'VARIANCE', subjectId: randomUUID(), number: 'PO-2569-00007', title: null, poId: 'po-of-variance', taskId: 't-1', role: 'ACK', willEscalate: false }, subjectType: 'VARIANCE', subjectId: null }
    expect(renderNotification(variance, 'th')).toEqual({ title: 'แจ้งเพื่อทราบ: PO-2569-00007 เลยกำหนดพิจารณาแล้ว', body: null, href: '/procurement/pos/po-of-variance' })
  })
})
