import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { createNotifications } from '@/server/notifications/create'
import { decideTask } from '@/server/services/approvals/decide'
import { activateDoaVersion, importDoaDraft, publishApprovedDoaVersion, submitDoaVersion } from '@/server/services/doa'
import { listMyNotifications, markNotificationsRead } from '@/server/services/notifications'
import { createDraft, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// FR-NOTI-001: every notification is in the bell with a link to its document and can be marked read; a dedupeKey keeps
// a retried job from notifying twice; a member sees only their own notifications.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
})

async function submitted(grossBaht: string) {
  const draft = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ปูนซีเมนต์', priceIncludesVat: true, lines: [{ description: 'ปูน', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] }, key())
  if (!draft.ok) throw new Error('draft failed')
  const sent = await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error('submit failed')
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.data.requestId } } } })
  return { requestId: draft.data.requestId, number: sent.data.number, taskId: task.id }
}

describe('[FR-NOTI-001/AC1] every notification is in the bell with a link to its document and can be marked read', () => {
  it('shows the new task to the approver in Thai and English with a link to the task, and marks it read', async () => {
    const { number, taskId, requestId } = await submitted('45000.00')
    const th = await listMyNotifications(org.ctxOf('vp_ops', NOW), 'th')
    const item = th.items.find((i) => i.href === `/tasks/${taskId}`)
    expect(item).toMatchObject({ title: `มีงานรออนุมัติ: ${number}`, unread: true })
    expect(th.unread).toBeGreaterThanOrEqual(1)
    const en = await listMyNotifications(org.ctxOf('vp_ops', NOW), 'en')
    expect(en.items.find((i) => i.id === item!.id)).toMatchObject({ title: `Waiting for your approval: ${number}` })

    expect(await markNotificationsRead(org.ctxOf('vp_ops', NOW), { notificationIds: [item!.id] }, key())).toMatchObject({ ok: true, data: { marked: 1 } })
    expect((await listMyNotifications(org.ctxOf('vp_ops', NOW), 'th')).items.find((i) => i.id === item!.id)).toMatchObject({ unread: false })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'notification.read', aggregateId: org.member.vp_ops } })).toBe(1)

    // The requester hears back with a link to the request; "mark all read" clears the bell
    await decideTask(org.ctxOf('vp_ops', NOW), { taskId, decision: 'RETURN', reason: 'แนบใบเสนอราคาเพิ่ม' }, key())
    const mine = await listMyNotifications(org.ctxOf('req_con', NOW), 'th')
    expect(mine.items[0]).toMatchObject({ title: `คำขอ ${number} ถูกตีกลับให้แก้ไข`, href: `/requests/${requestId}`, unread: true })
    expect(await markNotificationsRead(org.ctxOf('req_con', NOW), { all: true }, key())).toMatchObject({ ok: true })
    expect((await listMyNotifications(org.ctxOf('req_con', NOW), 'th')).unread).toBe(0)
    expect(await markNotificationsRead(org.ctxOf('req_con', NOW), { all: true }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

describe('[FR-NOTI-001/AC2] the dedupeKey keeps a retried job from notifying twice', () => {
  it('a second notification with the same key is skipped, also from another transaction', async () => {
    const draft = { recipientMemberId: org.member.dm_it!, templateKey: 'task.assigned', data: { label: 'X' }, urgency: 'IMMEDIATE' as const, dedupeKey: `test:${randomUUID()}` }
    const first = await forTenant(org.organizationId).$transaction((tx) => createNotifications(tx, org.organizationId, [draft]))
    const second = await forTenant(org.organizationId).$transaction((tx) => createNotifications(tx, org.organizationId, [draft, draft]))
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
    expect(await prisma.notification.count({ where: { organizationId: org.organizationId, dedupeKey: draft.dedupeKey } })).toBe(1)
  })

  it('the job doa-version-activate run twice for the same version tells each admin once', async () => {
    const solo = await createDoaOrg()
    await prisma.roleAssignment.create({ data: { organizationId: solo.organizationId, memberId: solo.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
    const fixture = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions.yaml'), 'utf8')
    const yaml = `versions:\n${fixture.slice(fixture.indexOf('  - code: DOA-DEMO\n    version: 2'))}`
    const imported = await importDoaDraft(solo.ctxOf('admin', NOW), { yaml }, key())
    if (!imported.ok) throw new Error('import failed')
    const versionId = imported.data.versionIds[0]!
    await submitDoaVersion(solo.ctxOf('admin', NOW), { versionId, boundaryTableConfirmed: true }, key())
    const approver = makeCtx({ organizationId: solo.organizationId, actor: { type: 'USER', memberId: solo.member.ceo! }, channel: 'WEB', now: new Date('2026-10-06T03:00:00Z') })
    await forTenant(solo.organizationId).$transaction((tx) => publishApprovedDoaVersion(tx, approver, versionId, solo.member.ceo!))
    const at = new Date('2026-10-31T17:00:00Z')
    expect(await activateDoaVersion(solo.organizationId, versionId, at)).toMatchObject({ ok: true })
    expect(await activateDoaVersion(solo.organizationId, versionId, at)).toMatchObject({ ok: true })
    expect(await prisma.notification.count({ where: { organizationId: solo.organizationId, recipientMemberId: solo.member.admin, templateKey: 'doa.authority_changed' } })).toBe(1)
  })
})

describe('[FR-NOTI-001/AC3] a member sees and marks only their own notifications', () => {
  it('another member neither sees nor marks the approver’s notification', async () => {
    const { taskId } = await submitted('46000.00')
    const theirs = (await listMyNotifications(org.ctxOf('vp_ops', NOW), 'th')).items.find((i) => i.href === `/tasks/${taskId}`)!
    expect((await listMyNotifications(org.ctxOf('req_con', NOW), 'th')).items.some((i) => i.id === theirs.id)).toBe(false)
    expect(await markNotificationsRead(org.ctxOf('req_con', NOW), { notificationIds: [theirs.id] }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt).toBeNull()
  })
})
