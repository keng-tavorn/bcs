import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BudgetTable, type AmountLinks, type BudgetDepartmentView, type BudgetTotalView, type FigureView } from '@/ui/budgets/budget-table'
import { leftPercentText, percentText } from '@/ui/budgets/format'
import { MovementSection } from '@/ui/budgets/line-detail'

// The budget dashboard's screen parts (S3-08, spec §11.2 and §9.9): the share left that the low warning speaks of is
// rounded down, so a line below the warning never reads as at it; a department or total running low says so in words
// beside its warning-coloured bar, never by colour alone (NFR-A11Y-03); every amount of a line, a department and the
// total links to what makes it up (FR-BUD-005 AC2); on a phone a movement's amount sits in the right-hand column. The
// pages themselves run in tests/e2e/budgets.spec.ts at 375 and 1440 px.

const links = (of: string, page: string): AmountLinks => ({
  planned: { href: `${page}#planned`, label: `งบตั้งต้นของ ${of}` },
  available: { href: `${page}#movements`, label: `คงเหลือของ ${of}` },
  reserved: { href: `${page}#reserved`, label: `จองของ ${of}` },
  committed: { href: `${page}#committed`, label: `ถือของ ${of}` },
  actual: { href: `${page}#actual`, label: `ตัดจ่ายจริงของ ${of}` },
})

const figures = (low: string | null, of: string, page: string): FigureView => ({
  planned: '300,000.00',
  available: '25,000.00',
  reserved: '275,000.00',
  committed: '0.00',
  actual: '0.00',
  used: 'ใช้แล้ว 0.0%',
  held: 'รวมที่จองแล้ว 91.7%',
  heldBp: 9_167,
  low,
  links: links(of, page),
})

const LABELS = {
  caption: 'ยอดงบประมาณ',
  line: 'บรรทัดงบ',
  planned: 'งบตั้งต้น',
  available: 'คงเหลือ',
  reserved: 'จอง',
  committed: 'ถือ',
  actual: 'ตัดจ่ายจริง',
  share: 'สัดส่วน',
  noShare: 'ยังไม่มีงบตั้งต้น',
  unit: 'บาท',
}

describe('[FR-BUD-005/AC1] the share left is rounded down, so the warning never reads as at its threshold', () => {
  it('9.96 % left reads 9.9 %, 8.75 % reads 8.7 %, exactly 10 % reads 10.0 %; used and held round half up', () => {
    expect([leftPercentText(996), leftPercentText(999), leftPercentText(875), leftPercentText(1_000), leftPercentText(0), leftPercentText(null)]).toEqual(['9.9', '9.9', '8.7', '10.0', '0.0', null])
    expect([percentText(875), percentText(9_125), percentText(10_000)]).toEqual(['8.8', '91.3', '100.0'])
  })
})

describe('[FR-BUD-005/AC1] [FR-BUD-005/AC2] a department and the total running low say so, and every amount leads to its documents', () => {
  const department: BudgetDepartmentView = {
    id: 'it',
    name: 'ฝ่ายไอที',
    totalLabel: 'รวมฝ่ายไอที',
    href: '/budgets/departments/it?fy=fy',
    ...figures('ใกล้หมด เหลือ 8.3%', 'ฝ่ายไอที', '/budgets/departments/it?fy=fy'),
    lines: [{ id: 'l1', code: 'IT-OPEX-2569', name: 'ค่าใช้จ่ายดำเนินงาน ฝ่ายไอที', href: '/budgets/l1', status: null, ...figures('ใกล้หมด เหลือ 8.3%', 'IT-OPEX-2569', '/budgets/l1') }],
  }
  const total: BudgetTotalView = { label: 'รวมทั้งองค์กร', href: '/budgets/total?fy=fy', ...figures('ใกล้หมด เหลือ 8.3%', 'ทั้งองค์กร', '/budgets/total?fy=fy') }
  const html = renderToStaticMarkup(<BudgetTable departments={[department]} total={total} labels={LABELS} />)
  const wide = html.slice(html.indexOf('<table'), html.indexOf('</table>'))
  const narrow = html.slice(html.indexOf('</table>'))

  it('says "running low" in words with an icon on the department and total rows, on wide screens and phones', () => {
    for (const part of [wide, narrow]) {
      // The line, its department and the total: three warnings in words, each beside its icon
      expect(part.match(/ใกล้หมด เหลือ 8\.3%/g)).toHaveLength(3)
    }
    const departmentRow = wide.slice(wide.indexOf('รวมฝ่ายไอที'), wide.indexOf('IT-OPEX-2569'))
    expect(departmentRow).toContain('ใกล้หมด เหลือ 8.3%')
    expect(wide.slice(wide.indexOf('<tfoot'))).toContain('ใกล้หมด เหลือ 8.3%')
  })

  it('links every amount of the department and the total to its drill-down, and the row names to their pages', () => {
    for (const part of [wide, narrow]) {
      for (const page of ['/budgets/departments/it?fy=fy', '/budgets/total?fy=fy', '/budgets/l1']) {
        for (const section of ['planned', 'movements', 'reserved', 'committed', 'actual']) expect(part).toContain(`href="${page}#${section}"`)
      }
      expect(part).toContain('href="/budgets/departments/it?fy=fy">รวมฝ่ายไอที</a>')
      expect(part).toContain('href="/budgets/total?fy=fy">รวมทั้งองค์กร</a>')
    }
  })

  it('heads each department and the total with an h2 on phones, right under the page h1', () => {
    expect(narrow).toMatch(/<h2 id="budget-dept-it"[^>]*>/)
    expect(narrow).toMatch(/<h2 id="budget-total"[^>]*>/)
    expect(narrow).not.toContain('<h3')
  })
})

describe('[FR-BUD-005/AC2] a movement on a phone keeps its amount in the right-hand column', () => {
  it('places what happened at the left and the amount at the right of the same row, the document under them', () => {
    const html = renderToStaticMarkup(
      <MovementSection
        title="ความเคลื่อนไหวในบัญชีงบ"
        intro="ล่าสุดก่อน"
        count="ทั้งหมด 1 รายการ"
        rows={[{ key: 'm1', when: '4 ต.ค. 2569 10:00 น.', what: 'ถืองบ', document: { text: 'ใบสั่งซื้อ PO-2569-00001', href: null }, line: null, amount: '18,000.00' }]}
        empty="ยังไม่มี"
        labels={{ when: 'เวลา', what: 'รายการ', document: 'เอกสาร', amount: 'ยอด', unit: 'บาท' }}
      />,
    )
    const what = /<div class="([^"]*)"><span class="sr-only">รายการ: <\/span>ถืองบ/.exec(html)?.[1] ?? ''
    const amount = /<p class="([^"]*)"><span class="sr-only">ยอด: <\/span>18,000\.00/.exec(html)?.[1] ?? ''
    expect(what.split(' ')).toEqual(expect.arrayContaining(['col-start-1', 'row-start-2']))
    expect(amount.split(' ')).toEqual(expect.arrayContaining(['money', 'col-start-2', 'row-start-2']))
  })
})
