import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Timeline, type TimelineItem } from '@/ui/timeline/timeline'

const items: TimelineItem[] = [
  {
    id: 'a',
    title: 'ส่งขออนุมัติ',
    actor: 'สมชาย ใจดี',
    when: '5 ต.ค. 2569 10:00 น.',
    channel: 'หน้าจอใน LINE',
    state: 'done',
    outcome: 'neutral',
    statusLabel: 'เสร็จแล้ว',
  },
  {
    id: 'b',
    title: 'อนุมัติ',
    actor: 'วีระ ปฏิบัติการ',
    role: 'VP สายปฏิบัติการ',
    when: '5 ต.ค. 2569 11:30 น.',
    channel: 'แชท LINE',
    doaRef: 'DOA-DEMO ฉบับ 1 ข้อ PR-02',
    state: 'done',
    outcome: 'approved',
    statusLabel: 'อนุมัติแล้ว',
  },
  { id: 'c', title: 'ออก PO', actor: 'ฝ่ายจัดซื้อ', waiting: 'รอมา 3 ชั่วโมงทำการ', state: 'current', statusLabel: 'รอดำเนินการ' },
]

describe('[FR-PLT-003/AC3] timeline component', () => {
  const html = renderToStaticMarkup(<Timeline items={items} label="ไทม์ไลน์ของเอกสาร" />)

  it('shows who, what, when, channel and the DOA rule as a stamp', () => {
    for (const text of ['สมชาย ใจดี', 'วีระ ปฏิบัติการ', 'VP สายปฏิบัติการ', '5 ต.ค. 2569 11:30 น. · แชท LINE', 'DOA-DEMO ฉบับ 1 ข้อ PR-02']) {
      expect(html).toContain(text)
    }
  })

  it('marks the current step for assistive technology and never relies on colour alone', () => {
    expect(html).toContain('aria-current="step"')
    expect(html.match(/aria-current="step"/g)).toHaveLength(1)
    for (const label of ['เสร็จแล้ว', 'อนุมัติแล้ว', 'รอดำเนินการ']) expect(html).toContain(label)
    expect(html).toContain('รอมา 3 ชั่วโมงทำการ')
  })

  it('is an ordered list with an accessible name', () => {
    expect(html.startsWith('<ol aria-label="ไทม์ไลน์ของเอกสาร"')).toBe(true)
  })
})
