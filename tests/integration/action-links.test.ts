import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { deliverNotification } from '@/server/notifications/deliver'
import { decideTask } from '@/server/services/approvals/decide'
import { decideByActionLink, viewActionLink } from '@/server/services/approvals/action-link'
import { deactivateMember } from '@/server/services/members'
import { createDraft, submitRequest } from '@/server/services/requests'
import { emailLinkPath, emailLinkSecret, hashLinkSecret, parseEmailLink } from '@/server/tokens/action-tokens'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { messagesTo } from '../support/mailpit'
import { p2p } from '../support/p2p'

// S4-06 (spec §4.9 BR-TOK-01 to BR-TOK-04, INV-TOK-01, FR-NOTI-002 AC1 AC2): a task assigned gets an e-mail token whose
// link decides it once; the e-mail goes out with the link; opening the link changes nothing; the decision is a POST by
// the member it was sent to, on the EMAIL channel; tokens die with the task, after 72 hours, and with the member.

const NOW = new Date('2026-10-06T02:00:00Z')
const HOURS_72 = 72 * 3600 * 1000
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
let budgetLineId: string
const emailCtx = (code: string, now = NOW) => makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member[code]! }, channel: 'EMAIL', now })

beforeAll(async () => {
  org = await createDoaOrg()
  budgetLineId = await p2p(org, NOW).fundedLine(5_000_000n)
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
})

/** A submitted request of `net` baht before VAT (with the quotations ATT-QUOTES asks above 100,000), its open task and the task's e-mail token */
async function submitted(net = '10000.00') {
  const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุสำนักงาน', budgetLineId, lines: [{ description: 'กระดาษ', quantity: '1', uom: 'รีม', unitPrice: net }] }, key()))
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
  }
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
  const token = await prisma.actionToken.findFirstOrThrow({ where: { taskId: task.id } })
  return { requestId: draft.requestId, task, token, link: `${token.id}.${emailLinkSecret(token.id)}` }
}

describe('[BR-TOK-01] a token per task and assignee, issued at assignment and revoked when the task closes', () => {
  it('the assignee gets one e-mail token for 72 hours that stores only the hash of its secret', async () => {
    const { task, token } = await submitted()
    expect(await prisma.actionToken.count({ where: { taskId: task.id } })).toBe(1)
    expect(token).toMatchObject({ memberId: task.assigneeMemberId, channel: 'EMAIL', allowedActions: ['APPROVE', 'REJECT'], usedAt: null, revokedAt: null })
    expect(token.expiresAt.getTime() - NOW.getTime()).toBe(HOURS_72)
    // BR-TOK-03: the secret is not stored, its sha256 is
    expect(token.secretHash).toBe(hashLinkSecret(emailLinkSecret(token.id)))
    expect(token.secretHash).not.toContain(emailLinkSecret(token.id))
    expect(parseEmailLink(emailLinkPath(token.id).slice('/a/'.length))).toEqual({ tokenId: token.id, secret: emailLinkSecret(token.id) })
  })

  it('a decision in the workspace revokes the task token at once', async () => {
    const { task, token, link } = await submitted()
    ok(await decideTask(org.ctxOf('dm_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: token.id } })).toMatchObject({ revokedAt: NOW, usedAt: null })
    expect(await decideByActionLink(emailCtx('dm_con'), { link, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } })
  })

  it('deactivating the member revokes their tokens in the same transaction (FR-AUTH-003 AC2)', async () => {
    const { token } = await submitted()
    const unused = await prisma.actionToken.count({ where: { memberId: token.memberId, usedAt: null, revokedAt: null } })
    try {
      const result = ok(await deactivateMember(org.ctxOf('admin', NOW), { memberId: token.memberId, reason: 'ลาออก' }, key()))
      expect(result.revoked).toMatchObject({ actionTokens: unused })
      expect(await prisma.actionToken.count({ where: { memberId: token.memberId, usedAt: null, revokedAt: null } })).toBe(0)
      expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: token.id } })).toMatchObject({ revokedAt: NOW })
    } finally {
      // the DM holds a position the other cases route to
      await prisma.member.update({ where: { id: token.memberId }, data: { status: 'ACTIVE' } })
    }
  })
})

describe('[FR-NOTI-002/AC1] an approval task e-mail carries the decision link', () => {
  it('delivers the task.assigned notification by e-mail with /a/<token> and marks it sent', async () => {
    const { task, token } = await submitted()
    const notification = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.assigned', recipientMemberId: task.assigneeMemberId, data: { path: ['taskId'], equals: task.id } } })
    expect(await deliverNotification(org.organizationId, notification.id, NOW)).toEqual({ status: 'SENT', channel: 'EMAIL' })
    // a second run of the job sends nothing more
    expect(await deliverNotification(org.organizationId, notification.id, NOW)).toMatchObject({ status: 'SKIPPED' })
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } })).toMatchObject({ status: 'SENT', sentChannel: 'EMAIL', sentAt: NOW })
    const assignee = await prisma.member.findUniqueOrThrow({ where: { id: task.assigneeMemberId } })
    const [mail, ...more] = await messagesTo(assignee.email)
    expect(more).toEqual([])
    expect(mail!.Text).toContain(emailLinkPath(token.id))
    expect(mail!.Text).toContain(`/tasks/${task.id}`)
  })
})

describe('[FR-NOTI-002/AC2] opening the link changes nothing; deciding needs the confirming POST', () => {
  it('opening the link (GET) shows the task and changes nothing, however often', async () => {
    const { task, token, link, requestId } = await submitted('12000.00')
    const before = await prisma.event.count({ where: { organizationId: org.organizationId } })
    for (let i = 0; i < 3; i++) {
      expect(ok(await viewActionLink(emailCtx('dm_con'), link))).toMatchObject({ state: 'OPEN', taskId: task.id, subjectType: 'REQUEST', subjectId: requestId, actions: ['APPROVE', 'REJECT'], inWorkspaceOnly: false, amount: '12,840.00' })
    }
    expect(await prisma.event.count({ where: { organizationId: org.organizationId } })).toBe(before)
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: token.id } })).toMatchObject({ usedAt: null })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'OPEN' })
  })

  it('the POST decides once on the EMAIL channel with the DOA reference; the link then says who used it', async () => {
    const { task, token, link } = await submitted()
    const decided = ok(await decideByActionLink(emailCtx('dm_con'), { link, decision: 'APPROVE' }, key()))
    expect(decided).toMatchObject({ taskId: task.id, documentStatus: 'APPROVED' })
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: token.id } })).toMatchObject({ usedAt: NOW, revokedAt: null })
    const event = await prisma.event.findFirstOrThrow({ where: { type: 'approval_task.decided', aggregateId: task.id } })
    expect(event).toMatchObject({ channel: 'EMAIL', doaRuleCode: 'PR-01', actorMemberId: org.member.dm_con })
    expect(await decideByActionLink(emailCtx('dm_con'), { link, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'TOKEN_USED', details: { name: 'ผู้ใช้ dm_con', time: NOW.toISOString() } } })
    expect(ok(await viewActionLink(emailCtx('dm_con'), link))).toMatchObject({ state: 'CLOSED', taskId: task.id })
  })

  it('INV-TOK-01: two POSTs at once decide once', async () => {
    const { link } = await submitted()
    const results = await Promise.all([decideByActionLink(emailCtx('dm_con'), { link, decision: 'APPROVE' }, key()), decideByActionLink(emailCtx('dm_con'), { link, decision: 'APPROVE' }, key())])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^(TOKEN_USED|TOKEN_INVALID)$/) } })
  })

  it('a reason is needed to say no, and a refused POST leaves the link usable', async () => {
    const { token, link, requestId } = await submitted()
    expect(await decideByActionLink(emailCtx('dm_con'), { link, decision: 'REJECT' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'reason' } } })
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: token.id } })).toMatchObject({ usedAt: null })
    ok(await decideByActionLink(emailCtx('dm_con'), { link, decision: 'REJECT', reason: 'ราคาสูงกว่าที่เคยซื้อ' }, key()))
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'REJECTED' })
  })

  it('someone else using the link is refused and kept as security.token_misuse; a forged secret opens nothing', async () => {
    const { token, link } = await submitted()
    expect(await decideByActionLink(emailCtx('vp_ops'), { link, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } })
    expect(await prisma.event.findFirst({ where: { type: 'security.token_misuse', aggregateId: token.id }, select: { data: true } })).toEqual({ data: expect.objectContaining({ tokenId: token.id, channel: 'EMAIL', actorMemberId: org.member.vp_ops }) })
    expect(ok(await viewActionLink(emailCtx('vp_ops'), link))).toEqual({ state: 'NOT_YOURS' })
    const forged = `${token.id}.${'A'.repeat(43)}`
    expect(ok(await viewActionLink(emailCtx('dm_con'), forged))).toEqual({ state: 'TOKEN_INVALID' })
    expect(await decideByActionLink(emailCtx('dm_con'), { link: forged, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } })
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: token.id } })).toMatchObject({ usedAt: null })
  })

  it('after 72 hours the link has expired', async () => {
    const { link } = await submitted()
    const later = new Date(NOW.getTime() + HOURS_72)
    expect(ok(await viewActionLink(emailCtx('dm_con', later), link))).toEqual({ state: 'TOKEN_EXPIRED' })
    expect(await decideByActionLink(emailCtx('dm_con', later), { link, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'TOKEN_EXPIRED' } })
  })

  it('at or above the step-up threshold the link only points to the workspace', async () => {
    const { task, token, link } = await submitted('100000.00')
    expect(task.assigneeMemberId).toBe(org.member.ceo)
    expect(ok(await viewActionLink(emailCtx('ceo'), link))).toMatchObject({ state: 'OPEN', inWorkspaceOnly: true })
    expect(await decideByActionLink(emailCtx('ceo'), { link, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: token.id } })).toMatchObject({ usedAt: null })
  })

  it('a decision through the link must be on the EMAIL channel', async () => {
    const { link } = await submitted()
    expect(await decideByActionLink(org.ctxOf('dm_con', NOW), { link, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'channel' } } })
  })
})
