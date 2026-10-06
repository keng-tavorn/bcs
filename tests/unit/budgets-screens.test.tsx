import { createTranslator } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { amountLinks, figureStrip, figureView, lowItemText, shareStrip, type BudgetsT } from '@/app/(workspace)/budgets/_present'
import type { BudgetFiguresDto } from '@/server/services/budget/dashboard'
import { BudgetTable, type AmountLinks, type BudgetDepartmentView, type BudgetTotalView, type FigureView } from '@/ui/budgets/budget-table'
import { leftPercentText, percentText } from '@/ui/budgets/format'
import { LineFigures, MovementSection } from '@/ui/budgets/line-detail'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// The budget dashboard's screen parts (S3-08, spec §11.2 and §9.9): the share left that the low warning speaks of is
// rounded down, so a line below the warning never reads as at it; a department or total running low says so in words
// beside its warning-coloured bar, never by colour alone (NFR-A11Y-03); every amount of a line, a department and the
// total links to what makes it up (FR-BUD-005 AC2), 0.00 too; on a phone a movement's amount sits in the right-hand
// column. The pages themselves run in tests/e2e/budgets.spec.ts at 375 and 1440 px.

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
  out: false,
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

describe('[FR-BUD-005/AC2] every amount leads to what makes it up, 0.00 too, as the dashboard’s intro promises', () => {
  const t = createTranslator({ locale: 'th', messages: th, namespace: 'budgets' }) as unknown as BudgetsT
  const baht = (amount: string) => ({ amount, currency: 'THB' as const })
  // Funded and partly used: nothing reserved and nothing invoiced yet
  const line: BudgetFiguresDto = { planned: baht('40000.00'), available: baht('32000.00'), reserved: baht('0.00'), committed: baht('8000.00'), actual: baht('0'), usedBp: 2_000, heldBp: 2_000, availableBp: 8_000, low: false }
  // Nothing imported yet: every amount 0.00
  const nothing: BudgetFiguresDto = { planned: baht('0.00'), available: baht('0.00'), reserved: baht('0.00'), committed: baht('0.00'), actual: baht('0.00'), usedBp: null, heldBp: null, availableBp: null, low: false }
  /** Text matched as it is written, inside a pattern */
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  it('links a 0.00 to its section of the drill-down like any other amount, its name saying the amount, whose it is and where it leads', () => {
    expect(amountLinks(t, line, 'FIN-OPEX-2569', '/budgets/l1')).toEqual({
      planned: { href: '/budgets/l1#planned', label: 'งบตั้งต้น 40,000.00 บาท ของ FIN-OPEX-2569: ดูการนำเข้างบ' },
      available: { href: '/budgets/l1#movements', label: 'คงเหลือ 32,000.00 บาท ของ FIN-OPEX-2569: ดูความเคลื่อนไหวในบัญชีงบ' },
      reserved: { href: '/budgets/l1#reserved', label: 'จอง 0.00 บาท ของ FIN-OPEX-2569: ดูเอกสาร' },
      committed: { href: '/budgets/l1#committed', label: 'ถือ 8,000.00 บาท ของ FIN-OPEX-2569: ดูเอกสาร' },
      actual: { href: '/budgets/l1#actual', label: 'ตัดจ่ายจริง 0.00 บาท ของ FIN-OPEX-2569: ดูเอกสาร' },
    })
    // before anything is imported, planned and available lead to the imports and the movements, which say what will come
    const empty = amountLinks(t, nothing, 'ฝ่ายจัดซื้อ', '/budgets/departments/proc?fy=fy')
    expect(empty.planned).toEqual({ href: '/budgets/departments/proc?fy=fy#planned', label: 'งบตั้งต้น 0.00 บาท ของ ฝ่ายจัดซื้อ: ดูการนำเข้างบ' })
    expect(empty.available).toEqual({ href: '/budgets/departments/proc?fy=fy#movements', label: 'คงเหลือ 0.00 บาท ของ ฝ่ายจัดซื้อ: ดูความเคลื่อนไหวในบัญชีงบ' })
  })

  it('draws every amount of the dashboard as a link, the 0.00 ones too, on wide screens and phones', () => {
    // each row's figures and links as the dashboard makes them (src/app/(workspace)/budgets/page.tsx)
    const row = (of: string, page: string): FigureView => figureView(t, line, amountLinks(t, line, of, page))
    const department: BudgetDepartmentView = {
      id: 'fin',
      name: 'ฝ่ายบัญชีและการเงิน',
      totalLabel: 'รวมฝ่ายบัญชีและการเงิน',
      href: '/budgets/departments/fin?fy=fy',
      ...row('ฝ่ายบัญชีและการเงิน', '/budgets/departments/fin?fy=fy'),
      lines: [{ id: 'l1', code: 'FIN-OPEX-2569', name: 'ค่าใช้จ่ายดำเนินงาน ฝ่ายบัญชีและการเงิน', href: '/budgets/l1', status: null, ...row('FIN-OPEX-2569', '/budgets/l1') }],
    }
    const total: BudgetTotalView = { label: 'รวมทั้งองค์กร', href: '/budgets/total?fy=fy', ...row('ทั้งองค์กร', '/budgets/total?fy=fy') }
    const html = renderToStaticMarkup(<BudgetTable departments={[department]} total={total} labels={LABELS} />)
    for (const part of [html.slice(html.indexOf('<table'), html.indexOf('</table>')), html.slice(html.indexOf('</table>'))]) {
      for (const [of, page] of [
        ['FIN-OPEX-2569', '/budgets/l1'],
        ['ฝ่ายบัญชีและการเงิน', '/budgets/departments/fin?fy=fy'],
        ['ทั้งองค์กร', '/budgets/total?fy=fy'],
      ] as const) {
        // next/link writes the address last
        expect(part).toMatch(new RegExp(`aria-label="จอง 0\\.00 บาท ของ ${literal(of)}: ดูเอกสาร"[^>]* href="${literal(page)}#reserved">0\\.00</a>`))
        expect(part).toMatch(new RegExp(`aria-label="ตัดจ่ายจริง 0\\.00 บาท ของ ${literal(of)}: ดูเอกสาร"[^>]* href="${literal(page)}#actual">0\\.00</a>`))
      }
      // three rows of five amounts, each one a link, and no amount left as plain text
      expect(part.match(/aria-label="[^"]+ บาท ของ [^"]+: ดู[^"]+"[^>]*>[\d,]+\.\d{2}<\/a>/g)).toHaveLength(15)
      expect(part.match(/>[\d,]+\.\d{2}</g)).toHaveLength(15)
    }
  })

  it('links every amount of a drill-down page’s strip to its section on the page, 0.00 too', () => {
    const strip = figureStrip(t, nothing, 'ฝ่ายจัดซื้อ')
    expect(strip.map((f) => [f.amount, f.href])).toEqual([
      ['0.00', '#planned'],
      ['0.00', '#movements'],
      ['0.00', '#reserved'],
      ['0.00', '#committed'],
      ['0.00', '#actual'],
    ])
    const html = renderToStaticMarkup(<LineFigures title="ยอดรวมของบรรทัดงบเหล่านี้" figures={strip} shares={null} unit="บาท" />)
    expect(html.match(/<a href="#[a-z]+" aria-label="[^"]+ 0\.00 บาท ของ ฝ่ายจัดซื้อ: [^"]+"[^>]*>0\.00<\/a>/g)).toHaveLength(5)
  })
})

describe('[FR-BUD-005/AC1] [§9.9] a budget with nothing left says it is used up, in the danger colour of งบไม่พอ, never "running low, 0.0% left"', () => {
  const t = createTranslator({ locale: 'th', messages: th, namespace: 'budgets' }) as unknown as BudgetsT
  const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'budgets' }) as unknown as BudgetsT
  const baht = (amount: string) => ({ amount, currency: 'THB' as const })
  // Everything reserved or held: 0.00 left, so a new request on it is refused (BR-BUD-02)
  const out: BudgetFiguresDto = { planned: baht('40000.00'), available: baht('0.00'), reserved: baht('30000.00'), committed: baht('10000.00'), actual: baht('0.00'), usedBp: 2_500, heldBp: 10_000, availableBp: 0, low: true }
  // One satang left: the share rounds down to 0.0%, yet the line is still only running low
  const little: BudgetFiguresDto = { ...out, available: baht('0.01'), reserved: baht('29999.99') }
  // Plenty left
  const fine: BudgetFiguresDto = { planned: baht('40000.00'), available: baht('32000.00'), reserved: baht('0.00'), committed: baht('8000.00'), actual: baht('0.00'), usedBp: 2_000, heldBp: 2_000, availableBp: 8_000, low: false }
  const row = (f: BudgetFiguresDto, of: string, page: string): FigureView => figureView(t, f, amountLinks(t, f, of, page))
  /** A warning's words beside its icon, in the tone given */
  const badge = (tone: string, words: string) => new RegExp(`<svg[^>]*class="[^"]*${tone}[^"]*"[^>]*>(?:(?!</svg>)[\\s\\S])*</svg><span>${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`)

  it('words the warning by the amount left: used up at 0.00, running low while a satang is left', () => {
    expect(figureView(t, out, amountLinks(t, out, 'IT-OPEX-2569', '/budgets/l1'))).toMatchObject({ low: 'งบหมด เหลือ 0.00 บาท', out: true })
    expect(figureView(t, little, amountLinks(t, little, 'IT-OPEX-2569', '/budgets/l1'))).toMatchObject({ low: 'ใกล้หมด เหลือ 0.0%', out: false })
    expect(figureView(t, fine, amountLinks(t, fine, 'IT-OPEX-2569', '/budgets/l1'))).toMatchObject({ low: null, out: false })
    expect(figureView(tEn, out, amountLinks(tEn, out, 'IT-OPEX-2569', '/budgets/l1')).low).toBe('Used up: 0.00 baht left')
    // the low notice of the dashboard lists it in the same words; the drill-down's bar turns to danger too
    expect(lowItemText(t, { ...out, code: 'IT-OPEX-2569', nameTh: 'ค่าใช้จ่ายดำเนินงาน ฝ่ายไอที' })).toBe('IT-OPEX-2569 ค่าใช้จ่ายดำเนินงาน ฝ่ายไอที · งบหมด เหลือ 0.00 บาท')
    expect(lowItemText(t, { ...little, code: 'IT-OPEX-2569', nameTh: 'ค่าใช้จ่ายดำเนินงาน ฝ่ายไอที' })).toBe('IT-OPEX-2569 ค่าใช้จ่ายดำเนินงาน ฝ่ายไอที · เหลือ 0.0%')
    expect(shareStrip(t, out)).toMatchObject({ out: true })
    expect(shareStrip(t, little)).toMatchObject({ out: false, low: true })
  })

  it('draws the used-up line with the danger icon and a danger bar, the others as before, on wide screens and phones', () => {
    const department: BudgetDepartmentView = {
      id: 'it',
      name: 'ฝ่ายไอที',
      totalLabel: 'รวมฝ่ายไอที',
      href: '/budgets/departments/it?fy=fy',
      ...row(fine, 'ฝ่ายไอที', '/budgets/departments/it?fy=fy'),
      lines: [
        { id: 'l1', code: 'IT-OPEX-2569', name: 'ค่าใช้จ่ายดำเนินงาน ฝ่ายไอที', href: '/budgets/l1', status: null, ...row(out, 'IT-OPEX-2569', '/budgets/l1') },
        { id: 'l2', code: 'IT-CAPEX-2569', name: 'ลงทุนอุปกรณ์ไอที', href: '/budgets/l2', status: null, ...row(little, 'IT-CAPEX-2569', '/budgets/l2') },
      ],
    }
    const total: BudgetTotalView = { label: 'รวมทั้งองค์กร', href: '/budgets/total?fy=fy', ...row(fine, 'ทั้งองค์กร', '/budgets/total?fy=fy') }
    const html = renderToStaticMarkup(<BudgetTable departments={[department]} total={total} labels={LABELS} />)
    for (const part of [html.slice(html.indexOf('<table'), html.indexOf('</table>')), html.slice(html.indexOf('</table>'))]) {
      expect(part).toMatch(badge('text-danger', 'งบหมด เหลือ 0.00 บาท'))
      expect(part).toMatch(badge('text-warn', 'ใกล้หมด เหลือ 0.0%'))
      expect(part).not.toMatch(badge('text-warn', 'งบหมด เหลือ 0.00 บาท'))
      // one danger bar (the used-up line), one warning bar (the line running low)
      expect(part.match(/bg-danger/g)).toHaveLength(1)
      expect(part.match(/bg-warn/g)).toHaveLength(1)
    }
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
