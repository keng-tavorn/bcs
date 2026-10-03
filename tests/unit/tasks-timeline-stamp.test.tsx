import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Timeline, type TimelineItem } from '@/ui/timeline/timeline'

// S2-12 additions to the approval timeline (§9.9 "the one signature element"): a decision is drawn as a stamp whose DOA
// reference links to the version it cites (FR-DOA-005 AC2); returns and rejections carry the reason the approver wrote;
// the current step says who it waits for, how long it has waited and when it is due (FR-INT-008 AC1).

const items: TimelineItem[] = [
  { id: 's', title: 'ส่งขออนุมัติ ได้เลขที่ PR-2569-00012', actor: 'สมชาย ใจดี', when: '5 ต.ค. 2569 10:00 น.', channel: 'เว็บ', state: 'done', outcome: 'neutral', statusLabel: 'เสร็จแล้ว' },
  {
    id: 'r',
    title: 'ตีกลับให้แก้ไข',
    actor: 'วีระ ปฏิบัติการ',
    role: 'รองประธานสายงาน สายปฏิบัติการ',
    when: '5 ต.ค. 2569 11:00 น.',
    channel: 'เว็บ',
    doaRef: 'DOA-DEMO ฉบับ 1 ข้อ PR-02',
    doaHref: '/admin/doa/0199a1b2-0000-7000-8000-000000000001',
    note: 'แยกรายการให้ชัดเจน',
    noteLabel: 'เหตุผล',
    state: 'done',
    outcome: 'returned',
    statusLabel: 'ตีกลับ',
    stamp: true,
  },
  {
    id: 'a',
    title: 'อนุมัติ',
    actor: 'สมหญิง รักงาน',
    role: 'ผู้จัดการฝ่าย ฝ่ายก่อสร้าง',
    onBehalfOf: 'รักษาการแทน ดำรง ก่อสร้างไทย',
    when: '6 ต.ค. 2569 09:15 น.',
    channel: 'LINE (LIFF)',
    doaRef: 'DOA-DEMO ฉบับ 1 ข้อ PR-01',
    doaHref: '/admin/doa/0199a1b2-0000-7000-8000-000000000001',
    state: 'done',
    outcome: 'approved',
    statusLabel: 'อนุมัติแล้ว',
    stamp: true,
  },
  { id: 'c', title: 'รอฝ่ายจัดซื้อออกใบสั่งซื้อ', actor: 'ฝ่ายจัดซื้อ', waiting: 'ค้างมา 3.5 ชั่วโมงทำการ', due: 'เกินกำหนดแล้ว ครบกำหนดเมื่อ 6 ต.ค. 2569 17:30 น.', overdue: true, state: 'current', statusLabel: 'ขั้นปัจจุบัน' },
  { id: 'n', title: 'อนุมัติขั้นที่ 2', actor: 'ประธานเจ้าหน้าที่บริหาร', state: 'upcoming', statusLabel: 'ขั้นถัดไป' },
]

describe('[FR-PLT-003/AC3] [FR-DOA-005/AC2] [FR-INT-008/AC1] the timeline draws decisions as stamps', () => {
  const html = renderToStaticMarkup(<Timeline items={items} label="ไทม์ไลน์ของคำขอ" />)

  it('links the DOA reference of a decision to its version', () => {
    expect(html).toContain('href="/admin/doa/0199a1b2-0000-7000-8000-000000000001"')
    expect(html.match(/<a href="\/admin\/doa\//g)).toHaveLength(2)
    expect(html).toContain('DOA-DEMO ฉบับ 1 ข้อ PR-02')
  })

  it('shows who decided, their position, when, through which channel and for whom', () => {
    for (const text of ['วีระ ปฏิบัติการ', 'รองประธานสายงาน สายปฏิบัติการ', '5 ต.ค. 2569 11:00 น. · เว็บ', 'รักษาการแทน ดำรง ก่อสร้างไทย', '6 ต.ค. 2569 09:15 น. · LINE (LIFF)']) expect(html).toContain(text)
  })

  it('quotes the reason of a return under its label, and never relies on colour alone', () => {
    expect(html).toContain('<blockquote')
    expect(html).toContain('เหตุผล')
    expect(html).toContain('แยกรายการให้ชัดเจน')
    for (const label of ['ตีกลับ', 'อนุมัติแล้ว', 'ขั้นปัจจุบัน', 'ขั้นถัดไป']) expect(html).toContain(label)
  })

  it('marks one current step with who it waits for, the business hours waited and that it is overdue', () => {
    expect(html.match(/aria-current="step"/g)).toHaveLength(1)
    expect(html).toContain('ค้างมา 3.5 ชั่วโมงทำการ')
    expect(html).toContain('เกินกำหนดแล้ว ครบกำหนดเมื่อ 6 ต.ค. 2569 17:30 น.')
    expect(html).toMatch(/text-danger[^>]*>เกินกำหนดแล้ว/)
  })
})
