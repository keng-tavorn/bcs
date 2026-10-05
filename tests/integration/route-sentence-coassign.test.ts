import { randomUUID } from 'node:crypto'
import { createTranslator } from 'next-intl'
import { beforeAll, describe, expect, it } from 'vitest'
import { routeSentence, type TimelineT, type ViewT } from '@/app/(workspace)/_tracking/present'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { getRequestView } from '@/server/queries/requests'
import { getTaskView } from '@/server/queries/tasks'
import { decideTask } from '@/server/services/approvals/decide'
import { createDraft, submitRequest } from '@/server/services/requests'
import { escalateTask } from '@/server/services/sla'
import en from '../../messages/en.json'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// BR-DOA-10 with BR-SLA-04 (NEW-46): "Why this route" names whom the route's rule gave each step — in Thai the record
// kept with the route, in English the sentence built from it (routeSentence, src/app/(workspace)/_tracking/present.ts)
// — no matter who decided the step. When the approver of the band above, added to an escalated step, decides it
// first, the route's step names them as its decider (RouteStepDto.approver), while the English sentence still names
// the approver the rule gave the step, as the Thai one does: its first task (RouteStepDto.ruleApprover,
// src/server/queries/requests.ts routeOf), read in the order the step's tasks were made — by assignedAt, then by id
// when a fixed clock gave two tasks one time. On the §7.4 fixtures: a request of 10,000 baht goes to the DM of CON
// under PR-01; sent Monday 5 Oct 2026 09:00 Thai time, it escalates Tuesday 16:00 and the VP of OPS joins its step.

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const at = (iso: string) => new Date(iso)
const MON_0900 = at('2026-10-05T02:00:00Z')
const TUE_1600 = at('2026-10-06T09:00:00Z')
const TUE_1630 = at('2026-10-06T09:30:00Z')
const DM_EN = 'Damrong Construction'
const VP_EN = 'Varee Operations'

const t = createTranslator({ locale: 'en', messages: en, namespace: 'requestView' }) as unknown as ViewT
const tl = createTranslator({ locale: 'en', messages: en, namespace: 'timeline' }) as unknown as TimelineT

let org: DoaOrg
beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg()
  // English names, so the English sentence reads as an English reader sees it
  await prisma.member.update({ where: { id: org.member.dm_con! }, data: { displayNameEn: DM_EN } })
  await prisma.member.update({ where: { id: org.member.vp_ops! }, data: { displayNameEn: VP_EN } })
  await prisma.position.updateMany({ where: { organizationId: org.organizationId, code: 'DM' }, data: { nameEn: 'Department manager' } })
  await prisma.position.updateMany({ where: { organizationId: org.organizationId, code: 'VP' }, data: { nameEn: 'Vice president' } })
  await prisma.department.update({ where: { id: org.department.CON! }, data: { nameEn: 'Construction' } })
  await prisma.department.update({ where: { id: org.department.OPS! }, data: { nameEn: 'Operations' } })
})

/** A request of `grossBaht` sent by req_con on Monday 09:00 and escalated on Tuesday 16:00: the DM's task and the VP's */
async function escalated(grossBaht: string) {
  const draft = await createDraft(org.ctxOf('req_con', MON_0900), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุก่อสร้าง', priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] }, key())
  if (!draft.ok) throw new Error(`draft failed: ${JSON.stringify(draft.error)}`)
  const sent = await submitRequest(org.ctxOf('req_con', MON_0900), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${JSON.stringify(sent.error)}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.data.requestId } } } })
  expect(task.assigneeMemberId).toBe(org.member.dm_con)
  const up = await escalateTask(org.organizationId, task.id, TUE_1600)
  if (!up.coAssigneeTaskId) throw new Error(`not escalated: ${JSON.stringify(up)}`)
  expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: up.coAssigneeTaskId } })).toMatchObject({ assigneeMemberId: org.member.vp_ops })
  return { requestId: draft.data.requestId, taskId: task.id, coTaskId: up.coAssigneeTaskId }
}

/** The route of the request as its page reads it, and its sentence in each language */
async function routeOfRequest(requestId: string) {
  const view = await getRequestView(org.ctxOf('req_con', TUE_1630), requestId)
  const route = view!.route!
  return { route, en: routeSentence(t, tl, 'en', route, 'REQUEST'), th: routeSentence(t, tl, 'th', route, 'REQUEST') }
}

const SENTENCE = `DOA-DEMO version 1 rule PR-01: a purchase request of 10,000.00 baht (incl. VAT) is in the band up to 20,000.00, goes to ${DM_EN} (Department manager, Construction)`
const RECORD = 'DOA-DEMO ฉบับ 1 ข้อ PR-01: คำขอซื้อยอด 10,000.00 บาท (รวม VAT) อยู่ในช่วงไม่เกิน 20,000.00 → DM ของฝ่ายก่อสร้าง'

describe('[FR-DOA-003/AC2] [FR-INT-008/AC1] an escalated step decided by its co-assignee: the route names the decider, "Why this route" the approver the rule gave it', () => {
  it('the VP who joined decides first: the step names the VP, the English sentence the DM, as the Thai record does', async () => {
    const { requestId, taskId, coTaskId } = await escalated('10000.00')
    expect(await decideTask(org.ctxOf('vp_ops', TUE_1630), { taskId: coTaskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    const { route, en: sentence, th: record } = await routeOfRequest(requestId)
    expect(route.steps).toHaveLength(1)
    expect(route.steps[0]).toMatchObject({
      decision: 'APPROVE',
      escalation: 'CO_ASSIGNED',
      approver: { id: org.member.vp_ops },
      ruleApprover: { approver: { id: org.member.dm_con }, onBehalfOf: null, role: { kind: 'POSITION', positionCode: 'DM' } },
    })
    expect(sentence).toBe(SENTENCE)
    expect(sentence).not.toContain(VP_EN)
    expect(record).toBe(RECORD)
    // The DM's task, closed by the VP's decision, reads the same route
    const closed = await getTaskView(org.ctxOf('dm_con', TUE_1630), taskId)
    expect(closed).toMatchObject({ status: 'CANCELLED', cancelledWhy: 'CO_ASSIGNEE_DECIDED' })
    expect(routeSentence(t, tl, 'en', closed!.route!, 'REQUEST')).toBe(SENTENCE)
  })

  it('while both wait, and once the DM decides first, the sentence names the DM too', async () => {
    const { requestId, taskId } = await escalated('10500.00')
    const waiting = await routeOfRequest(requestId)
    expect(waiting.route.steps[0]!.open?.map((o) => o.approver?.id)).toEqual([org.member.dm_con, org.member.vp_ops])
    expect(waiting.en).toBe(SENTENCE.replace('10,000.00 baht', '10,500.00 baht'))
    expect(await decideTask(org.ctxOf('dm_con', TUE_1630), { taskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: true })
    const decided = await routeOfRequest(requestId)
    expect(decided.route.steps[0]).toMatchObject({ approver: { id: org.member.dm_con }, ruleApprover: { approver: { id: org.member.dm_con } } })
    expect(decided.en).toBe(SENTENCE.replace('10,000.00 baht', '10,500.00 baht'))
  })

  it('the co-assignee’s task carries the same business time as the DM’s (a fixed clock gives both one time): the sentence still names the DM, whose task was made first', async () => {
    const { requestId, taskId, coTaskId } = await escalated('10800.00')
    // Test data: the VP's task gets the DM's assignedAt; the VP's decision then writes the DM's task again (cancelled),
    // after the VP's. Which of two tasks with one assignedAt Postgres returns first depends on its plan (on this
    // database an index of the organization gives them in id order; a scan of the table would give the DM's last,
    // as it was written last): routeOf orders them by id after assignedAt, so the answer never depends on the plan
    const dm = await prisma.approvalTask.findUniqueOrThrow({ where: { id: taskId }, select: { assignedAt: true } })
    await prisma.approvalTask.update({ where: { id: coTaskId }, data: { assignedAt: dm.assignedAt } })
    expect(await decideTask(org.ctxOf('vp_ops', TUE_1630), { taskId: coTaskId, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'APPROVED' } })
    const { route, en: sentence } = await routeOfRequest(requestId)
    expect(route.steps[0]).toMatchObject({ approver: { id: org.member.vp_ops }, ruleApprover: { approver: { id: org.member.dm_con }, onBehalfOf: null } })
    expect(sentence).toBe(SENTENCE.replace('10,000.00 baht', '10,800.00 baht'))
  })
})
