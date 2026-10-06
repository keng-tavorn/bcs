import { describe, expect, it } from 'vitest'
import { renderNotification } from '@/server/notifications/templates'

// BR-SLA-04 "ถ้าไม่มีช่วงถัดไปให้แจ้ง ORG_ADMIN และผู้ขอ" (FR-NOTI-003 AC2, src/server/notifications/templates/sla.ts): when
// nobody could be added to an overdue step, the notice to the administrators says why and only what they can do in this
// build — follow up with the approver, and propose on the authority changes page an acting appointment or a new holder
// of the position (the changes that move an approver's open tasks, BR-DOA-17) — never "move the task", which no command
// does by hand. The requester hears only that the administrators were told. A notice stored before NEW-47 with the
// reason NOT_LAST_STEP still renders. The delegate whose acting period ended with tasks that could not go back (the
// delegator is no longer active) hears that they stay until a new holder of the position is appointed (NEW-28), not that
// an administrator will move them. Nor are the administrators told to move the open tasks of a deactivated member
// (admin.reassign_needed, FR-AUTH-003 AC2): they appoint a new holder of the position on the authority changes page, which
// the notice opens, and the position's open tasks move once the appointment takes effect (BR-DOA-17, NEW-28).

const notice = (data: Record<string, unknown>) => ({ templateKey: 'task.escalated', data: { subjectType: 'REQUEST', subjectId: 'r-1', number: 'PR-2569-00012', title: null, taskId: 't-1', outcome: 'NO_NEXT_BAND', ...data }, subjectType: 'REQUEST', subjectId: 'r-1' })
/** A promise that someone moves a task: "ย้ายงาน…", "…จะย้ายให้…", "move the task", "moves it", "moves them" */
const MOVES_A_TASK = /ย้ายงาน|ย้ายให้|\bmoves? (?:the tasks?|it|them)\b/i

describe('[FR-NOTI-003/AC2] nobody above could be added: the administrators are told why and what they can do, the requester that they were told', () => {
  it('no higher band: follow up, or propose an acting appointment or a new holder of the position on the authority changes page', () => {
    const th = renderNotification(notice({ role: 'ADMIN', reason: 'NO_HIGHER_BAND' }), 'th')
    expect(th).toEqual({
      title: 'PR-2569-00012 เลยกำหนดและไม่มีผู้อนุมัติระดับถัดไปให้ส่งต่อ',
      body: 'โปรดติดตามกับผู้อนุมัติ ถ้าผู้อนุมัติไม่อยู่ เสนอตั้งผู้รักษาการแทนหรือเปลี่ยนผู้ดำรงตำแหน่งได้ที่หน้าเปลี่ยนโครงสร้างอำนาจ',
      href: '/requests/r-1',
    })
    const en = renderNotification(notice({ role: 'ADMIN', reason: 'NO_HIGHER_BAND' }), 'en')
    expect(en).toEqual({
      title: 'PR-2569-00012 is overdue and has no higher approval level to escalate to',
      body: 'Follow up with the approver. If they are away, propose an acting appointment or a new holder of their position on the Authority changes page',
      href: '/requests/r-1',
    })
  })

  it('a vacant next band: appoint the position; the step is not escalated again, so follow up', () => {
    expect(renderNotification(notice({ role: 'ADMIN', reason: 'APPROVER_NOT_FOUND' }), 'en')).toEqual({
      title: 'PR-2569-00012 is overdue, but no one holds the position of the next approval level',
      body: 'Appoint someone to the vacant position on the Authority changes page. This task will not be escalated again, so follow up with the approver',
      href: '/requests/r-1',
    })
  })

  it('no reason, an ambiguous DOA and a stored NOT_LAST_STEP notice render too; none promises to move a task', () => {
    for (const reason of [undefined, 'NO_HIGHER_BAND', 'APPROVER_NOT_FOUND', 'DOA_AMBIGUOUS', 'NOT_LAST_STEP']) {
      for (const locale of ['th', 'en'] as const) {
        const rendered = renderNotification(notice({ role: 'ADMIN', ...(reason ? { reason } : {}) }), locale)
        expect(rendered.title, `${String(reason)} ${locale}`).toContain('PR-2569-00012')
        expect(rendered.body, `${String(reason)} ${locale}`).toBeTruthy()
        expect(`${rendered.title} ${rendered.body}`, `${String(reason)} ${locale}`).not.toMatch(MOVES_A_TASK)
      }
    }
    expect(renderNotification(notice({ role: 'ADMIN', reason: 'NOT_LAST_STEP' }), 'th').title).toBe('PR-2569-00012 เลยกำหนดที่ขั้นที่ยังมีขั้นถัดไป ระบบจึงยังไม่เพิ่มผู้อนุมัติร่วม')
  })

  it('the requester hears only that the administrators were told: nothing to do, nothing promised', () => {
    for (const reason of ['NO_HIGHER_BAND', 'APPROVER_NOT_FOUND']) {
      expect(renderNotification(notice({ role: 'REQUESTER', reason }), 'th')).toEqual({ title: 'PR-2569-00012 เลยกำหนดพิจารณา ผู้ดูแลระบบได้รับแจ้งแล้ว', body: null, href: '/requests/r-1' })
      expect(renderNotification(notice({ role: 'REQUESTER', reason }), 'en')).toEqual({ title: 'PR-2569-00012 is overdue; your administrator has been told', body: null, href: '/requests/r-1' })
    }
  })

  it('the check catches the promises it is for', () => {
    for (const promise of ['งานค้าง 1 งานยังอยู่กับคุณจนกว่าผู้ดูแลระบบจะย้ายให้ผู้อื่น', 'ย้ายงานให้ผู้อื่น', 'until your administrator moves them', 'until your administrator moves it', 'Move the tasks to someone else', 'move the task']) {
      expect(promise).toMatch(MOVES_A_TASK)
    }
  })
})

describe('[FR-DOA-006/AC3] the end of an acting period that could not give its tasks back promises no one will move them', () => {
  it('a delegate keeping tasks after the period ended hears that a new holder of the position takes them, never that someone moves them', () => {
    const ended = (keptTasks: number) => ({ templateKey: 'delegation.window', data: { delegationId: 'd-1', phase: 'ENDED', role: 'DELEGATE', movedTasks: 0, keptTasks }, subjectType: 'DELEGATION', subjectId: 'd-1' })
    expect(renderNotification(ended(1), 'th')).toEqual({
      title: 'สิ้นสุดการรักษาการแทนแล้ว งานค้าง 0 งานกลับไปที่ผู้มอบ',
      body: 'งานค้าง 1 งานยังอยู่กับคุณ จนกว่าจะมีผู้ดำรงตำแหน่งคนใหม่ที่แต่งตั้งผ่านหน้าเปลี่ยนโครงสร้างอำนาจ',
      href: '/tasks',
    })
    expect(renderNotification(ended(2), 'en').body).toBe('2 open tasks stay with you until a new holder of the position is appointed through the Authority changes page')
    for (const kept of [1, 2]) {
      for (const locale of ['th', 'en'] as const) {
        const rendered = renderNotification(ended(kept), locale)
        expect(`${rendered.title} ${rendered.body}`, `${kept} ${locale}`).not.toMatch(MOVES_A_TASK)
      }
    }
  })
})

describe('[FR-AUTH-003/AC2] a deactivated member with open tasks: the administrators are told to appoint a new holder of the position, never to move the tasks', () => {
  // Sent when a member is deactivated (members service) and when an acting period ends with tasks of a delegator who is
  // no longer active (BR-AUTH-06, delegation-window.ts): the same words for both
  const reassign = (openTasks: number) => ({ templateKey: 'admin.reassign_needed', data: { memberId: 'm-1', name: 'ผู้ใช้ dm_con', openTasks }, subjectType: 'MEMBER', subjectId: 'm-1' })

  it('says what moves the tasks — an appointment through the authority changes page, once it takes effect — and opens that page', () => {
    expect(renderNotification(reassign(2), 'th')).toEqual({
      title: 'ผู้ใช้ dm_con ถูกปิดใช้งานและมีงานอนุมัติค้าง 2 งาน',
      body: 'แต่งตั้งผู้ดำรงตำแหน่งคนใหม่ได้ที่หน้าเปลี่ยนโครงสร้างอำนาจ งานค้างของตำแหน่งจะย้ายไปผู้ดำรงคนใหม่เมื่อการแต่งตั้งมีผล',
      href: '/admin/org-authority',
    })
    expect(renderNotification(reassign(2), 'en')).toEqual({
      title: 'ผู้ใช้ dm_con was deactivated with 2 approval tasks open',
      body: 'Appoint a new holder of the position on the Authority changes page; the position’s open tasks move to them when the appointment takes effect',
      href: '/admin/org-authority',
    })
  })

  it('promises no one will move a task, in either language', () => {
    for (const open of [1, 3]) {
      for (const locale of ['th', 'en'] as const) {
        const rendered = renderNotification(reassign(open), locale)
        expect(rendered.body, `${open} ${locale}`).toBeTruthy()
        expect(`${rendered.title} ${rendered.body}`, `${open} ${locale}`).not.toMatch(MOVES_A_TASK)
      }
    }
  })
})
