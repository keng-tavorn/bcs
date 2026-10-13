import { createTranslator, NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ViewT } from '@/app/(workspace)/_tracking/present'
import { taskRows, type TasksT } from '@/app/(workspace)/_tracking/rows'
import type { InboxTaskDto } from '@/server/queries/tasks'
import { Notice } from '@/ui/form/notice'
import { DecisionPanel, type DecisionKind } from '@/ui/tasks/decision-panel'
import type { ActionOutcome } from '@/ui/tasks/outcome'
import { TaskList } from '@/ui/tasks/task-list'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// D-05 /tasks and /tasks/[id] (§9.9): an inbox row of a task waiting for the requester's answer says so and how long the
// question has waited (the query's order and its count of the wait: tests/integration/tasks-inbox-order.test.ts); the
// number of tasks reads "1 task" and "2 tasks" in English on /tasks and /liff/tasks, and so do the counts of a policy
// decision; who asked is content at the body's size on the web, like the title and the states; and the return-or-reject
// form names its choice once on screen, under its heading, while the group of choices keeps its name for screen readers.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined }) }))

type Locale = 'th' | 'en'
const MESSAGES = { th, en } as const
const tasksT = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: 'tasks' }) as unknown as TasksT
const viewT = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: 'requestView' }) as unknown as ViewT

const ASKED_AT = new Date('2026-10-05T06:00:00Z')

function task(over: Partial<InboxTaskDto> = {}): InboxTaskDto {
  return {
    id: 't-1',
    status: 'OPEN',
    subjectType: 'REQUEST',
    subjectId: 'r-1',
    subject: {
      kind: 'REQUEST',
      requestId: 'r-1',
      number: 'PR-2569-00012',
      title: 'ปูนซีเมนต์',
      requester: { id: 'm-req', name: { th: 'สมชาย ใจดี', en: 'Somchai Jaidee' } },
      department: { id: 'd-con', code: 'CON', name: { th: 'ฝ่ายก่อสร้าง', en: 'Construction' }, isRoot: false },
      grossSatang: 4_500_000n,
      netSatang: 4_205_607n,
    },
    assignedAt: new Date('2026-10-05T03:00:00Z'),
    // Tuesday 6 October 09:00, Thai time
    dueAt: new Date('2026-10-06T02:00:00Z'),
    waitingMinutes: 90,
    overdue: false,
    holding: null,
    stepUp: false,
    review: false,
    amountSatang: 4_205_607n,
    question: null,
    ...over,
  }
}

/** A task waiting for the requester's answer: the approver used 180 minutes, then asked; the question has waited `minutes` */
const asking = (minutes: number | null) => task({ id: 't-2', status: 'INFO_REQUESTED', waitingMinutes: 180, question: { askedAt: ASKED_AT, waitingMinutes: minutes } })

describe('[FR-INT-008/AC1] [FR-DOA-004/AC1] an inbox row says what the task waits for, and for how long (§9.9 principle 4)', () => {
  it('a task to decide: how long it has waited for the approver and when it is due', () => {
    const [row] = taskRows(tasksT('th'), viewT('th'), 'th', [task()])
    expect(row!.states).toEqual([
      { kind: 'waiting', text: 'ค้างมา 1.5 ชั่วโมงทำการ' },
      { kind: 'due', text: 'ครบกำหนด 6 ต.ค. 2569 09:00 น.' },
    ])
  })

  it.each([
    ['th', 'รอผู้ขอตอบคำถาม', 'ค้างมา 6 ชั่วโมงทำการ'],
    ['en', 'Waiting for the requester’s answer', 'Waiting 6 business hours'],
  ] as const)('a task waiting for the requester’s answer says so and how long the question has waited — no due time while its SLA has stopped (%s)', (locale, question, waited) => {
    const [row] = taskRows(tasksT(locale), viewT(locale), locale, [asking(360)])
    expect(row!.states).toEqual([
      { kind: 'question', text: question },
      { kind: 'waiting', text: waited },
    ])
  })

  it('a question asked a moment ago says so; without a business calendar only that it waits for the answer', () => {
    expect(taskRows(tasksT('th'), viewT('th'), 'th', [asking(0)])[0]!.states.map((s) => s.text)).toEqual(['รอผู้ขอตอบคำถาม', 'ค้างมาไม่ถึง 1 นาทีในเวลาทำการ'])
    expect(taskRows(tasksT('th'), viewT('th'), 'th', [asking(null)])[0]!.states).toEqual([{ kind: 'question', text: 'รอผู้ขอตอบคำถาม' }])
  })
})

describe('[FR-PLT-002/AC2] the number of tasks in the reader’s language (/tasks and /liff/tasks)', () => {
  it('says one task and two tasks in English, and งาน in Thai whatever the number', () => {
    const tEn = tasksT('en')
    const tTh = tasksT('th')
    expect([0, 1, 2, 12].map((count) => tEn('count', { count }))).toEqual(['0 tasks', '1 task', '2 tasks', '12 tasks'])
    expect([1, 2].map((count) => tTh('count', { count }))).toEqual(['1 งาน', '2 งาน'])
  })

  it('so do the counts of a policy decision (/tasks/[id]): rules, open tasks and SLA times', () => {
    const tEn = tasksT('en')
    expect([1, 9].map((count) => tEn('policy.doaRuleCount', { count }))).toEqual(['1 rule', '9 rules'])
    expect([1, 3].map((count) => tEn('policy.doaOpenTasks', { count }))).toEqual([
      '1 open task under the current version keeps its route to the end',
      '3 open tasks under the current version keep their route to the end',
    ])
    expect([1, 2].map((count) => tEn('policy.facts.openTasksCount', { count }))).toEqual(['1 task', '2 tasks'])
    expect([1, 8].map((hours) => tEn('policy.doaSla', { hours }))).toEqual(['1 business hour', '8 business hours'])
    expect([1, 90].map((minutes) => tEn('policy.doaSlaMinutes', { minutes }))).toEqual(['1 business minute', '90 business minutes'])
    expect(tasksT('th')('policy.doaSla', { hours: 8 })).toBe('8 ชั่วโมงทำการ')
  })
})

describe('[§9.9] [FR-DOA-004/AC1] the rows of the inbox and home read at the body’s size', () => {
  it('who asked or who sent it is content at the body’s size, as the title and the states; only the label under the amount is smaller on the web', () => {
    const markup = renderToStaticMarkup(
      <TaskList
        label="งานรออนุมัติของคุณ"
        rows={[{ id: 't-1', href: '/tasks/t-1', title: 'PO-2569-00014 · บริษัท วัสดุก่อสร้างทดสอบ จำกัด', meta: 'ส่งขออนุมัติโดย พิมพ์ใจ จัดหา', amount: '57,780.00', amountLabel: 'ยอดรวม VAT', amountUnit: 'บาท', states: [], tags: [] }]}
      />,
    )
    expect(markup).toContain('<span class="text-ink-muted">ส่งขออนุมัติโดย พิมพ์ใจ จัดหา</span>')
    expect(markup).toContain('<span class="text-base text-ink-muted md:text-sm">ยอดรวม VAT</span>')
  })
})

const html = (node: ReactNode, locale: Locale = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

/** An action that never answers: only the first render is looked at */
const never = () => new Promise<ActionOutcome>(() => undefined)
const panel = (kind: DecisionKind, locale: Locale = 'th') =>
  html(<DecisionPanel taskId="00000000-0000-4000-8000-000000000001" open label="PR-2569-00001" amount="45,000.00" locale={locale} kind={kind} actions={{ decide: never }} />, locale)

describe('[FR-DOA-004/AC1] [§9.9] the return-or-reject form names its choice once on screen', () => {
  it.each(['th', 'en'] as const)('the heading says it; the group of choices keeps its name for screen readers only (%s)', (locale) => {
    const decide = MESSAGES[locale].tasks.decide
    for (const [kind, title] of [
      ['REQUEST', decide.otherTitle],
      ['PURCHASE_ORDER', decide.po.otherTitle],
    ] as const) {
      const markup = panel(kind, locale)
      expect(markup, kind).toMatch(new RegExp(`<h3 [^>]*>${title}</h3>`))
      expect(markup, kind).toMatch(new RegExp(`<fieldset [^>]*><legend class="sr-only">${decide.choice}</legend><label`))
    }
    // A variance is rejected or approved: no choice, no group
    expect(panel('VARIANCE', locale)).not.toContain('<fieldset')
  })
})

describe('[NFR-A11Y-03] [§9.9] a task not approved is stated in danger’s colour, as its timeline draws it, and read politely', () => {
  it('the workspace notice reads a state the page shows in danger’s colour as a status; an error just made stays an alert', () => {
    const rejected = renderToStaticMarkup(<Notice tone="danger" role="status">ไม่อนุมัติโดย วีระ ปฏิบัติการ</Notice>)
    expect(rejected).toMatch(/^<div role="status" class="[^"]*border-danger[^"]*"><svg[^>]*class="[^"]*text-danger[^"]*"[^>]*aria-hidden="true"/)
    expect(rejected).toContain('ไม่อนุมัติโดย วีระ ปฏิบัติการ')
    expect(renderToStaticMarkup(<Notice tone="danger">บันทึกไม่สำเร็จ</Notice>)).toMatch(/^<div role="alert" class="[^"]*border-danger/)
    for (const tone of ['info', 'success', 'warning'] as const) expect(renderToStaticMarkup(<Notice tone={tone}>x</Notice>), tone).toMatch(/^<div role="status"/)
  })
})
