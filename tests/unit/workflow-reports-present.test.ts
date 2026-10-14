import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTranslator } from 'next-intl'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CHART_ROWS,
  TAB_REPORTS,
  bottlenecksView,
  cycleView,
  decisionsHeat,
  heatLegend,
  heatLevel,
  openHeat,
  positionText,
  tabFrom,
  tabOfReport,
  wrongDoaView,
  type WorkflowT,
} from '@/app/(workspace)/reports/workflow/_present'
import type { DepartmentRow, PositionRow } from '@/server/queries/org'
import type { WorkflowReport } from '@/server/services/reports/workflow'
import { ReportTable } from '@/ui/insight/report-table'
import th from '../../messages/th.json'

// S6-20 · FR-VIS-101 (BR-RPT-03 to BR-RPT-06): the words, links and charts of /reports/workflow. AC1: cycle time as
// business hours with one decimal and each request opening its page; the bottlenecks by position in words, in the
// order the service gives; each decision outside the DOA with its reason and its document. AC3: every chart has its
// table view with the same figures, the heatmaps' levels are quarters of the largest count, and the charts load lazily.
// The page itself runs in tests/e2e/workflow-reports.spec.ts at 375 and 1440 px.

const t = createTranslator({ locale: 'th', messages: th, namespace: 'workflowReports' }) as unknown as WorkflowT
const ID = (n: number) => `0190a0b0-0000-7000-8000-${String(n).padStart(12, '0')}`

const positions: PositionRow[] = [{ id: ID(90), code: 'VP', nameTh: 'รองประธาน', nameEn: 'Vice president', scope: 'DEPARTMENT' }]
const departments: DepartmentRow[] = [
  { id: ID(80), code: 'OPS', nameTh: 'ฝ่ายปฏิบัติการ', nameEn: 'Operations', kind: 'DIVISION', parentId: null, active: true },
  { id: ID(81), code: 'IT', nameTh: 'ฝ่ายไอที', nameEn: null, kind: 'DEPARTMENT', parentId: ID(80), active: true },
]

const request = (n: number, cycleMinutes: number | null, toFirstPoMinutes: number | null = null) => ({
  requestId: ID(n),
  number: `PR-2610-${String(n).padStart(4, '0')}`,
  submittedAt: '2026-10-01T02:00:00.000Z',
  approvedAt: cycleMinutes === null ? null : '2026-10-02T03:00:00.000Z',
  cycleMinutes,
  toFirstPoMinutes,
})

describe('[FR-VIS-101/AC1] the workflow report tabs say each figure in words and open its documents', () => {
  it('the tab comes from the address (the first otherwise), and each tab exports its own report', () => {
    expect(tabFrom('heatmap')).toBe('heatmap')
    expect(tabFrom('nope')).toBe('cycle')
    expect(tabFrom(undefined)).toBe('cycle')
    expect(TAB_REPORTS).toEqual({ cycle: 'WF_CYCLE', bottlenecks: 'WF_BOTTLENECKS', wrongDoa: 'WF_WRONG_DOA', heatmap: 'WF_HEATMAP' })
    expect(tabOfReport('WF_WRONG_DOA')).toBe('wrongDoa')
    expect(tabOfReport('KPI')).toBeNull()
  })

  it('cycle time: the three medians in business hours with one decimal, "no data yet" for none, and every request opens its page', () => {
    const view = cycleView(t, 'th', { requests: [request(1, 90, 600), request(2, null)], medianCycleMinutes: 90, medianToFirstPoMinutes: null, medianDecisionMinutes: 1083 })
    expect(view.medians.map((m) => m.value)).toEqual(['1.5 ชั่วโมงทำการ', 'ยังไม่มีข้อมูลในช่วงนี้', '18.1 ชั่วโมงทำการ'])
    expect(view.title).toBe('คำขอที่ส่งในช่วงนี้ 2 รายการ')
    expect(view.rows[0]!.cells).toMatchObject({ request: { text: 'PR-2610-0001', href: `/requests/${ID(1)}` }, cycle: { text: '1.5 ชม.' }, toFirstPo: { text: '10.0 ชม.' } })
    // not approved yet: an empty cell read in words, never 0
    expect(view.rows[1]!.cells).toMatchObject({ approvedAt: { text: '', emptyLabel: 'ยังอนุมัติไม่ครบ' }, cycle: { text: '', emptyLabel: 'ยังอนุมัติไม่ครบ' }, toFirstPo: { text: '', emptyLabel: 'ยังไม่มี PO ที่อนุมัติ' } })
    const html = renderToStaticMarkup(createElement(ReportTable, { caption: 'c', columns: view.columns, rows: view.rows, rowHeader: 0, lead: 1 }))
    expect(html).toContain(`href="/requests/${ID(1)}"`)
    expect(html).toContain('<th scope="row" class="px-3 py-2.5 text-left align-top font-normal"><a')
  })

  it('bottlenecks: positions by name and department, named approvers and signatories in words, in the service’s order', () => {
    expect(positionText(t, 'th', 'VP@OPS', positions, departments)).toBe('รองประธาน · ฝ่ายปฏิบัติการ')
    expect(positionText(t, 'en', 'VP@OPS', positions, departments)).toBe('Vice president · Operations')
    expect(positionText(t, 'th', 'CFO@HQ', positions, departments)).toBe('CFO · HQ')
    expect(positionText(t, 'th', `MEMBER:${ID(5)}`, positions, departments)).toBe('ผู้อนุมัติที่ระบุชื่อ')
    expect(positionText(t, 'th', `CONTRACT_SIGNATORY:${ID(5)}`, positions, departments)).toBe('ผู้มีอำนาจลงนาม')

    const b: WorkflowReport['bottlenecks'] = {
      byPosition: [
        { at: 'VP@OPS', overdue: 2, median: null, taskIds: [ID(1), ID(2)] },
        { at: 'CFO@HQ', overdue: 0, median: 120, taskIds: [ID(3)] },
      ],
      byPerson: [{ memberId: ID(7), name: '', overdue: 1, median: 30, taskIds: [ID(4)] }],
    }
    const view = bottlenecksView(t, 'th', b, positions, departments)
    expect(view.positionRows.map((r) => r.cells.position!.text)).toEqual(['รองประธาน · ฝ่ายปฏิบัติการ', 'CFO · HQ'])
    expect(view.positionRows[0]!.cells).toMatchObject({ overdue: { text: '2' }, median: { text: '', emptyLabel: 'ยังไม่มีงานที่ตัดสินแล้ว' }, tasks: { text: '2' } })
    expect(view.personRows[0]!.cells).toMatchObject({ person: { text: 'ไม่ทราบชื่อ' }, median: { text: '0.5 ชม.' } })
    // the bars are the positions with a median; their table has the same rows
    expect(view.chart!.spec.rows).toEqual([{ label: 'CFO · HQ', value: 120, text: '2.0 ชม.' }])
    expect(view.chart!.table.rows).toEqual([[{ text: 'CFO · HQ' }, { text: '2.0 ชม.' }]])
  })

  it('outside DOA: each item with its reason in words, the newest first, opening the document the reader may open', () => {
    const items: WorkflowReport['wrongDoa'] = [
      { key: 'a', reason: 'NOT_BY_DOA', subjectType: 'REQUEST', subjectId: ID(1), number: 'PR-2610-0001', at: '2026-10-01T03:00:00.000Z' },
      { key: 'b', reason: 'NO_DOA_REFERENCE', subjectType: 'PURCHASE_ORDER', subjectId: ID(2), number: null, at: '2026-10-03T03:00:00.000Z' },
      { key: 'c', reason: 'SPLIT', subjectType: 'REQUEST', subjectId: ID(3), number: 'PR-2610-0003', at: '2026-10-02T03:00:00.000Z' },
    ]
    const noPo = wrongDoaView(t, 'th', items, { requests: true, purchaseOrders: false, doaVersions: false, orgAuthorityChanges: false })
    expect(noPo.summary).toBe('3 รายการ · ผู้ตัดสินไม่ใช่ผู้ที่ DOA กำหนด 1 · ไม่อ้าง DOA 1 · อาจแตกยอด 1')
    expect(noPo.rows.map((r) => [r.cells.document!.text, r.cells.document!.href, r.cells.reason!.text])).toEqual([
      ['ใบสั่งซื้อ (PO)', null, 'การตัดสินไม่ได้อ้าง DOA ฉบับและข้อ'],
      ['PR-2610-0003', `/requests/${ID(3)}`, 'คำขอที่อาจแตกยอดเพื่อเลี่ยงวงเงิน'],
      ['PR-2610-0001', `/requests/${ID(1)}`, 'ผู้ตัดสินไม่ใช่ผู้ที่ DOA กำหนด'],
    ])
    const withPo = wrongDoaView(t, 'th', items, { requests: true, purchaseOrders: true, doaVersions: false, orgAuthorityChanges: false })
    expect(withPo.rows[0]!.cells.document!.href).toBe(`/procurement/pos/${ID(2)}`)
  })
})

describe('[FR-VIS-101/AC3] every chart has a table view, the heatmaps scale to the largest count, and the charts load lazily', () => {
  it('the cycle-time bars are the longest requests, at most ten, and their table has the same figures', () => {
    const requests = Array.from({ length: 12 }, (_, i) => request(i + 1, (i + 1) * 60))
    const view = cycleView(t, 'th', { requests, medianCycleMinutes: 360, medianToFirstPoMinutes: null, medianDecisionMinutes: null })
    expect(view.chart!.spec.rows).toHaveLength(CHART_ROWS)
    expect(view.chart!.spec.rows[0]).toEqual({ label: 'PR-2610-0012', value: 720, text: '12.0 ชม.' })
    expect(view.chart!.caption).toBe('คำขอที่ใช้เวลาจากส่งถึงอนุมัติครบนานที่สุด 10 รายการ')
    expect(view.chart!.table.rows.map((r) => r[0]!.text)).toEqual(view.chart!.spec.rows.map((r) => r.label))
    expect(view.chart!.table.rows[0]![1]).toEqual({ text: '12.0 ชม.', href: `/requests/${ID(12)}` })
    expect(cycleView(t, 'th', { requests: [request(1, null)], medianCycleMinutes: null, medianToFirstPoMinutes: null, medianDecisionMinutes: null }).chart).toBeNull()
  })

  it('a heat level is a quarter of the largest count, and the legend says the counts of each level it can reach', () => {
    expect([0, 1, 2, 3, 4, 5, 8].map((c) => heatLevel(c, 8))).toEqual([0, 1, 1, 2, 2, 3, 4])
    expect(heatLevel(1, 1)).toBe(4)
    expect(heatLegend(t, 8).map((l) => [l.level, l.text])).toEqual([
      [1, '1–2'],
      [2, '3–4'],
      [3, '5–6'],
      [4, '7–8'],
    ])
    // a largest count of 2: only the levels a count can be at
    expect(heatLegend(t, 2).map((l) => [l.level, l.text])).toEqual([
      [2, '1'],
      [4, '2'],
    ])
  })

  it('decisions by weekday and hour: Monday first, 24 hours, turned on a phone; the table lists every cell with a count', () => {
    const decisions = [
      { weekday: 'MON', hour: 9, count: 4 },
      { weekday: 'SUN', hour: 22, count: 1 },
      { weekday: 'WED', hour: 14, count: 2 },
    ]
    const heat = decisionsHeat(t, decisions)!
    expect(heat.spec.turnOnPhone).toBe(true)
    expect(heat.spec.rows.map((r) => r.short)).toEqual(['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'])
    expect(heat.spec.columns).toHaveLength(24)
    expect(heat.spec.columns[9]).toEqual({ key: '9', label: '09:00', short: '09' })
    expect(heat.spec.rows[0]!.cells[9]).toEqual({ count: 4, level: 4 })
    expect(heat.spec.rows[6]!.cells[22]).toEqual({ count: 1, level: 1 })
    expect(heat.table.rows).toEqual([
      [{ text: 'วันจันทร์ 09:00–09:59' }, { text: '4' }],
      [{ text: 'วันพุธ 14:00–14:59' }, { text: '2' }],
      [{ text: 'วันอาทิตย์ 22:00–22:59' }, { text: '1' }],
    ])
    expect(decisionsHeat(t, [])).toBeNull()
  })

  it('open tasks by department and age: departments by name, other documents last, with the total in the table', () => {
    const heat = openHeat(t, 'th', [
      { departmentId: null, code: null, bands: { H0_8: 1, H8_16: 0, H16_40: 0, H40_PLUS: 0 } },
      { departmentId: ID(81), code: 'IT', bands: { H0_8: 0, H8_16: 2, H16_40: 0, H40_PLUS: 3 } },
      { departmentId: ID(80), code: 'OPS', bands: { H0_8: 1, H8_16: 0, H16_40: 1, H40_PLUS: 0 } },
    ], departments)!
    expect(heat.spec.turnOnPhone).toBe(false)
    expect(heat.spec.columns.map((c) => c.label)).toEqual(['ไม่ถึง 8 ชม.', '8 ถึง 16 ชม.', '16 ถึง 40 ชม.', '40 ชม. ขึ้นไป'])
    expect(heat.spec.rows.map((r) => r.label)).toEqual(['ฝ่ายปฏิบัติการ', 'ฝ่ายไอที', 'เอกสารที่ไม่ใช่คำขอของแผนก'])
    expect(heat.spec.rows[1]!.cells.map((c) => c.level)).toEqual([0, 3, 0, 4])
    expect(heat.table.columns).toEqual(['แผนก', 'ไม่ถึง 8 ชม.', '8 ถึง 16 ชม.', '16 ถึง 40 ชม.', '40 ชม. ขึ้นไป', 'รวม'])
    expect(heat.table.rows[1]!.map((c) => c.text)).toEqual(['ฝ่ายไอที', '0', '2', '0', '3', '5'])
    expect(openHeat(t, 'th', [], departments)).toBeNull()
  })

  it('the heat grid is reached through import() only and tints with --chart-1; the page draws charts through the lazy wrappers', () => {
    const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
    const wrapper = read('src/ui/insight/heat-chart.tsx')
    expect(wrapper).toMatch(/dynamic\(\(\) => import\('\.\/heat-grid'\)/)
    expect(wrapper).not.toMatch(/^import .*from '\.\/heat-grid'/m)
    expect(wrapper).toMatch(/bg-chart-1\/15/)
    expect(wrapper).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
    const page = read('src/app/(workspace)/reports/workflow/page.tsx')
    expect(page).not.toMatch(/recharts|insight-charts'|heat-grid'/)
    expect(page).toMatch(/InsightChart/)
    expect(page).toMatch(/HeatChart/)
  })
})
