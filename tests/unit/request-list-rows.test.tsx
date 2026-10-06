import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RequestList, type RequestRow } from '@/ui/request-view/request-list'
import th from '../../messages/th.json'

// D-05 / and /requests (§9.9 "เนื้อหา 15 px บนเว็บและ 16 px บนมือถือ"): the rows of "my requests" read at the body's size —
// the title, the lines under it (when the request was sent or made, that the reader follows it), where it is now and
// how long it has waited — as the task rows beside them on the home page do (tests/unit/tasks-inbox-rows.test.tsx). Only
// the column headings, shown on wide screens, are smaller on the web.

const LABELS = {
  list: th.home.myRequests,
  request: th.requestView.columns.request,
  status: th.requestView.columns.status,
  now: th.requestView.columns.now,
  amount: th.requestView.columns.amount,
  unit: th.requestView.amounts.currency,
}

const ROW: RequestRow = {
  id: 'r-1',
  href: '/requests/r-1',
  title: 'PR-2569-00023 · วัสดุซ่อมบำรุง ไซต์งานตัวอย่าง B',
  meta: ['ส่งเมื่อ 6 ต.ค. 2569', 'คุณติดตามคำขอนี้'],
  status: 'PENDING_APPROVAL',
  statusLabel: th.requestView.status.PENDING_APPROVAL,
  now: 'รอ วีระ ปฏิบัติการ ตัดสิน',
  nowStates: [{ kind: 'waiting', text: 'ค้างมา 107.6 ชั่วโมงทำการ' }],
  amount: '20,009.00',
  amountIsMoney: true,
}

describe('[§9.9] [FR-INT-008/AC1] the rows of "my requests" read at the body’s size, on the home page and /requests', () => {
  it('the lines under the title are content at the body’s size, as where the request is and how long it has waited', () => {
    const markup = renderToStaticMarkup(<RequestList rows={[ROW]} labels={LABELS} />)
    expect(markup).toContain('<span class="text-ink-muted">ส่งเมื่อ 6 ต.ค. 2569</span>')
    expect(markup).toContain('<span class="text-ink-muted">คุณติดตามคำขอนี้</span>')
    expect(markup).toContain('<span class="break-words text-ink">รอ วีระ ปฏิบัติการ ตัดสิน</span>')
    expect(markup).toMatch(/<span class="inline-flex items-start gap-1\.5 text-ink"><svg[^>]*>(?:(?!<\/svg>)[\s\S])*<\/svg><span>ค้างมา 107\.6 ชั่วโมงทำการ<\/span><\/span>/)
  })

  it('only the column headings are smaller on the web; the label under a phone’s amount is the phones’ 16 px', () => {
    const markup = renderToStaticMarkup(<RequestList rows={[ROW]} labels={LABELS} />)
    expect(markup.match(/text-sm/g)).toHaveLength(1)
    expect(markup).toMatch(/^<div class="flex flex-col"><div class="hidden border-b border-line pb-2 text-sm text-ink-muted md:grid /)
    expect(markup).toContain(`<span class="text-base text-ink-muted md:hidden" aria-hidden="true">${LABELS.amount}</span>`)
  })
})
