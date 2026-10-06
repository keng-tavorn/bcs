import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { getRequestView } from '@/server/queries/requests'
import { listMyTasks } from '@/server/queries/tasks'
import { provideInfo, requestInfo } from '@/server/services/approvals/decide'
import { createDelegation } from '@/server/services/delegations'
import { createDraft, submitRequest } from '@/server/services/requests'
import { startDelegationWindow } from '@/server/services/sla'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// D-05 /tasks (§9.9 principles 1 and 4): the approver's inbox lists the tasks they can decide first, the ones due first
// at the top; the tasks waiting for the requester's answer (INFO_REQUESTED) come after them, the question asked first at
// the top — their SLA has stopped (BR-SLA-03), so their due time gives them no place — and each says how long its question
// has waited for the answer, the wait the request page shows for its ANSWER step. Cut at a limit (home shows five), a
// question never pushes a task to decide off the list. Listing changes nothing: the due time, the time left and the time
// the approver used stay as the commands left them. Real Postgres (BCS_TEST_DB), an organization of its own per test, so
// no task of another test is in the inbox. Business hours Mon–Fri 08:30–17:30, Thai time.

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
/** A Thai wall-clock time on a day of October 2026 */
const thai = (day: number, time: string) => new Date(`2026-10-${String(day).padStart(2, '0')}T${time}:00+07:00`)

async function submitted(org: DoaOrg, requester: string, grossBaht: string, when: Date, title: string) {
  const draft = await createDraft(
    org.ctxOf(requester, when),
    { requestTypeCode: 'BUY_GOODS', title, priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] },
    key(),
  )
  if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`)
  const sent = await submitRequest(org.ctxOf(requester, when), { requestId: draft.data.requestId }, key())
  if (!sent.ok) throw new Error(`submit failed: ${sent.error.code}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'REQUEST', subjectId: draft.data.requestId } } } })
  return { requestId: draft.data.requestId, taskId: task.id }
}

async function ask(org: DoaOrg, approver: string, taskId: string, when: Date) {
  const asked = await requestInfo(org.ctxOf(approver, when), { taskId, question: 'ขอใบเสนอราคาเพิ่มอีก 1 ใบ' }, key())
  if (!asked.ok) throw new Error(`ask failed: ${asked.error.code}`)
  return asked.data.infoRequestId
}

/** What the SLA keeps on a task */
const slaOf = (ids: string[]) =>
  prisma.approvalTask.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, dueAt: true, remainingBusinessMinutes: true, version: true }, orderBy: { id: 'asc' } })

describe('[FR-DOA-004/AC1] [FR-INT-008/AC1] [FR-INT-009/AC3] the inbox lists the tasks to decide first, then those waiting for the requester’s answer', () => {
  it('puts every question after the tasks to decide, the one asked first at the top, with how long it has waited for the answer', async () => {
    const org = await createDoaOrg()
    // Four requests of 45,000 baht for vp_ops (rule PR-02, 8 business hours each), due Tuesday 09:00, 09:30, 10:00, 10:30
    const a = await submitted(org, 'req_con', '45000.00', thai(5, '10:00'), 'ปูน ก')
    const b = await submitted(org, 'req_con', '45000.00', thai(5, '10:30'), 'ปูน ข')
    const c = await submitted(org, 'req_con', '45000.00', thai(5, '11:00'), 'ปูน ค')
    const d = await submitted(org, 'req_con', '45000.00', thai(5, '11:30'), 'ปูน ง')
    // vp_ops asks about c at 13:00 and about a at 14:00: a is due first, but it waits for the requester now
    await ask(org, 'vp_ops', c.taskId, thai(5, '13:00'))
    await ask(org, 'vp_ops', a.taskId, thai(5, '14:00'))
    const kept = await slaOf([a.taskId, c.taskId])

    const now = thai(6, '10:00')
    const inbox = await listMyTasks(org.ctxOf('vp_ops', now))
    expect(inbox.total).toBe(4)
    expect(inbox.items.map((i) => [i.id, i.status])).toEqual([
      [b.taskId, 'OPEN'],
      [d.taskId, 'OPEN'],
      [c.taskId, 'INFO_REQUESTED'],
      [a.taskId, 'INFO_REQUESTED'],
    ])
    // To decide: the time each has waited for the approver and its due time, no question
    expect(inbox.items[0]).toMatchObject({ waitingMinutes: 510, dueAt: thai(6, '09:30'), overdue: true, question: null })
    expect(inbox.items[1]).toMatchObject({ waitingMinutes: 450, dueAt: thai(6, '10:30'), overdue: false, question: null })
    // Waiting for an answer: asked Monday 13:00, 270 business minutes on Monday and 90 on Tuesday; asked 14:00, 210 and 90.
    // The time the approver used before asking stays as it was, 120 and 240 minutes, and a paused task is never overdue
    expect(inbox.items[2]).toMatchObject({ question: { askedAt: thai(5, '13:00'), waitingMinutes: 360 }, waitingMinutes: 120, overdue: false })
    expect(inbox.items[3]).toMatchObject({ question: { askedAt: thai(5, '14:00'), waitingMinutes: 300 }, waitingMinutes: 240, overdue: false })
    // The wait the request page shows for the same question (its ANSWER step)
    for (const [request, minutes] of [
      [c, 360],
      [a, 300],
    ] as const) {
      expect((await getRequestView(org.ctxOf('req_con', now), request.requestId))!.stage).toMatchObject({ kind: 'ANSWER', waitingMinutes: minutes })
    }

    // Cut at a limit, the questions go first: they never push a task to decide off the home page
    expect(await listMyTasks(org.ctxOf('vp_ops', now), { limit: 2 })).toMatchObject({ total: 4, items: [{ id: b.taskId }, { id: d.taskId }] })
    expect((await listMyTasks(org.ctxOf('vp_ops', now), { limit: 3 })).items.map((i) => i.id)).toEqual([b.taskId, d.taskId, c.taskId])
    // Listing changed nothing of the SLA the question stopped
    expect(await slaOf([a.taskId, c.taskId])).toEqual(kept)

    // Answered, a waits for a decision again with the 240 minutes it had left (GC-SLA-06): due Tuesday 14:00, it comes
    // back among the tasks to decide, before the question still open
    const question = await prisma.infoRequest.findFirstOrThrow({ where: { taskId: a.taskId, answeredAt: null } })
    expect(await provideInfo(org.ctxOf('req_con', now), { infoRequestId: question.id, answer: 'แนบใบเสนอราคาแล้ว' }, key())).toMatchObject({ ok: true })
    const answered = await listMyTasks(org.ctxOf('vp_ops', now))
    expect(answered.items.map((i) => i.id)).toEqual([b.taskId, d.taskId, a.taskId, c.taskId])
    expect(answered.items[2]).toMatchObject({ status: 'OPEN', dueAt: thai(6, '14:00'), question: null })
  })
})

describe('[FR-DOA-006/AC3] [FR-INT-008/AC1] a question that moved with its task keeps the time it was asked', () => {
  it('counts the wait from the question, not from the move, in the delegate’s inbox and in the delegator’s', async () => {
    const org = await createDoaOrg()
    // dm_con decides req_con's requests up to 20,000 baht (rule PR-01) and asks about one on Monday 26 October at 10:00
    const plain = await submitted(org, 'req_con', '5000.00', thai(26, '09:00'), 'กระดาษ')
    const asking = await submitted(org, 'req_con', '6000.00', thai(26, '09:00'), 'หมึกพิมพ์')
    await ask(org, 'dm_con', asking.taskId, thai(26, '10:00'))
    // From Tuesday dm_con is away: both tasks move to asst_con, who acts for dm_con, and the question goes with its task
    const delegation = await createDelegation(
      org.ctxOf('dm_con', thai(26, '09:00')),
      { delegateMemberId: org.member.asst_con!, startsAt: '2026-10-27T00:00:00+07:00', endsAt: '2026-10-29T00:00:00+07:00', reason: 'ลาพักร้อน' },
      key(),
    )
    if (!delegation.ok) throw new Error(`delegation failed: ${delegation.error.code}`)
    expect(await startDelegationWindow(org.organizationId, delegation.data.delegationId, thai(27, '00:00'))).toEqual({ done: true, movedTasks: 2 })

    // Asked Monday 10:00: 450 business minutes on Monday and 90 on Tuesday — not the 90 since the move at midnight
    const now = thai(27, '10:00')
    for (const [member, holding] of [
      ['asst_con', 'FOR'],
      ['dm_con', 'BY'],
    ] as const) {
      const inbox = await listMyTasks(org.ctxOf(member, now))
      expect(inbox.items.map((i) => [i.subjectId, i.status, i.holding?.kind])).toEqual([
        [plain.requestId, 'OPEN', holding],
        [asking.requestId, 'INFO_REQUESTED', holding],
      ])
      expect(inbox.items[1]).toMatchObject({ question: { askedAt: thai(26, '10:00'), waitingMinutes: 540 } })
    }
    expect((await getRequestView(org.ctxOf('req_con', now), asking.requestId))!.stage).toMatchObject({ kind: 'ANSWER', waitingMinutes: 540 })
  })
})
