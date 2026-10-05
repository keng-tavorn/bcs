import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect } from './fixtures'

// The lines of a request or a PO at laptop widths (src/ui/request-view/lines.tsx, src/ui/purchase-order/po-lines.tsx,
// §9.9). The e2e projects are 375 and 1440 px wide; between them the workspace's document column is at its narrowest —
// from 1024 px the menu and the aside take most of the page. There the lines never overflow their column and the item
// keeps at least 8rem: columns where they fit (as before on a wide screen), each line stacked where they do not.

/** The narrowest width with the aside beside the document, and two common laptop screens */
export const LAPTOP_WIDTHS = [1024, 1280, 1366] as const

/** How the lines sit in their column at the page's width now, in rem */
function linesLayout(list: Locator) {
  return list.evaluate((ol) => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
    const box = ol.closest('[class~="@container"]')
    const item = ol.querySelector('li .min-w-0')
    if (!box || !item) throw new Error('not the lines of a request or a PO')
    const round = (px: number) => Math.round((px / rem) * 100) / 100
    return {
      column: round(box.clientWidth),
      item: round(item.getBoundingClientRect().width),
      // The row of column headings shows only while the lines are in columns
      columns: box.firstElementChild !== null && getComputedStyle(box.firstElementChild).display !== 'none',
      overflows: box.scrollWidth > box.clientWidth || ol.scrollWidth > ol.clientWidth,
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
    }
  })
}

/**
 * On the desktop project, at each laptop width: the lines fit their column — nothing sideways, the item 8rem or more —
 * photographed with the layout in the picture's name (the whole page); the page's own width comes back after
 */
export async function expectLinesFitLaptops(page: Page, testInfo: TestInfo, list: Locator, name: string) {
  if (testInfo.project.name === 'mobile') return
  const wide = page.viewportSize()!
  for (const width of LAPTOP_WIDTHS) {
    await page.setViewportSize({ width, height: wide.height })
    const layout = await linesLayout(list)
    expect({ width, ...layout }).toEqual({ width, ...layout, overflows: false, pageOverflows: false })
    expect(layout.item, `the item's width at ${width} px (rem)`).toBeGreaterThanOrEqual(7.95)
    await page.screenshot({ path: testInfo.outputPath(`${name}-${width}-${layout.columns ? 'columns' : 'stacked'}.png`), fullPage: true })
  }
  await page.setViewportSize(wide)
}
