import { createTranslator } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { burnView, figureLinks, figureView, shareStrip, type BudgetsT, type BurnFiguresDto } from '@/app/(workspace)/budgets/_present'
import { BudgetTable, type BudgetDepartmentView, type BudgetTotalView, type FigureView } from '@/ui/budgets/budget-table'
import { burnPercentText, thresholdPercentText } from '@/ui/budgets/format'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S6-18 (FR-BUD-104 AC1 · BR-BUD-17) on the budget dashboard: the used share of the burn — rounded down by the service,
// shown with two decimals and never rounded again — in place of the half-up one, the year's forecast (or why there is
// none yet), and the alerts reached as badges with an icon and words (NFR-A11Y-03). The page runs in
// tests/e2e/budget-burn.spec.ts at 375 and 1440 px.

const t = createTranslator({ locale: 'th', messages: th, namespace: 'budgets' }) as unknown as BudgetsT
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'budgets' }) as unknown as BudgetsT
const baht = (amount: string) => ({ amount, currency: 'THB' as const })

// 86.66% used — half up the dashboard's own usedBp is 8667 — and at this pace 104.25% by the end of the year
const hot: BurnFiguresDto = {
  planned: baht('30000.00'),
  available: baht('4002.00'),
  reserved: baht('0.00'),
  committed: baht('20000.00'),
  actual: baht('5998.00'),
  usedBp: 8_667,
  heldBp: 8_667,
  availableBp: 1_334,
  low: false,
  burn: { usedBp: 8_666, forecastBp: 10_425, alerts: ['USED_8000', 'FORECAST_OVER'] },
}
// Early in the year: used, but no forecast yet
const early: BurnFiguresDto = { ...hot, burn: { usedBp: 8_666, forecastBp: null, alerts: ['USED_8000'] } }
// Everything held and spent: both thresholds reached
const full: BurnFiguresDto = { ...hot, burn: { usedBp: 10_000, forecastBp: 10_000, alerts: ['USED_8000', 'USED_10000'] } }
const calm: BurnFiguresDto = { ...hot, burn: { usedBp: 1_000, forecastBp: 4_050, alerts: [] } }

describe('[FR-BUD-104/AC1] the burn as the dashboard shows it', () => {
  it('[FR-BUD-104/AC1] writes the burn’s basis points with two decimals, never rounding them again, and a threshold without trailing zeros', () => {
    expect([burnPercentText(8_666), burnPercentText(8_000), burnPercentText(12_345), burnPercentText(5), burnPercentText(null)]).toEqual(['86.66', '80.00', '123.45', '0.05', null])
    expect([thresholdPercentText(8_000), thresholdPercentText(8_050), thresholdPercentText(8_025), thresholdPercentText(10_000)]).toEqual(['80', '80.5', '80.25', '100'])
  })

  it('[FR-BUD-104/AC1] shows the burn’s used share (rounded down) as the row’s one used share, and the year forecast linked to the documents', () => {
    const view = figureView(t, hot, figureLinks(t, hot, 'MKT-OPEX-2569', '/budgets/l1'))
    expect(view.used).toBe('ใช้แล้ว 86.66%')
    expect(view.links.used?.label).toBe('ใช้แล้ว 86.66% ของ MKT-OPEX-2569: ดูเอกสารที่ถือและตัดจ่ายจริง')
    expect(view.burn).toEqual({
      forecast: 'พยากรณ์ทั้งปี 104.25%',
      forecastHint: null,
      alerts: [
        { kind: 'USED', label: 'ใช้ถึง 80%' },
        { kind: 'FORECAST_OVER', label: 'พยากรณ์เกินงบ' },
      ],
    })
    expect(view.links.forecast).toEqual({ href: '/budgets/l1#committed', label: 'พยากรณ์ทั้งปี 104.25% ของ MKT-OPEX-2569: ดูเอกสารที่ถือและตัดจ่ายจริง' })
    expect(figureView(tEn, hot, figureLinks(tEn, hot, 'MKT-OPEX-2569', '/budgets/l1'))).toMatchObject({
      used: 'Used 86.66%',
      burn: { forecast: 'Year forecast 104.25%', alerts: [{ label: '80% used' }, { label: 'Forecast over budget' }] },
    })
    // a drill-down page's figures carry no burn: its shares stay as before
    const { burn: _burn, ...plain } = hot
    expect(shareStrip(t, plain, 'MKT-OPEX-2569')?.used).toBe('ใช้แล้ว 86.7%')
  })

  it('[FR-BUD-104/AC1] says there is no forecast yet and why, and badges only the highest threshold reached', () => {
    expect(burnView(t, early.burn)).toEqual({ forecast: 'พยากรณ์ทั้งปี: ยังไม่พยากรณ์', forecastHint: 'ปีงบเพิ่งเริ่ม ข้อมูลยังน้อยเกินกว่าจะพยากรณ์ได้', alerts: [{ kind: 'USED', label: 'ใช้ถึง 80%' }] })
    expect(burnView(t, full.burn)?.alerts).toEqual([{ kind: 'USED_ALL', label: 'ใช้ครบ 100%' }])
    expect(burnView(tEn, full.burn)?.alerts).toEqual([{ kind: 'USED_ALL', label: '100% used' }])
    // a threshold of the organization's own, read from the alert's code
    expect(burnView(t, { usedBp: 7_600, forecastBp: 9_000, alerts: ['USED_7550'] })?.alerts).toEqual([{ kind: 'USED', label: 'ใช้ถึง 75.5%' }])
    expect(burnView(t, calm.burn)?.alerts).toEqual([])
    // nothing planned: the row already says so, no burn
    expect(burnView(t, { usedBp: null, forecastBp: null, alerts: [] })).toBeNull()
    expect(burnView(t, undefined)).toBeNull()
  })

  it('[FR-BUD-104/AC1] draws the alerts as badges with an icon and words beside the low warning, and the forecast, on wide screens and phones', () => {
    const row = (f: BurnFiguresDto, of: string, page: string): FigureView => figureView(t, f, figureLinks(t, f, of, page))
    const department: BudgetDepartmentView = {
      id: 'mkt',
      name: 'ฝ่ายการตลาด',
      totalLabel: 'รวมฝ่ายการตลาด',
      href: '/budgets/departments/mkt?fy=fy',
      ...row(calm, 'ฝ่ายการตลาด', '/budgets/departments/mkt?fy=fy'),
      lines: [
        { id: 'l1', code: 'MKT-OPEX-2569', name: 'ค่าใช้จ่ายดำเนินงาน ฝ่ายการตลาด', href: '/budgets/l1', status: null, ...row(hot, 'MKT-OPEX-2569', '/budgets/l1') },
        { id: 'l2', code: 'MKT-CAPEX-2569', name: 'ลงทุน ฝ่ายการตลาด', href: '/budgets/l2', status: null, ...row(early, 'MKT-CAPEX-2569', '/budgets/l2') },
        { id: 'l3', code: 'MKT-EVENT-2569', name: 'งานอีเวนต์', href: '/budgets/l3', status: null, ...row(full, 'MKT-EVENT-2569', '/budgets/l3') },
      ],
    }
    const total: BudgetTotalView = { label: 'รวมทั้งองค์กร', href: '/budgets/total?fy=fy', ...row(calm, 'ทั้งองค์กร', '/budgets/total?fy=fy') }
    const labels = { caption: 'ยอดงบ', line: 'บรรทัดงบ', planned: 'งบปัจจุบัน', available: 'คงเหลือ', reserved: 'จอง', committed: 'ถือ', actual: 'ตัดจ่ายจริง', share: 'สัดส่วน', noShare: 'ยังไม่มีงบตั้งต้น', unit: 'บาท' }
    const html = renderToStaticMarkup(<BudgetTable departments={[department]} total={total} labels={labels} />)
    const badge = (tone: string, icon: string, words: string) => new RegExp(`<span[^>]*data-tone="${tone}"[^>]*><svg[^>]*data-icon="${icon}"[^>]*>(?:(?!</svg>)[\\s\\S])*</svg>${words}</span>`)
    for (const part of [html.slice(html.indexOf('<table'), html.indexOf('</table>')), html.slice(html.indexOf('</table>'))]) {
      // two lines reached 80%; the one at 100% shows that badge alone
      expect(part.match(new RegExp(badge('warn', 'Gauge', 'ใช้ถึง 80%').source, 'g'))).toHaveLength(2)
      expect(part).toMatch(badge('danger', 'Gauge', 'ใช้ครบ 100%'))
      expect(part).toMatch(badge('warn', 'TrendingUp', 'พยากรณ์เกินงบ'))
      expect(part).toMatch(/aria-label="พยากรณ์ทั้งปี 104\.25% ของ MKT-OPEX-2569: ดูเอกสารที่ถือและตัดจ่ายจริง"[^>]* href="\/budgets\/l1#committed">พยากรณ์ทั้งปี 104\.25%<\/a>/)
      expect(part).toContain('พยากรณ์ทั้งปี: ยังไม่พยากรณ์')
      expect(part).toContain('ปีงบเพิ่งเริ่ม ข้อมูลยังน้อยเกินกว่าจะพยากรณ์ได้')
      // one used share per row (department, three lines, total), each the burn's
      expect(part.match(/>ใช้แล้ว [\d.]+%</g)).toEqual(['>ใช้แล้ว 10.00%<', '>ใช้แล้ว 86.66%<', '>ใช้แล้ว 86.66%<', '>ใช้แล้ว 100.00%<', '>ใช้แล้ว 10.00%<'])
    }
  })
})
