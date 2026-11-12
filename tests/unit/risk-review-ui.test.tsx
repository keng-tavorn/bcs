import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ReviewDecision, type ReviewDecisionProps } from '@/ui/risk-review/decision'
import { reviewClosed, reviewDueState, reviewFailureKey, slotDomains } from '@/ui/risk-review/model'
import { ReviewTaskList } from '@/ui/risk-review/task-list'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S11-06 (FR-RSK-202 AC3 AC4 · BR-RSK-08): what the reviewer's pages draw from the service's answer — an open task's due
// state as the step badge of §9.10, a refusal in words (who decided first and when, a return without its reason, the
// preparer refused by BR-SOD-16), and the decision panel's states as it first draws: pass and return only (no
// rejection, no PIN), the slot decided with its reason, a task the member may read but not decide. The decision and
// the visibility themselves: tests/integration/risk-review*.test.ts.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }))

function render(node: ReactNode, locale: 'th' | 'en' = 'th') {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )
}

const decide = vi.fn<ReviewDecisionProps['decide']>(async () => ({ ok: true, decision: 'PASS', assessment: 'IN_REVIEW' }))
const base: ReviewDecisionProps = { status: 'OPEN', canDecide: true, blocked: null, number: 'RA-2569-0001', decidedAt: null, myReason: null, decide }

describe('[FR-RSK-202/AC3] the reviewer task model', () => {
  it('says an open task is waiting, half its time used, or overdue at its due time', () => {
    const assigned = new Date('2026-11-02T02:00:00.000Z')
    const due = new Date('2026-11-04T02:00:00.000Z')
    expect(reviewDueState(new Date('2026-11-02T10:00:00.000Z'), assigned, due)).toBe('OPEN')
    expect(reviewDueState(new Date('2026-11-03T02:00:00.000Z'), assigned, due)).toBe('OPEN_HALF')
    expect(reviewDueState(due, assigned, due)).toBe('OVERDUE')
    expect(reviewDueState(new Date('2026-11-05T02:00:00.000Z'), assigned, due)).toBe('OVERDUE')
  })

  it('turns a refusal into the words of its cause, and a task decided first into who and when', () => {
    expect(reviewFailureKey({ ok: false, code: 'INVALID_STATE_TRANSITION', name: 'สมชาย', time: '2026-11-03T03:00:00.000Z' })).toBe('DECIDED_BY')
    expect(reviewFailureKey({ ok: false, code: 'INVALID_STATE_TRANSITION' })).toBe('INVALID_STATE_TRANSITION')
    expect(reviewFailureKey({ ok: false, code: 'VALIDATION_FAILED', field: 'reason' })).toBe('REASON')
    expect(reviewFailureKey({ ok: false, code: 'VALIDATION_FAILED' })).toBe('VALIDATION_FAILED')
    expect(reviewFailureKey({ ok: false, code: 'SOD_VIOLATION' })).toBe('SOD_VIOLATION')
    expect(reviewFailureKey({ ok: false, code: 'SOMETHING_NEW' })).toBe('FAILED')
    expect(reviewClosed({ ok: false, code: 'INVALID_STATE_TRANSITION' })).toBe(true)
    expect(reviewClosed({ ok: true, decision: 'PASS', assessment: 'COMPLETED' })).toBe(false)
    expect(slotDomains([])).toEqual(['GENERAL'])
    expect(slotDomains(['PRIVACY', 'INFOSEC'])).toEqual(['PRIVACY', 'INFOSEC'])
  })

  it('lists a task with its supplier, parts, tier, due state and whom it is held for, linking to the task', () => {
    const html = render(
      <ReviewTaskList
        label="รอตรวจ"
        rows={[
          {
            taskId: 't-1',
            href: '/risk/reviews/t-1',
            title: 'แบบประเมิน RA-2569-0001 · บริษัท ตัวอย่าง จำกัด',
            meta: 'ส่วนที่ตรวจ: ข้อมูลส่วนบุคคล',
            tier: { code: 'HIGH', label: 'ความเสี่ยงสูง' },
            badge: { look: { tone: 'danger', icon: 'AlarmClock' }, label: 'เกินกำหนด · ครบ 4 พ.ย. 2569' },
            when: 'ได้รับงาน 2 พ.ย. 2569',
            onBehalfOf: 'แทนคุณสมหญิง',
          },
        ]}
      />,
    )
    expect(html).toContain('href="/risk/reviews/t-1"')
    expect(html).toContain('ความเสี่ยงสูง')
    expect(html).toContain('data-tier="HIGH"')
    expect(html).toContain('data-icon="AlarmClock"')
    expect(html).toContain('แทนคุณสมหญิง')
  })
})

describe('[FR-RSK-202/AC3] [BR-RSK-08] the reviewer decision panel', () => {
  it('offers pass and return only — no rejection and no PIN — waiting for the page script before either is pressed', () => {
    const html = render(<ReviewDecision {...base} />)
    expect(html).toContain('>ผ่าน<')
    expect(html).toContain('>ตีกลับ<')
    expect(html).not.toContain('ไม่อนุมัติ</button>')
    expect(html).not.toMatch(/PIN|รหัส PIN/)
    expect(html).toContain('data-decision-bar')
    // Before hydration the buttons are disabled: nothing is sent by a press the script has not seen
    expect(html.match(/<button[^>]*disabled=""/g)?.length).toBe(2)
  })

  it('shows a returned slot with when and the reason given, and no buttons', () => {
    const html = render(<ReviewDecision {...base} status="RETURNED" canDecide={false} decidedAt="3 พ.ย. 2569 10:00" myReason="ใบรับรอง ISO 27001 หมดอายุแล้ว" />)
    expect(html).toContain('ตีกลับ')
    expect(html).toContain('ตัดสินเมื่อ 3 พ.ย. 2569 10:00')
    expect(html).toContain('ใบรับรอง ISO 27001 หมดอายุแล้ว')
    expect(html).not.toContain('data-decision-bar')
  })

  it('tells a member who may read the task but not decide it why, in Thai and in English', () => {
    expect(render(<ReviewDecision {...base} canDecide={false} blocked="NOT_DECIDER" />)).toContain('คุณดูงานนี้ได้แต่ตัดสินไม่ได้')
    const english = render(<ReviewDecision {...base} canDecide={false} blocked="NOT_IN_REVIEW" />, 'en')
    expect(english).toContain('no longer waits for its reviewers')
    expect(english).not.toContain('data-decision-bar')
  })

  it('says a cancelled slot was cancelled because another part returned the assessment', () => {
    const html = render(<ReviewDecision {...base} status="CANCELLED" canDecide={false} />, 'en')
    expect(html).toContain('Cancelled')
    expect(html).toContain('another part returned the assessment')
  })
})
