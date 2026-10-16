import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { deliverNotification } from '@/server/notifications/deliver'
import { decideTask } from '@/server/services/approvals/decide'
import { decideByActionLink, viewActionLink } from '@/server/services/approvals/action-link'
import { decideByLinePostback } from '@/server/services/approvals/line-postback'
import { deactivateMember } from '@/server/services/members'
import { cancelRequest, createDraft, submitRequest } from '../support/requests'
import { escalateTask } from '@/server/services/sla'
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
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]

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
    // …and the link then says who decided it and when (FR-DOA-004 AC2, below), deciding nothing
    expect(await decideByActionLink(emailCtx('dm_con'), { link, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'TOKEN_USED' } })
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: token.id } })).toMatchObject({ revokedAt: NOW, usedAt: null })
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
    // Both lock the task first: the second finds it decided by the first
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: 'TOKEN_USED', details: { name: 'ผู้ใช้ dm_con', time: NOW.toISOString() } } })
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

describe('[FR-DOA-004/AC2] a link whose task was decided elsewhere says who decided it and when, as the LINE button does (§9.3, ADR-050 item 4)', () => {
  const LATER = new Date(NOW.getTime() + 30 * 60_000)
  /** Thursday 8 Oct 2026 09:00 Thai time: past the escalation time of a task assigned at NOW, before its links expire */
  const THU_0900 = new Date('2026-10-08T02:00:00Z')

  it('decided on the web, in LIFF or from the chat: the link answers TOKEN_USED with the decider and the time, not TOKEN_INVALID', async () => {
    const decide = {
      WEB: (taskId: string) => decideTask(org.ctxOf('dm_con', NOW, 'WEB'), { taskId, decision: 'APPROVE' }, key()),
      LIFF: (taskId: string) => decideTask(org.ctxOf('dm_con', NOW, 'LIFF'), { taskId, decision: 'APPROVE' }, key()),
      // The approve button of the LINE card: a LINE token, as an approver linked to LINE gets one with the task
      LINE_CHAT: async (taskId: string) => {
        const button = await prisma.actionToken.create({ data: { organizationId: org.organizationId, memberId: org.member.dm_con!, taskId, allowedActions: ['APPROVE'], channel: 'LINE', expiresAt: new Date(NOW.getTime() + HOURS_72) } })
        return decideByLinePostback(org.ctxOf('dm_con', NOW, 'LINE_CHAT'), { tokenId: button.id }, key())
      },
    }
    for (const channel of ['WEB', 'LIFF', 'LINE_CHAT'] as const) {
      const { task, token, link } = await submitted()
      ok(await decide[channel](task.id))
      expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'APPROVED', channel })
      expect(await decideByActionLink(emailCtx('dm_con', LATER), { link, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'TOKEN_USED', details: { name: 'ผู้ใช้ dm_con', nameEn: 'ผู้ใช้ dm_con', time: NOW.toISOString() } } })
      // Nothing more was decided and the link was not used
      expect(await prisma.event.count({ where: { type: 'approval_task.decided', aggregateId: task.id } })).toBe(1)
      expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: token.id } })).toMatchObject({ usedAt: null, revokedAt: NOW })
    }
  })

  it('rejected in the workspace: the link names that decision too, also when it has expired since', async () => {
    const { task, link } = await submitted()
    ok(await decideTask(org.ctxOf('dm_con', NOW), { taskId: task.id, decision: 'REJECT', reason: 'ราคาสูงกว่าที่เคยซื้อ' }, key()))
    const expired = new Date(NOW.getTime() + HOURS_72)
    expect(await decideByActionLink(emailCtx('dm_con', expired), { link, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'TOKEN_USED', details: { name: 'ผู้ใช้ dm_con', time: NOW.toISOString() } } })
  })

  it('the co-assignee’s link, once the first approver decided the escalated step, names the first approver (BR-SLA-04)', async () => {
    const { task } = await submitted()
    const escalated = await escalateTask(org.organizationId, task.id, THU_0900)
    expect(escalated).toMatchObject({ done: true, outcome: 'CO_ASSIGNED' })
    const coToken = await prisma.actionToken.findFirstOrThrow({ where: { taskId: escalated.coAssigneeTaskId!, channel: 'EMAIL' } })
    const decidedAt = new Date(THU_0900.getTime() + 5 * 60_000)
    ok(await decideTask(org.ctxOf('dm_con', decidedAt), { taskId: task.id, decision: 'APPROVE' }, key()))
    const coLink = `${coToken.id}.${emailLinkSecret(coToken.id)}`
    const late = new Date(THU_0900.getTime() + 10 * 60_000)
    expect(await decideByActionLink(emailCtx(codeOf(coToken.memberId), late), { link: coLink, decision: 'APPROVE' }, key())).toMatchObject({
      ok: false,
      error: { code: 'TOKEN_USED', details: { name: 'ผู้ใช้ dm_con', time: decidedAt.toISOString() } },
    })
    expect(await prisma.event.count({ where: { type: 'approval_task.decided', aggregateId: escalated.coAssigneeTaskId! } })).toBe(0)
  })

  it('a link whose request was cancelled, with nothing decided, still answers TOKEN_INVALID', async () => {
    const { requestId, link } = await submitted()
    ok(await cancelRequest(org.ctxOf('req_con', NOW), { requestId, reason: 'ไม่ต้องใช้แล้ว' }, key()))
    const refused = await decideByActionLink(emailCtx('dm_con', LATER), { link, decision: 'APPROVE' }, key())
    expect(refused).toEqual({ ok: false, error: { code: 'TOKEN_INVALID', message: 'the link was revoked' } })
  })
})
