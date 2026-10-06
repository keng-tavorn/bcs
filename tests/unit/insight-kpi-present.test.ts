import { createTranslator } from 'next-intl'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { cappedSentence, dayText, detailSentence, kpiGoals, kpiItemViews, listTitle, type KpiT, type TimelineT } from '@/app/(workspace)/kpi/_present'
import type { KpiResult } from '@/server/services/reports/kpi'
import type { KpiBaseline, KpiDetailDto, KpiItemDto } from '@/server/services/reports/screens'
import { KpiTable, type KpiMeasureView } from '@/ui/insight/kpi-table'
import th from '../../messages/th.json'

// S5-12 · FR-VIS-003 AC2 (spec §11.4): the executive's KPI page shows each measure's current value next to the Phase 0
// baseline, as "{value} (วัดเมื่อ {date})", and "ยังไม่ได้บันทึก" while none is recorded — never a number of its own. Where
// the baseline is kept and who records it wait for the user (NEW-36), so kpiBaseline() gives none today: this checks the
// page's side with a baseline handed to it. The page itself runs in tests/e2e/kpi.spec.ts at 375 and 1440 px.

const t = createTranslator({ locale: 'th', messages: th, namespace: 'kpi' }) as unknown as KpiT
const tl = createTranslator({ locale: 'th', messages: th, namespace: 'timeline' }) as unknown as TimelineT
const QUERY = '?from=2026-08-06&to=2026-10-04'

const kpi: KpiResult = {
  from: '2026-08-05T17:00:00.000Z',
  to: '2026-10-04T17:00:00.000Z',
  g1: { numerator: 4, denominator: null },
  g2: { misrouted: 0, checked: 5, withDoaReference: { numerator: 5, denominator: 5 } },
  g3: { submitToPoMedianMinutes: null, decisionMedianMinutes: 90, pastDue: { numerator: 0, denominator: 0 } },
  g4: { tasksOnFailedBudgetCheck: 0 },
  g5: { total: { numerator: 3, denominator: 5 }, bySubject: { PURCHASE_REQUEST: { numerator: 2, denominator: 3 } } },
}

const baseline: KpiBaseline = {
  measuredOn: '2026-06-30',
  values: { g5: { kind: 'ratio', numerator: 1, denominator: 4 }, g3b: { kind: 'minutes', minutes: 600 }, g4: { kind: 'count', count: 2 }, g2b: { kind: 'ratio', numerator: 0, denominator: 0 } },
  g5ByKind: { PURCHASE_REQUEST: { kind: 'ratio', numerator: 1, denominator: 10 } },
}

const measures = (b: KpiBaseline | null): KpiMeasureView[] => kpiGoals(t, 'th', kpi, b, QUERY).flatMap((g) => g.measures)
const find = (list: readonly KpiMeasureView[], id: string) => list.find((m) => m.id === id)!

describe('[FR-VIS-003/AC2] the KPI page shows each current value next to the Phase 0 baseline once one is recorded', () => {
  it('a recorded baseline reads "{value} (วัดเมื่อ {date})" beside the value of the period, in the unit of its measure', () => {
    const list = measures(baseline)
    const on = dayText('th', '2026-06-30')
    expect(find(list, 'g5')).toMatchObject({ value: '60.0%', detail: '3 จาก 5 การตัดสิน', baseline: `25.0% (วัดเมื่อ ${on})` })
    expect(find(list, 'g3b')).toMatchObject({ value: '1.5 ชั่วโมงทำการ', baseline: `10.0 ชั่วโมงทำการ (วัดเมื่อ ${on})` })
    expect(find(list, 'g4')).toMatchObject({ value: '0 รายการ', baseline: `2 รายการ (วัดเมื่อ ${on})` })
    // G-5 of purchase requests compares with its own baseline, not the total's
    expect(find(list, `/kpi/g5${QUERY}&kind=PURCHASE_REQUEST`)).toMatchObject({ value: '66.7%', baseline: `10.0% (วัดเมื่อ ${on})` })
    // a measure the baseline left out, or a share of nothing, is not given a number
    expect(find(list, 'g1')).toMatchObject({ baseline: 'ยังไม่ได้บันทึก' })
    expect(find(list, 'g2b')).toMatchObject({ value: '100.0%', baseline: 'ยังไม่ได้บันทึก' })
  })

  it('with no baseline recorded every measure says so, next to its current value and the proposed target', () => {
    const list = measures(null)
    expect(list.length).toBeGreaterThanOrEqual(9)
    for (const m of list) {
      expect(m.baseline, m.name).toBe('ยังไม่ได้บันทึก')
      expect(m.value, m.name).not.toBe('')
      expect(m.target, m.name).not.toBe('')
    }
    expect(find(list, 'g5')).toMatchObject({ target: 'อย่างน้อย 60%' })
  })

  it('every number opens its list, a count of 0 too; only the words of a share of nothing or a time with no data are not links', () => {
    const list = measures(null)
    expect(find(list, 'g5').href).toBe(`/kpi/g5${QUERY}`)
    expect(find(list, 'g3b').href).toBe(`/kpi/g3b${QUERY}`)
    expect(find(list, 'g1')).toMatchObject({ value: '4 รายการ', href: `/kpi/g1${QUERY}` })
    // G-3 past due of no tasks assigned: no share, words rather than a number, and nothing to list
    expect(find(list, 'g3c')).toMatchObject({ value: 'ยังไม่มีข้อมูลในช่วงนี้', href: null, detail: null })
    expect(find(list, 'g3a')).toMatchObject({ value: 'ยังไม่มีข้อมูลในช่วงนี้', href: null })
    // nothing counted: "0 รายการ" is a number like the others and opens its list, which says none is in the period
    expect(find(list, 'g4')).toMatchObject({ value: '0 รายการ', href: `/kpi/g4${QUERY}`, linkLabel: 'ดูรายการที่นับ: คำขอเกินงบที่หลุดถึงผู้อนุมัติ 0 รายการ' })
    const none = kpiGoals(t, 'th', { ...kpi, g1: { numerator: 0, denominator: null } }, null, QUERY).flatMap((g) => g.measures)
    expect(find(none, 'g1')).toMatchObject({ value: '0 รายการ', href: `/kpi/g1${QUERY}` })
    // so no count on the page is plain text beside the links
    for (const m of list.filter((x) => /^\d+ รายการ$/.test(x.value))) expect(m.href, m.name).not.toBeNull()
  })

  it('G-3 (c) "1 จาก 37 ขั้น" opens every step it divides by: its 37 a list of its own beside the past-due steps the value opens', () => {
    const late = kpiGoals(t, 'th', { ...kpi, g3: { ...kpi.g3, pastDue: { numerator: 1, denominator: 37 } } }, null, QUERY).flatMap((g) => g.measures)
    expect(find(late, 'g3c')).toMatchObject({
      value: '2.7%',
      detail: '1 จาก 37 ขั้น',
      // the value: the steps past due
      href: `/kpi/g3c${QUERY}`,
      linkLabel: 'ดูรายการที่นับ: ขั้นที่เกินกำหนด (SLA) 2.7% (1 จาก 37 ขั้น)',
      // "1 จาก 37 ขั้น": all 37 steps assigned in the same period, named with the words it shows (WCAG 2.5.3)
      detailLink: { href: `/kpi/g3c-steps${QUERY}`, label: 'ดูทุกขั้นที่มอบในช่วงนี้: ขั้นที่เกินกำหนด (SLA) 1 จาก 37 ขั้น' },
    })
    // no step assigned: words with no number, and nothing to open
    expect(find(measures(null), 'g3c')).toMatchObject({ detail: null, detailLink: null })
    // the other details are words, or numbers the value's own list already opens (G-2 and G-5 list what they count and not)
    for (const m of late.filter((x) => x.id !== 'g3c')) expect(m.detailLink, m.name).toBeNull()
  })

  it('G-2 (a) "0 รายการ" opens the decisions it checked again with the DOA engine, and its list even when none was checked', () => {
    // §9.9 every number opens its list: none misrouted, but 5 decisions stand behind the 0
    expect(find(measures(null), 'g2a')).toMatchObject({
      value: '0 รายการ',
      detail: 'ตรวจแล้ว 5 การตัดสิน',
      href: `/kpi/g2a${QUERY}`,
      linkLabel: 'ดูรายการที่นับ: การอนุมัติที่ผิด DOA 0 รายการ (ตรวจแล้ว 5 การตัดสิน)',
    })
    const unchecked = kpiGoals(t, 'th', { ...kpi, g2: { misrouted: 0, checked: 0, withDoaReference: { numerator: 0, denominator: 0 } } }, null, QUERY).flatMap((g) => g.measures)
    expect(find(unchecked, 'g2a')).toMatchObject({ value: '0 รายการ', detail: 'ตรวจแล้ว 0 การตัดสิน', href: `/kpi/g2a${QUERY}` })
  })
})

describe('[FR-VIS-003/AC2] the list behind G-2 (a) holds every decision checked, each marked counted or not', () => {
  const decision = (n: number, mark: KpiItemDto['mark']): KpiItemDto => ({
    key: `task-${n}`,
    document: { type: 'REQUEST', id: `request-${n}`, label: `PR-2569-0000${n} โต๊ะประชุม`, poId: null },
    person: { nameTh: 'วีระ ปฏิบัติการ', nameEn: 'Weera Operations' },
    onBehalfOf: null,
    channel: 'LINE_CHAT',
    decision: 'APPROVE',
    at: '2026-10-05T03:00:00.000Z',
    dueAt: null,
    minutes: null,
    doaRef: null,
    mark,
  })
  const rights = { requests: true, purchaseOrders: false, doaVersions: false, orgAuthorityChanges: false }

  it('says how many of the decisions checked it counts, and marks each one with an icon kind and words, like G-2 (b) and G-5', () => {
    const d: KpiDetailDto = { measure: 'g2a', kind: null, period: { from: '2026-10-05', to: '2026-10-05' }, items: [decision(1, 'MISROUTED'), decision(2, 'DOA_MATCHED')], total: 2, counted: 1 }
    expect(detailSentence(t, d)).toBe('นับ 1 จาก 2 รายการ')
    expect(detailSentence(t, { ...d, items: [decision(2, 'DOA_MATCHED')], total: 1, counted: 0 })).toBe('นับ 0 จาก 1 รายการ')
    const views = kpiItemViews(t, tl, 'th', 'g2a', d.items, rights)
    expect(views.map((v) => v.mark)).toEqual([
      { kind: 'overdue', text: 'นับ: ผู้ตัดสินไม่ใช่คนที่ DOA กำหนด' },
      { kind: 'done', text: 'ไม่นับ: ผู้ตัดสินตรงกับคนที่ DOA กำหนด' },
    ])
    expect(views[1]).toMatchObject({ title: 'คำขอ PR-2569-00002 โต๊ะประชุม', href: '/requests/request-2' })
    expect(views[1]!.lines[0]).toBe('อนุมัติโดย วีระ ปฏิบัติการ')
  })

  it('a list cut short says which decisions it kept: for G-2 (a) the misrouted ones first, for the other lists the newest', () => {
    const cut: KpiDetailDto = { measure: 'g2a', kind: null, period: { from: '2026-08-08', to: '2026-10-06' }, items: [decision(1, 'MISROUTED'), decision(2, 'DOA_MATCHED')], total: 250, counted: 1 }
    expect(cappedSentence(t, cut)).toBe('แสดง 2 จากทั้งหมด 250 รายการ รายการที่นับขึ้นก่อน ตามด้วยรายการล่าสุด')
    expect(cappedSentence(t, { ...cut, measure: 'g2b' })).toBe('แสดง 2 รายการล่าสุดจากทั้งหมด 250 รายการ')
    expect(cappedSentence(t, { ...cut, total: 2 })).toBeNull()
  })
})

describe('[FR-VIS-003/AC2] the list behind "1 จาก 37 ขั้น" of G-3 (c) holds every step assigned, each marked counted or not and why', () => {
  const step = (n: number, mark: KpiItemDto['mark'], over: Partial<KpiItemDto> = {}): KpiItemDto => ({
    key: `task-${n}`,
    document: { type: 'REQUEST', id: `request-${n}`, label: `PR-2569-0000${n} โต๊ะประชุม`, poId: null },
    person: { nameTh: 'วีระ ปฏิบัติการ', nameEn: 'Weera Operations' },
    onBehalfOf: null,
    channel: null,
    decision: null,
    at: '2026-10-05T03:00:00.000Z',
    dueAt: '2026-10-05T09:00:00.000Z',
    minutes: 120,
    doaRef: null,
    mark,
    ...over,
  })
  const rights = { requests: true, purchaseOrders: false, doaVersions: false, orgAuthorityChanges: false }

  it('heads the list as the steps assigned in the period, and says how many of them are counted', () => {
    expect(listTitle(t, 'g3c-steps', null)).toEqual({
      name: 'ขั้นที่มอบในช่วงนี้',
      formula: 'ทุกขั้นอนุมัติที่มอบในช่วงนี้ ซึ่งเป็นตัวหารของขั้นที่เกินกำหนด (SLA) ขั้นที่ตัดสินหลังครบกำหนด หรือยังเปิดอยู่และเลยกำหนดแล้ว นับและขึ้นก่อน แต่ละขั้นบอกว่านับหรือไม่นับเพราะอะไร',
    })
    // the measures' own lists keep their names, G-5 of one kind of document too
    expect(listTitle(t, 'g3c', null).name).toBe('ขั้นที่เกินกำหนด (SLA)')
    expect(listTitle(t, 'g5', 'PURCHASE_REQUEST').name).toBe('การตัดสินใน LINE ของคำขอซื้อ')
    expect(listTitle(t, 'g4', 'PURCHASE_REQUEST').name).toBe('คำขอเกินงบที่หลุดถึงผู้อนุมัติ')
    const d: KpiDetailDto = { measure: 'g3c-steps', kind: null, period: { from: '2026-08-08', to: '2026-10-06' }, items: [step(1, 'PAST_DUE_DECIDED'), step(2, 'DECIDED_ON_TIME')], total: 37, counted: 1 }
    expect(detailSentence(t, d)).toBe('นับ 1 จาก 37 รายการ')
    // the steps past due come first when the list is cut short, as G-2 (a) puts its misrouted decisions first
    expect(cappedSentence(t, d)).toBe('แสดง 2 จากทั้งหมด 37 รายการ รายการที่นับขึ้นก่อน ตามด้วยรายการล่าสุด')
    // the list of the value itself counts the steps past due only
    expect(detailSentence(t, { ...d, measure: 'g3c', total: 1 })).toBe('1 รายการ')
  })

  it('marks every step counted or not with an icon kind and the reason in words', () => {
    const views = kpiItemViews(
      t,
      tl,
      'th',
      'g3c-steps',
      [
        step(1, 'PAST_DUE_DECIDED', { minutes: 600 }),
        step(2, 'PAST_DUE_OPEN', { minutes: null }),
        step(3, 'DECIDED_ON_TIME'),
        step(4, 'OPEN_NOT_DUE', { minutes: null }),
        step(5, 'NO_DUE_TIME', { dueAt: null }),
        step(6, 'CLOSED_UNDECIDED', { minutes: null }),
      ],
      rights,
    )
    expect(views.map((v) => v.mark)).toEqual([
      { kind: 'overdue', text: 'นับ: ตัดสินหลังครบกำหนด' },
      { kind: 'overdue', text: 'นับ: ยังเปิดอยู่และเลยกำหนดแล้ว' },
      { kind: 'done', text: 'ไม่นับ: ตัดสินภายในกำหนด' },
      { kind: 'due', text: 'ไม่นับ: ยังเปิดอยู่และยังไม่ถึงกำหนด' },
      { kind: 'due', text: 'ไม่นับ: ขั้นนี้ไม่มีกำหนดเวลา' },
      { kind: 'closed', text: 'ไม่นับ: ปิดโดยไม่ได้ตัดสิน (ยกเลิกหรือโอนงาน)' },
    ])
    // each says who holds it, when it was decided or assigned, and when it was due
    expect(views[0]!.lines[0]).toBe('ผู้รับงาน วีระ ปฏิบัติการ')
    expect(views[0]!.lines[1]).toMatch(/^ตัดสินเมื่อ .+ หลังมอบงาน 10\.0 ชั่วโมงทำการ$/)
    expect(views[1]!.lines[1]).toMatch(/^มอบงานเมื่อ .+ ยังไม่ได้ตัดสิน$/)
    expect(views[0]!.lines[2]).toMatch(/^ครบกำหนด /)
    expect(views[4]!.lines).toHaveLength(2)
    expect(views[0]).toMatchObject({ title: 'คำขอ PR-2569-00001 โต๊ะประชุม', href: '/requests/request-1' })
  })
})

describe('[FR-VIS-003/AC2] the KPI table draws a detail that stands for a list of its own as a link to it', () => {
  it('links "1 จาก 37 ขั้น" under the share of steps past due, and leaves the other details as words', () => {
    const goals = kpiGoals(t, 'th', { ...kpi, g3: { ...kpi.g3, pastDue: { numerator: 1, denominator: 37 } } }, null, QUERY)
    const html = renderToStaticMarkup(createElement(KpiTable, { goals, labels: { caption: 'ตัวชี้วัด', measure: 'ตัวชี้วัดและสูตร', value: 'ค่าในช่วงนี้', baseline: 'ค่าตั้งต้น', target: 'เป้าที่เสนอ' } }))
    const wide = html.slice(html.indexOf('<table'), html.indexOf('</table>'))
    const narrow = html.slice(html.indexOf('</table>'))
    for (const part of [wide, narrow]) {
      // next/link writes the address last
      expect(part).toContain(`<a aria-label="ดูทุกขั้นที่มอบในช่วงนี้: ขั้นที่เกินกำหนด (SLA) 1 จาก 37 ขั้น" class="block w-fit text-primary underline underline-offset-4 hover:no-underline lg:text-sm" href="/kpi/g3c-steps${QUERY.replace(/&/g, '&amp;')}">1 จาก 37 ขั้น</a>`)
      // the value keeps its own link to the steps past due
      expect(part).toContain(`href="/kpi/g3c${QUERY.replace(/&/g, '&amp;')}">2.7%</a>`)
      // G-5's "3 จาก 5 การตัดสิน" stays words: its value opens all 5, counted or not
      expect(part).toMatch(/<span class="[^"]*">3 จาก 5 การตัดสิน<\/span>/)
    }
  })
})
