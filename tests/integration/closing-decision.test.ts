import { randomUUID } from 'node:crypto'
import { createTranslator } from 'next-intl'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it } from 'vitest'
import { taskRight } from '@/app/(workspace)/_tracking/access'
import { askRequester, decideRequestTask } from '@/app/(workspace)/_tracking/commands'
import { memberName } from '@/app/(workspace)/_tracking/present'
import { ClosedTaskText, stepDecisionText } from '@/app/(workspace)/tasks/_parts/closed-task'
import { MS_PER_HOUR } from '@/lib/constants'
import { memberPrincipal } from '@/server/authz'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { getTaskAccess, getTaskView, taskDecision, type TaskViewDto } from '@/server/queries/tasks'
import { decideByActionLink } from '@/server/services/approvals/action-link'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import { decideByLinePostback } from '@/server/services/approvals/line-postback'
import { createDelegation } from '@/server/services/delegations'
import { cancelRequest, createDraft, submitRequest } from '../support/requests'
import { escalateTask, startDelegationWindow } from '@/server/services/sla'
import { emailLinkSecret } from '@/server/tokens/action-tokens'
import { linkRefusal } from '@/ui/approvals/action-link-outcome'
import { formatDateTime } from '@/ui/format'
import en from '../../messages/en.json'
import th from '../../messages/th.json'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// "Who decided it and when" of a task that closed without a decision of its own (spec FR-DOA-004 AC2, §9.3
// "ดำเนินการแล้วโดย … เมื่อ …", BR-SLA-04, ADR-050 item 4): one rule — closingDecisionOf in src/server/queries/tasks.ts,
// decisionOfStep for the services — names the decision of its step on the decision page, in the refusal of a late
// decision, from the LINE button and from the e-mail link (whose page tells only the member signed in as the link's),
// in the reader's language; and only to whoever may act on the task: anybody else is refused before a name is read.
// tasks/_parts/closed-task.tsx words it for the decision pages; tests/e2e/po-view-coassign.spec.ts opens a co-assignee
// task of a PO closed that way on the real page. On the §7.4 fixtures: a request of 10,000 baht goes to the DM of
// CON (PR-01); sent Monday 5 Oct 2026 09:00 Thai time, it escalates Tuesday 16:00 and the VP of OPS joins its step.

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const at = (iso: string) => new Date(iso)
const MON_0900 = at('2026-10-05T02:00:00Z')
const TUE_1600 = at('2026-10-06T09:00:00Z')
const TUE_1630 = at('2026-10-06T09:30:00Z')
const TUE_1640 = at('2026-10-06T09:40:00Z')
const DM_EN = 'Damrong Construction'

let org: DoaOrg
beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: at('2026-01-01T00:00:00Z') } })
  // An English name, so an English reader is told it
  await prisma.member.update({ where: { id: org.member.dm_con! }, data: { displayNameEn: DM_EN } })
})

async function submitted(target: DoaOrg, grossBaht: string) {
  const draft = await createDraft(target.ctxOf('req_con', MON_0900), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุก่อสร้าง', priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] }, key())
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
  const sent = await submitRequest(target.ctxOf('req_con', MON_0900), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.data.requestId } } } })
  return { requestId: draft.data.requestId, task }
}

/**
 * A request escalated at Tuesday 16:00, its co-assignee given a LINE button too (as a linked approver gets one), then
 * approved by the DM at 16:30: the co-assignee's task is cancelled with its link and its button (BR-TOK-01)
 */
async function decidedByTheOther(grossBaht: string) {
  const { requestId, task } = await submitted(org, grossBaht)
  expect(task.assigneeMemberId).toBe(org.member.dm_con)
  const up = await escalateTask(org.organizationId, task.id, TUE_1600)
  if (!up.coAssigneeTaskId) throw new Error(`not escalated: ${JSON.stringify(up)}`)
  const coTaskId = up.coAssigneeTaskId
  const lineToken = await prisma.actionToken.create({ data: { organizationId: org.organizationId, memberId: org.member.vp_ops!, taskId: coTaskId, allowedActions: ['APPROVE'], channel: 'LINE', expiresAt: new Date(TUE_1600.getTime() + 72 * MS_PER_HOUR) } })
  const emailToken = await prisma.actionToken.findFirstOrThrow({ where: { taskId: coTaskId, channel: 'EMAIL' } })
  expect(await decideTask(org.ctxOf('dm_con', TUE_1630), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
  expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: coTaskId } })).toMatchObject({ status: 'CANCELLED', decidedAt: null })
  return { requestId, task, coTaskId, lineToken, link: `${emailToken.id}.${emailLinkSecret(emailToken.id)}` }
}

const tasksEn = createTranslator({ locale: 'en', messages: en, namespace: 'tasks' }) as unknown as Parameters<typeof stepDecisionText>[0]
const tasksTh = createTranslator({ locale: 'th', messages: th, namespace: 'tasks' }) as unknown as Parameters<typeof stepDecisionText>[0]
const closedText = (task: TaskViewDto, locale: 'th' | 'en') => renderToStaticMarkup(createElement(ClosedTaskText, { task, t: locale === 'en' ? tasksEn : tasksTh, locale }))

describe('[FR-DOA-004/AC2] a task closed by the other approver of its step names who decided the step and when, in the reader’s language (BR-SLA-04)', () => {
  it('an English reader opening a co-assignee task cancelled by the other approver’s decision sees the decider’s English name', async () => {
    const { coTaskId } = await decidedByTheOther('10000.00')
    // The co-assignee may look back at it (VIEW): the page reads the task
    const access = await getTaskAccess(org.ctxOf('vp_ops', TUE_1640), coTaskId)
    expect(taskRight(memberPrincipal(org.member.vp_ops!, []), access!)).toBe('VIEW')
    const view = (await getTaskView(org.ctxOf('vp_ops', TUE_1640), coTaskId))!
    expect(view).toMatchObject({ status: 'CANCELLED', cancelledWhy: 'CO_ASSIGNEE_DECIDED', decision: null, decidedBy: null, decidedAt: null })
    expect(view.stepDecision).toEqual({ decision: 'APPROVE', decidedBy: { id: org.member.dm_con, name: { th: 'ผู้ใช้ dm_con', en: DM_EN } }, decidedAt: TUE_1630 })
    expect(memberName('en', view.stepDecision!.decidedBy)).toBe(DM_EN)
    // The words of the decision pages (tasks/_parts/closed-task.tsx), with the real messages of each language
    expect(closedText(view, 'en')).toBe(`<p>This task is closed because another approver of this step decided first</p><p>Approved by ${DM_EN} ${formatDateTime('en', TUE_1630)}</p>`)
    expect(closedText(view, 'th')).toBe(`<p>งานนี้ปิดแล้ว เพราะผู้อนุมัติอีกคนของขั้นนี้ตัดสินก่อน</p><p>อนุมัติแล้วโดย ผู้ใช้ dm_con เมื่อ ${formatDateTime('th', TUE_1630)}</p>`)
  })

  it('deciding it late is refused with the decider’s name in the reader’s language: English for English, Thai for Thai', async () => {
    const { coTaskId } = await decidedByTheOther('10500.00')
    expect(await decideRequestTask(org.ctxOf('vp_ops', TUE_1640), { taskId: coTaskId, decision: 'APPROVE' }, randomUUID(), 'en')).toEqual({
      ok: false,
      code: 'INVALID_STATE_TRANSITION',
      name: DM_EN,
      time: TUE_1630.toISOString(),
    })
    expect(await decideRequestTask(org.ctxOf('vp_ops', TUE_1640), { taskId: coTaskId, decision: 'APPROVE' }, randomUUID(), 'th')).toMatchObject({ code: 'INVALID_STATE_TRANSITION', name: 'ผู้ใช้ dm_con' })
    // The same rule as the service's own answer, which gives both names
    expect(await decideTask(org.ctxOf('vp_ops', TUE_1640), { taskId: coTaskId, decision: 'APPROVE' }, key())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED', name: 'ผู้ใช้ dm_con', nameEn: DM_EN, time: TUE_1630.toISOString() } },
    })
    expect(await taskDecision(org.ctxOf('vp_ops', TUE_1640), coTaskId)).toEqual({ decidedBy: { id: org.member.dm_con, name: { th: 'ผู้ใช้ dm_con', en: DM_EN } }, decidedAt: TUE_1630 })
  })

  it('the co-assignee’s LINE button and e-mail link answer TOKEN_USED with the same decider and time', async () => {
    const { coTaskId, lineToken, link } = await decidedByTheOther('11000.00')
    const named = { name: 'ผู้ใช้ dm_con', nameEn: DM_EN, time: TUE_1630.toISOString() }
    expect(await decideByLinePostback(org.ctxOf('vp_ops', TUE_1640, 'LINE_CHAT'), { tokenId: lineToken.id }, key())).toMatchObject({ ok: false, error: { code: 'TOKEN_USED', details: { taskId: coTaskId, ...named } } })
    expect(await decideByActionLink(org.ctxOf('vp_ops', TUE_1640, 'EMAIL'), { link, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'TOKEN_USED', details: named } })
  })

  it('the e-mail link page tells the member signed in as the link’s who decided, in their language; through the link alone, only when', async () => {
    const { link } = await decidedByTheOther('11500.00')
    const refused = await decideByActionLink(org.ctxOf('vp_ops', TUE_1640, 'EMAIL'), { link, decision: 'APPROVE' }, key())
    if (refused.ok) throw new Error('a closed task was decided from its link')
    // What the page's action (src/app/(auth)/a/[token]/actions.ts) hands the form
    expect(linkRefusal(refused.error, { signedIn: true, locale: 'en' })).toEqual({ ok: false, code: 'TOKEN_USED', name: DM_EN, time: TUE_1630.toISOString() })
    expect(linkRefusal(refused.error, { signedIn: true, locale: 'th' })).toEqual({ ok: false, code: 'TOKEN_USED', name: 'ผู้ใช้ dm_con', time: TUE_1630.toISOString() })
    // email.actionLinksRequireLogin off and no session: whoever holds the link is not told the other approver's name
    expect(linkRefusal(refused.error, { signedIn: false, locale: 'en' })).toEqual({ ok: false, code: 'TOKEN_USED', time: TUE_1630.toISOString() })
  })

  it('a task moved to a delegate names the delegate’s decision; an open task, or one closed with nothing decided, names nobody', async () => {
    const own = await createDoaOrg()
    const { requestId: _moved, task } = await submitted(own, '10000.00')
    // The DM's delegation starts Monday 10:00: the open task moves to the assistant, who approves it at 11:00
    const startsAt = at('2026-10-05T03:00:00Z')
    const created = await createDelegation(own.ctxOf('dm_con', MON_0900), { delegateMemberId: own.member.asst_con!, startsAt: startsAt.toISOString(), endsAt: '2026-10-10T00:00:00+07:00', reason: 'ประชุมต่างจังหวัด' }, key())
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    expect(await startDelegationWindow(own.organizationId, created.data.delegationId, startsAt)).toEqual({ done: true, movedTasks: 1 })
    const moved = await prisma.approvalTask.findFirstOrThrow({ where: { reassignedFromTaskId: task.id } })
    const decidedAt = at('2026-10-05T04:00:00Z')
    expect(await decideTask(own.ctxOf('asst_con', decidedAt), { taskId: moved.id, decision: 'RETURN', reason: 'ขอใบเสนอราคาใหม่' }, key())).toMatchObject({ ok: true })
    const old = (await getTaskView(own.ctxOf('dm_con', decidedAt), task.id))!
    expect(old).toMatchObject({ status: 'REASSIGNED', reassignedTo: { id: own.member.asst_con }, decidedBy: null })
    expect(old.stepDecision).toMatchObject({ decision: 'RETURN', decidedBy: { id: own.member.asst_con }, decidedAt })
    expect(closedText(old, 'th')).toBe(`<p>งานนี้ย้ายไปที่ ผู้ใช้ asst_con แล้ว จึงไม่ต้องตัดสินที่นี่</p><p>ตีกลับให้แก้ไขโดย ผู้ใช้ asst_con เมื่อ ${formatDateTime('th', decidedAt)}</p>`)
    // The task that decided names its own decision in its own fields, not as a decision of another task
    expect(await getTaskView(own.ctxOf('asst_con', decidedAt), moved.id)).toMatchObject({ status: 'RETURNED', decidedBy: { id: own.member.asst_con }, stepDecision: null })

    // Still open: nobody decided; cancelled with its request: nothing on its step was decided either
    const open = await submitted(own, '9000.00')
    expect(await getTaskView(own.ctxOf('dm_con', MON_0900), open.task.id)).toMatchObject({ status: 'OPEN', stepDecision: null })
    expect(await cancelRequest(own.ctxOf('req_con', decidedAt), { requestId: open.requestId, reason: 'ไม่ต้องใช้แล้ว' }, key())).toMatchObject({ ok: true })
    const cancelled = (await getTaskView(own.ctxOf('dm_con', decidedAt), open.task.id))!
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelledWhy: 'REQUEST_CANCELLED', stepDecision: null })
    expect(closedText(cancelled, 'en')).toBe('<p>This task is closed because the requester cancelled the request</p>')
    expect(await taskDecision(own.ctxOf('dm_con', decidedAt), open.task.id)).toEqual({ decidedBy: null, decidedAt: null })
  })
})

describe('[FR-DOA-004/AC2] [BR-AUTH-05] who decided a step is told only to whoever may act on its task', () => {
  it('a member without the task is refused FORBIDDEN — deciding on the web or in LIFF, asking a question — and never told the decider', async () => {
    const { coTaskId } = await decidedByTheOther('12000.00')
    // vp_sup holds no task on this request
    for (const channel of ['WEB', 'LIFF'] as const) {
      const refused = await decideTask(org.ctxOf('vp_sup', TUE_1640, channel), { taskId: coTaskId, decision: 'APPROVE' }, key())
      expect(refused).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(JSON.stringify(refused)).not.toMatch(/dm_con|Damrong|2026-10-06T09:30/)
    }
    expect(await decideRequestTask(org.ctxOf('vp_sup', TUE_1640), { taskId: coTaskId, decision: 'APPROVE' }, randomUUID(), 'en')).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect(await decideRequestTask(org.ctxOf('vp_sup', TUE_1640, 'LIFF'), { taskId: coTaskId, decision: 'REJECT', reason: 'ไม่จำเป็น' }, randomUUID(), 'th')).toEqual({ ok: false, code: 'FORBIDDEN' })
    const asked = await requestInfo(org.ctxOf('vp_sup', TUE_1640), { taskId: coTaskId, question: 'ใครอนุมัติ' }, key())
    expect(asked).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(JSON.stringify(asked)).not.toMatch(/dm_con|Damrong/)
    expect(await askRequester(org.ctxOf('vp_sup', TUE_1640), { taskId: coTaskId, question: 'ใครอนุมัติ' }, randomUUID())).toEqual({ ok: false, code: 'FORBIDDEN' })
    // The decision page does not open for them, so the view that names the decider is never read for them
    const access = await getTaskAccess(org.ctxOf('vp_sup', TUE_1640), coTaskId)
    expect(taskRight(memberPrincipal(org.member.vp_sup!, ['EXECUTIVE']), access!)).toBe('NONE')
    // …while the co-assignee who held it is told who and when
    expect(await decideRequestTask(org.ctxOf('vp_ops', TUE_1640), { taskId: coTaskId, decision: 'APPROVE' }, randomUUID(), 'en')).toMatchObject({ code: 'INVALID_STATE_TRANSITION', name: DM_EN })
  })

  it('the co-assignee’s button or link used by someone else is refused, kept as security.token_misuse, and names nobody', async () => {
    const { coTaskId, lineToken, link } = await decidedByTheOther('12500.00')
    const button = await decideByLinePostback(org.ctxOf('vp_sup', TUE_1640, 'LINE_CHAT'), { tokenId: lineToken.id }, key())
    expect(button).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'the button was sent to someone else' } })
    const email = await decideByActionLink(org.ctxOf('vp_sup', TUE_1640, 'EMAIL'), { link, decision: 'APPROVE' }, key())
    expect(email).toEqual({ ok: false, error: { code: 'TOKEN_INVALID', message: 'the link was sent to someone else' } })
    if (!email.ok) expect(linkRefusal(email.error, { signedIn: true, locale: 'en' })).toEqual({ ok: false, code: 'TOKEN_INVALID' })
    const misuse = await prisma.event.findMany({ where: { type: 'security.token_misuse', data: { path: ['taskId'], equals: coTaskId } }, orderBy: { seq: 'asc' } })
    expect(misuse.map((e) => (e.data as { channel: string; actorMemberId: string }).channel)).toEqual(['LINE', 'EMAIL'])
    expect(misuse.every((e) => (e.data as { actorMemberId: string }).actorMemberId === org.member.vp_sup)).toBe(true)
    // Nothing was decided or used
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: coTaskId } })).toMatchObject({ status: 'CANCELLED', decidedAt: null })
    expect((await prisma.actionToken.findMany({ where: { taskId: coTaskId } })).map((t) => t.usedAt)).toEqual([null, null])
  })
})
