import { createTranslator } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HOME_LOW_LINES, homeBudgetView, type HomeBudgetView } from '@/app/(workspace)/_tracking/home-budget'
import { HomeBudgetSection } from '@/app/(workspace)/_tracking/home-budget-section'
import type { HomeT } from '@/app/(workspace)/_tracking/pool-row'
import type { BudgetsT } from '@/app/(workspace)/budgets/_present'
import type { BudgetDashboardDto, BudgetDashboardLineDto, BudgetFiguresDto } from '@/server/services/budget/dashboard'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// §9.1 "/" — the home of a member who may view budgets has a budget summary (D-05 round 5: the CEO, the auditor and the
// approvers whose menu has "งบประมาณ" saw no budget until they opened /budgets) — after the work and the requests (§9.9
// principle 1), as a short list, never a card or a chart: what is left in the member's scope against what was planned,
// then the lines running low or used up with their icon and words, and the whole budget a link away. Every amount, and
// every line with the number of its warning, leads to what makes it up (§9.9: every number opens its list), in the words
// /budgets uses for the same figures. Who sees which lines is the dashboard service's: tests/integration/home-budget.test.ts
// (real Postgres).

const tTh = createTranslator({ locale: 'th', messages: th, namespace: 'home' }) as unknown as HomeT
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'home' }) as unknown as HomeT
const tbTh = createTranslator({ locale: 'th', messages: th, namespace: 'budgets' }) as unknown as BudgetsT
const tbEn = createTranslator({ locale: 'en', messages: en, namespace: 'budgets' }) as unknown as BudgetsT

const baht = (amount: string) => ({ amount, currency: 'THB' as const })
const FY = '0199aaaa-0000-7000-8000-0000000000f1'

/** Figures with `planned` and `available` baht, the share left in basis points (rounded down) and the low warning */
const figures = (planned: string, available: string, availableBp: number, low: boolean): BudgetFiguresDto => ({
  planned: baht(planned),
  available: baht(available),
  reserved: baht('0.00'),
  committed: baht('0.00'),
  actual: baht('0.00'),
  usedBp: 0,
  heldBp: 10_000 - availableBp,
  availableBp,
  low,
})

const line = (n: number, code: string, f: BudgetFiguresDto): BudgetDashboardLineDto => ({
  id: `0199aaaa-0000-7000-8000-00000000000${n}`,
  code,
  nameTh: `ค่าใช้จ่ายดำเนินงาน ${code.split('-')[0]}`,
  status: 'OPEN',
  departmentId: `d-${n}`,
  costCenterCode: `CC-${n}`,
  ...f,
})

const CON = line(1, 'CON-OPEX-2569', figures('500000.00', '200300.00', 4_006, false))
/** 8.33 % left: below the 10 % warning */
const IT = line(2, 'IT-OPEX-2569', figures('300000.00', '25000.00', 833, true))
/** Nothing left: used up, whatever the warning says */
const PROC = line(3, 'PROC-OPEX-2569', figures('50000.00', '0.00', 0, false))

const dashboard = (lines: readonly BudgetDashboardLineDto[], more: Partial<BudgetDashboardDto> = {}): BudgetDashboardDto => ({
  fiscalYear: { id: FY, code: 'FY2569', startsOn: '2026-01-01', endsOn: '2026-12-31' },
  fiscalYears: [{ id: FY, code: 'FY2569' }],
  scope: 'ORG',
  lowPct: 10,
  lines,
  departments: [],
  total: figures('850000.00', '225300.00', 2_650, false),
  asOf: '2026-10-06T05:00:00.000Z',
  can: { import: false, manageGrants: false },
  ...more,
})

const figuresOf = (view: HomeBudgetView) => {
  if (view.kind !== 'FIGURES') throw new Error(`expected figures, got ${view.kind}`)
  return view
}

describe('[§9.1] [§9.9] the home’s budget summary: what is left in the member’s scope and the lines running low, every number a link', () => {
  it('what is left in the scope, against what was planned, each amount leading to what makes it up, named as on /budgets', () => {
    const view = figuresOf(homeBudgetView(tTh, tbTh, dashboard([CON, IT, PROC])))
    expect(view.labels).toEqual({ title: 'งบประมาณ', list: 'งบคงเหลือและบรรทัดงบที่ใกล้หมด', amountHeading: 'คงเหลือ (บาท)' })
    const org = tbTh('scope.ORG')
    expect(view.scopeLine).toBe(`ปีงบ FY2569 · ${org}`)
    expect(view.totalLabel).toBe(tbTh('table.total.ORG'))
    expect(view.available).toEqual({ text: '225,300.00', href: `/budgets/total?fy=${FY}#movements`, label: tbTh('table.availableLink', { amount: '225,300.00', code: org }) })
    expect(view.planned).toEqual({ text: 'งบตั้งต้น 850,000.00 บาท', href: `/budgets/total?fy=${FY}#planned`, label: tbTh('table.plannedLink', { amount: '850,000.00', code: org }) })
  })

  it('the lines running low and those used up, in the order /budgets lists them, with their warning and their amount’s link', () => {
    const view = figuresOf(homeBudgetView(tTh, tbTh, dashboard([CON, IT, PROC])))
    expect(view.low).toEqual([
      {
        id: IT.id,
        title: 'IT-OPEX-2569 · ค่าใช้จ่ายดำเนินงาน IT',
        href: `/budgets/${IT.id}`,
        warning: tbTh('low.badge', { left: '8.3' }),
        out: false,
        available: { text: '25,000.00', href: `/budgets/${IT.id}#movements`, label: tbTh('table.availableLink', { amount: '25,000.00', code: 'IT-OPEX-2569' }) },
      },
      {
        id: PROC.id,
        title: 'PROC-OPEX-2569 · ค่าใช้จ่ายดำเนินงาน PROC',
        href: `/budgets/${PROC.id}`,
        warning: tbTh('low.out', { amount: '0.00' }),
        out: true,
        available: { text: '0.00', href: `/budgets/${PROC.id}#movements`, label: tbTh('table.availableLink', { amount: '0.00', code: 'PROC-OPEX-2569' }) },
      },
    ])
    expect(view.noneLow).toBeNull()
    expect(view.all).toEqual({ href: '/budgets', text: 'ดูงบประมาณทั้งหมด' })
  })

  it('every link’s name holds what it shows (WCAG 2.5.3)', () => {
    const view = figuresOf(homeBudgetView(tTh, tbTh, dashboard([CON, IT, PROC])))
    for (const amount of [view.available, view.planned, ...view.low.map((l) => l.available)]) expect(amount.label).toContain(amount.text)
  })

  it('a head’s scope says so, and nothing running low says that too', () => {
    const view = figuresOf(homeBudgetView(tTh, tbTh, dashboard([CON], { scope: 'DEPT', total: CON })))
    const dept = tbTh('scope.DEPT')
    expect(view.scopeLine).toBe(`ปีงบ FY2569 · ${dept}`)
    expect(view.totalLabel).toBe(tbTh('table.total.DEPT'))
    expect(view.available.label).toBe(tbTh('table.availableLink', { amount: '200,300.00', code: dept }))
    expect(view.low).toEqual([])
    expect(view.noneLow).toBe('ยังไม่มีบรรทัดงบที่ใกล้หมด')
  })

  it(`lists at most ${HOME_LOW_LINES} lines running low; the link to the whole budget says how many there are`, () => {
    const many = Array.from({ length: HOME_LOW_LINES + 2 }, (_, i) => line(i + 1, `L${i + 1}-OPEX-2569`, figures('1000.00', '50.00', 500, true)))
    const view = figuresOf(homeBudgetView(tTh, tbTh, dashboard(many)))
    expect(view.low.map((l) => l.id)).toEqual(many.slice(0, HOME_LOW_LINES).map((l) => l.id))
    expect(view.all).toEqual({ href: '/budgets', text: `ดูงบประมาณทั้งหมด (งบใกล้หมด ${HOME_LOW_LINES + 2} บรรทัด)` })
    expect(figuresOf(homeBudgetView(tEn, tbEn, dashboard(many))).all.text).toBe(`See all budgets (${HOME_LOW_LINES + 2} lines running low)`)
  })

  it('no budget yet: what will show here and when, and the import for those who may import (§9.9 principle 8)', () => {
    expect(homeBudgetView(tTh, tbTh, dashboard([]))).toMatchObject({ kind: 'EMPTY', title: tbTh('empty.title'), hint: tbTh('empty.hintOther'), importLink: null })
    expect(homeBudgetView(tTh, tbTh, dashboard([], { fiscalYear: null, can: { import: true, manageGrants: true } }))).toMatchObject({
      kind: 'EMPTY',
      title: tbTh('empty.noYear'),
      hint: tbTh('empty.hintAdmin'),
      importLink: { href: '/budgets/import', text: tbTh('actions.import') },
    })
  })

  it('in English as well', () => {
    const view = figuresOf(homeBudgetView(tEn, tbEn, dashboard([CON, IT, PROC])))
    expect(view.labels).toEqual({ title: 'Budgets', list: 'Budget left and budget lines running low', amountHeading: 'Available (baht)' })
    expect(view.scopeLine).toBe(`Fiscal year FY2569 · ${tbEn('scope.ORG')}`)
    expect(view.planned.text).toBe('Planned 850,000.00 baht')
    expect(view.low.map((l) => l.warning)).toEqual([tbEn('low.badge', { left: '8.3' }), tbEn('low.out', { amount: '0.00' })])
  })
})

describe('[§9.9] the summary drawn: a list under the work — no card, no chart — every number inside a link', () => {
  const page = renderToStaticMarkup(<HomeBudgetSection view={homeBudgetView(tTh, tbTh, dashboard([CON, IT, PROC]))} />)
  const words = (markup: string) => markup.replace(/<[^>]+>/g, '')
  /** Every <a> of the markup: its opening tag and its words */
  const anchors = (markup: string) => [...markup.matchAll(/(<a [^>]*>)([\s\S]*?)<\/a>/g)].map((m) => ({ tag: m[1]!, words: words(m[2]!) }))

  it('every figure — the amounts and the share left of a warning — is inside a link', () => {
    const outside = words(page.replace(/<a [^>]*>[\s\S]*?<\/a>/g, ''))
    expect(outside).not.toMatch(/\d[\d,]*\.\d{2}|\d+(?:\.\d+)?\s*%/)
    const linked = anchors(page).map((a) => a.words).join(' | ')
    for (const figure of ['225,300.00', '850,000.00', '25,000.00', '0.00', '8.3%']) expect(linked).toContain(figure)
  })

  it('a section with its heading; the amounts right-aligned in tabular digits under the heading of their column; the whole budget a link away', () => {
    expect(page).toMatch(/^<section aria-labelledby="my-budget"[^>]*><h2 id="my-budget"[^>]*>งบประมาณ<\/h2>/)
    expect(page).toContain('<p class="pb-1 text-right text-base text-ink-muted md:text-sm" aria-hidden="true">คงเหลือ (บาท)</p>')
    const amounts = anchors(page).filter((a) => /aria-label="คงเหลือ /.test(a.tag))
    expect(amounts.map((a) => a.words)).toEqual(['225,300.00', '25,000.00', '0.00'])
    for (const a of amounts) expect(a.tag).toMatch(/class="money [^"]*"/)
    const all = anchors(page).find((a) => a.tag.includes('href="/budgets"'))
    expect(all?.words).toBe('ดูงบประมาณทั้งหมด')
    expect(all?.tag).toContain('min-h-11')
    // Rows separated by rules: no card, no shadow, no chart
    expect(page).not.toMatch(/shadow|rounded-(?:md|lg|xl)|<canvas|role="img"/)
  })

  it('a line running low says so with its icon and words, never by colour alone (NFR-A11Y-03), inside the link to its page', () => {
    const lineLink = anchors(page).find((a) => a.tag.includes(`href="/budgets/${IT.id}"`))
    expect(lineLink?.words).toBe(`IT-OPEX-2569 · ค่าใช้จ่ายดำเนินงาน IT${tbTh('low.badge', { left: '8.3' })}`)
    const icon = /<svg[^>]*>/.exec(/<a [^>]*href="\/budgets\/0199aaaa-0000-7000-8000-000000000002"[^>]*>[\s\S]*?<\/a>/.exec(page)?.[0] ?? '')?.[0] ?? ''
    expect(icon).toContain('text-warn')
    expect(icon).toContain('aria-hidden="true"')
  })
})
