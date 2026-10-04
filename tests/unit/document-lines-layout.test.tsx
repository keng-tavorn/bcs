import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LIFF_COLUMN, LIFF_GUTTER } from '@/ui/liff/content'
import { PoLines, type PoLineView } from '@/ui/purchase-order/po-lines'
import { LineList, type LineView } from '@/ui/request-view/lines'

// §9.4 §9.9 · the lines of a request and of a PO go to columns only when both the screen is md or wider (as the
// workspace always had them) and their own list is wide enough: the LIFF decision page and the LIFF request page render
// them in the LIFF column (36rem) even on a wide screen, where the columns would squeeze the item to a sliver — so the
// list is its own container and its columns also need 37rem of its own width, where the three figures and their gaps
// (29rem) leave the item 8rem. The workspace's request and PO columns keep their columns on a tablet and a wide screen;
// on a laptop, where the menu and the aside leave them narrower, the lines stack rather than overflow; the LIFF column,
// 34rem inside its gutters, never reaches 37rem. Screenshots at 375 and 1440 px, and the laptop widths between:
// tests/e2e/liff-tasks.spec.ts, tests/e2e/request-view.spec.ts and tests/e2e/purchase-order.spec.ts
// (tests/e2e/document-lines.ts).

const LINES: LineView[] = [{ key: '1', description: 'ไม้อัด 10 มม.', quantity: '20 แผ่น', unitPrice: '1,500.00', amount: '30,000.00', notes: ['ไม่มี VAT'] }]
const PO_LINES: PoLineView[] = [
  {
    key: '1',
    title: 'ไม้อัด 10 มม.',
    notes: ['ไม่มี VAT'],
    sources: [{ href: null, label: 'PR-2569-00001 รายการ 1' }],
    quantity: '20 แผ่น',
    unitPrice: '1,500.00',
    amount: '30,000.00',
    prices: { title: 'ราคาที่เคยซื้อ', entries: ['1,450.00 · PO-2569-00003'], none: null, alert: null, ok: 'ราคาไม่สูงกว่าครั้งก่อนเกินเกณฑ์' },
  },
]

/** Where the columns start, in rem of the list's own width */
const COLUMNS_AT = 37
/** The variant of every class that changes with the layout: the screen from md (as before) and the list's own width */
const COLUMNS = `md:@min-[${COLUMNS_AT}rem]:`

/** Every class of the markup that has a breakpoint or container variant */
const variants = (page: string) => [...page.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter((c) => /^(sm|md|lg|xl|2xl|@[\w[\]-]+):/.test(c))

/** Tailwind's max-width steps, in rem */
const MAX_WIDTH_REM: Readonly<Record<string, number>> = { 'max-w-sm': 24, 'max-w-md': 28, 'max-w-lg': 32, 'max-w-xl': 36, 'max-w-2xl': 42, 'max-w-3xl': 48 }

describe('[§9.4] [§9.9] request and PO lines switch to columns on a wide enough screen and by the width of their own list', () => {
  it.each([
    ['a request’s lines', renderToStaticMarkup(<LineList lines={LINES} labels={{ description: 'รายการ', quantity: 'จำนวน', unitPrice: 'ราคาต่อหน่วย', amount: 'จำนวนเงิน' }} />)],
    ['a PO’s lines', renderToStaticMarkup(<PoLines lines={PO_LINES} labels={{ list: 'รายการในใบสั่งซื้อ', description: 'รายการ', quantity: 'จำนวน', unitPrice: 'ราคาต่อหน่วย', amount: 'จำนวนเงิน' }} />)],
  ])('%s: the list is a container, and its columns, column headings and smaller notes need both', (_label, page) => {
    // The outermost element is the container the variants measure
    expect(page).toMatch(/^<div class="@container /)
    const used = variants(page)
    expect(used.length).toBeGreaterThan(0)
    // Never the screen alone: in the LIFF column of a wide screen the lines keep their phone layout
    expect(used.filter((c) => !c.startsWith(COLUMNS))).toEqual([])
    expect(used).toEqual(expect.arrayContaining([`${COLUMNS}grid`, `${COLUMNS}grid-cols-[minmax(0,1fr)_8rem_9rem_9rem]`, `${COLUMNS}sr-only`]))
    // Otherwise each figure keeps its label beside it, and the headings row is hidden
    expect(page).toMatch(new RegExp(`<div class="hidden [^"]*${COLUMNS.replace(/[[\]]/g, '\\$&')}grid[^"]*" aria-hidden="true">`))
    expect(page).toContain(`<span class="text-base text-ink-muted ${COLUMNS}sr-only">จำนวน</span>`)
  })

  it('the columns leave the item 8rem, and the LIFF column never reaches them, whatever the screen', () => {
    // The fixed columns (8, 9 and 9rem) and the three 1rem gaps
    const figures = 8 + 9 + 9 + 3
    expect(COLUMNS_AT - figures).toBeGreaterThanOrEqual(8)
    // The LIFF column's widest content: its max width less the two 1rem gutters (a phone's safe area only widens them)
    const max = LIFF_COLUMN.split(' ').find((c) => c.startsWith('max-w-'))
    expect(max && MAX_WIDTH_REM[max]).toBeDefined()
    expect(LIFF_GUTTER).toContain('max(1rem,')
    expect(MAX_WIDTH_REM[max!]! - 2).toBeLessThan(COLUMNS_AT)
  })
})
