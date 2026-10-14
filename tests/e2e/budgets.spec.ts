import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { type Locator, type Page } from '@playwright/test'
import { BUDGET_EXPORT_COLUMNS } from '../../src/server/services/budget/export'
import { expectAmountsAtTheRight, expectNoBlockingAxe, expectNoSideways, scene, sheetRows, shot, signIn, startsWithAmount, type DashboardScene, type Figures } from './budgets-support'
import { expect, test } from './fixtures'

// S3-08 · FR-BUD-005 (spec §11.2, demo scene 9): the budget dashboard — every line by department and the total, the lines
// running low first, every amount of a line, a department and the total opening what makes it up (AC2), figures as
// fresh as the ledger (AC3) and the Excel file of what is shown. Each project builds its own budget line, people and
// documents through the services (tests/e2e/budgets-scene.ts): a line of 40,000.00 with a request reserving 18,500.00
// and a sent PO holding 8,000.00 after an invoice of 10,000.00, so 3,500.00 is left (8.75 %, below the 10 % warning,
// shown rounded down as 8.7 %). The expected department and total figures are what the ledger holds at that moment,
// read by the scene.

/** The block of one line on the dashboard: a table row on wide screens, a list item on phones */
function lineBlock(page: Page, wide: boolean, code: string): Locator {
  return wide ? page.getByRole('row').filter({ hasText: code }) : page.getByRole('listitem').filter({ has: page.getByRole('link', { name: code, exact: true }) })
}

/** A department's or the total's block */
function totalBlock(page: Page, wide: boolean, label: string): Locator {
  return wide ? page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: label, exact: true }) }) : page.getByRole('region', { name: label, exact: true })
}

/** planned, available, reserved, committed and actual, in that order, as the block shows them */
async function expectFigures(block: Locator, wide: boolean, f: Figures) {
  const cells = wide ? block.getByRole('cell') : block.locator('dd')
  for (const [i, amount] of [f.planned, f.available, f.reserved, f.committed, f.actual].entries()) await expect(cells.nth(i), amount).toHaveText(startsWithAmount(amount))
}

/** The amounts strip at the top of a drill-down page */
async function expectStrip(page: Page, title: string, f: Figures) {
  const strip = page.getByRole('region', { name: title }).locator('dd')
  for (const [i, amount] of [f.planned, f.available, f.reserved, f.committed, f.actual].entries()) await expect(strip.nth(i), amount).toHaveText(startsWithAmount(amount))
}

test('[FR-BUD-005/AC1] [FR-BUD-005/AC2] [FR-BUD-005/AC3] the dashboard shows every line, department and total as the ledger has them, each amount opens its documents, and the Excel file holds the same', async ({
  page,
}, testInfo) => {
  // A scene of its own, several pages, axe and a screenshot at each state: longer than the default 30 s
  test.slow()
  const wide = testInfo.project.name === 'desktop'
  const s = scene<DashboardScene>('dashboard', testInfo.project.name)
  await signIn(page, s.viewer.email, s.viewer.code)
  await page.goto('/budgets')
  await expect(page.getByRole('heading', { level: 1, name: 'งบประมาณ' })).toBeVisible()
  await expect(page.getByText(new RegExp(`^ปีงบ ${s.fiscalYear.code} \\(.+ ถึง .+\\) · ทั้งองค์กร$`))).toBeVisible()
  await expect(page.getByText(/^ตัวเลข ณ /)).toBeVisible()

  // The lines running low come first, each a link to its documents; the share left is rounded down (8.75 % → 8.7 %)
  const low = page.getByRole('status').filter({ hasText: /งบใกล้หมด \d+ บรรทัด/ })
  await expect(low).toContainText('เหลือต่ำกว่า 10% ของงบตั้งต้น')
  await expect(low.getByRole('link', { name: `${s.line.code} ${s.line.name} · เหลือ 8.7%` })).toBeVisible()

  // The line, its department and the total, to the satang as the ledger has them (AC1)
  const line = lineBlock(page, wide, s.line.code)
  await expectFigures(line, wide, s.figures.line)
  await expect(line).toContainText('ใช้แล้ว 45.0%')
  await expect(line).toContainText('รวมที่จองแล้ว 91.3%')
  await expect(line).toContainText('ใกล้หมด เหลือ 8.7%')
  // …and every share and the warning's share left open what makes them up, like the amounts (§9.9 every number opens
  // its list): the documents behind a share, the ledger's movements behind what is left
  for (const [name, section] of [
    [`ใช้แล้ว 45.0% ของ ${s.line.code}: ดูเอกสารที่ถือและตัดจ่ายจริง`, 'committed'],
    [`รวมที่จองแล้ว 91.3% ของ ${s.line.code}: ดูเอกสารที่จอง ถือ และตัดจ่ายจริง`, 'reserved'],
    [`ใกล้หมด เหลือ 8.7% ของ ${s.line.code}: ดูความเคลื่อนไหวในบัญชีงบ`, 'movements'],
  ] as const) {
    await expect(line.getByRole('link', { name, exact: true }), name).toHaveAttribute('href', `/budgets/${s.line.id}#${section}`)
  }
  await expectFigures(totalBlock(page, wide, 'รวมฝ่ายบัญชีและการเงิน'), wide, s.figures.fin)
  await expectFigures(totalBlock(page, wide, 'รวมทั้งองค์กร'), wide, s.figures.total)
  if (!wide) {
    // On a phone every amount of the list (the lines, the department bands and the organization total) ends on one
    // right edge, so a total sits right under what it adds up (§9.9 rule 6; D-05 /budgets item 16)
    const list = totalBlock(page, wide, 'รวมทั้งองค์กร').locator('xpath=..')
    const edges = await list.evaluate((root) =>
      Array.from(root.querySelectorAll('dd.money'))
        .filter((dd) => (dd as HTMLElement).offsetParent !== null)
        .flatMap((dd) => {
          const walker = document.createTreeWalker(dd, NodeFilter.SHOW_TEXT)
          let amount: Node | null = walker.nextNode()
          while (amount && !/\d\.\d\d$/.test((amount.textContent ?? '').trim())) amount = walker.nextNode()
          if (!amount) return []
          const range = document.createRange()
          range.selectNodeContents(amount)
          return [range.getBoundingClientRect().right]
        }),
    )
    expect(edges.length).toBeGreaterThan(10)
    expect(Math.max(...edges) - Math.min(...edges)).toBeLessThanOrEqual(1.5)
  }
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'budgets-dashboard')

  // AC2 on a department's total: its reserved amount opens the documents of all its lines, each naming its line
  await totalBlock(page, wide, 'รวมฝ่ายบัญชีและการเงิน').getByRole('link', { name: `จอง ${s.figures.fin.reserved} บาท ของ ฝ่ายบัญชีและการเงิน: ดูเอกสาร` }).click()
  await expect(page).toHaveURL(/\/budgets\/departments\/[0-9a-f-]+\?fy=[0-9a-f-]+#reserved$/)
  await expect(page.getByRole('heading', { level: 1, name: 'รวมฝ่ายบัญชีและการเงิน' })).toBeVisible()
  await expectStrip(page, 'ยอดรวมของบรรทัดงบเหล่านี้', s.figures.fin)
  const finReserved = page.getByRole('region', { name: 'เอกสารที่จองงบ' })
  const finRequest = finReserved.getByRole('listitem').filter({ hasText: s.reserved.number })
  await expect(finRequest).toContainText(`บรรทัดงบ ${s.line.code}`)
  await expect(finRequest).toContainText('18,500.00')
  await expect(finReserved).toContainText(`รวม ${s.figures.fin.reserved} บาท`)
  await expect(page.getByRole('region', { name: 'ใบสั่งซื้อที่ถืองบ' }).getByRole('link', { name: `ใบสั่งซื้อ ${s.po.number}` })).toHaveAttribute('href', `/procurement/pos/${s.po.id}`)
  await expect(page.getByRole('region', { name: 'ใบสั่งซื้อที่ถืองบ' })).toContainText(`รวม ${s.figures.fin.committed} บาท`)
  await expect(page.getByRole('region', { name: 'ตัดจ่ายจริงจากใบกำกับ' })).toContainText(`รวม ${s.figures.fin.actual} บาท`)
  await expect(page.getByRole('region', { name: 'การนำเข้าที่รวมเป็นงบตั้งต้น' })).toContainText(`รวม ${s.figures.fin.planned} บาท`)
  // Every movement of the department's lines names its line
  const finMovements = page.getByRole('list', { name: 'ความเคลื่อนไหวในบัญชีงบ' })
  await expect(finMovements.getByRole('link', { name: `บรรทัดงบ ${s.line.code}` }).first()).toBeVisible()
  await expectAmountsAtTheRight(finReserved.getByRole('list', { name: 'เอกสารที่จองงบ' }))
  await expectAmountsAtTheRight(finMovements)
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'budgets-department')

  // AC2 on the total: what the whole organization's amounts are made of
  await page.getByRole('link', { name: 'กลับไปหน้างบประมาณ' }).click()
  await totalBlock(page, wide, 'รวมทั้งองค์กร').getByRole('link', { name: `ถือ ${s.figures.total.committed} บาท ของ ทั้งองค์กร: ดูเอกสาร` }).click()
  await expect(page).toHaveURL(/\/budgets\/total\?fy=[0-9a-f-]+#committed$/)
  await expect(page.getByRole('heading', { level: 1, name: 'รวมทั้งองค์กร' })).toBeVisible()
  await expectStrip(page, 'ยอดรวมของบรรทัดงบเหล่านี้', s.figures.total)
  for (const [section, amount] of [
    ['การนำเข้าที่รวมเป็นงบตั้งต้น', s.figures.total.planned],
    ['เอกสารที่จองงบ', s.figures.total.reserved],
    ['ใบสั่งซื้อที่ถืองบ', s.figures.total.committed],
    ['ตัดจ่ายจริงจากใบกำกับ', s.figures.total.actual],
  ] as const) {
    await expect(page.getByRole('region', { name: section }), section).toContainText(`รวม ${amount} บาท`)
  }
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'budgets-total')

  // AC2 on the line: the reserved amount goes to the documents that reserve it
  await page.getByRole('link', { name: 'กลับไปหน้างบประมาณ' }).click()
  await lineBlock(page, wide, s.line.code).getByRole('link', { name: `จอง ${s.figures.line.reserved} บาท ของ ${s.line.code}: ดูเอกสาร` }).click()
  await expect(page).toHaveURL(new RegExp(`/budgets/${s.line.id}#reserved$`))
  await expect(page.getByRole('heading', { level: 1, name: s.line.name })).toBeVisible()
  // The shares and the warning of the line lead further down the same page, to what makes them up
  for (const [name, section] of [
    [`ใช้แล้ว 45.0% ของ ${s.line.code}: ดูเอกสารที่ถือและตัดจ่ายจริง`, 'committed'],
    [`รวมที่จองแล้ว 91.3% ของ ${s.line.code}: ดูเอกสารที่จอง ถือ และตัดจ่ายจริง`, 'reserved'],
    [`ใกล้หมด เหลือ 8.7% ของ ${s.line.code}: ดูความเคลื่อนไหวในบัญชีงบ`, 'movements'],
  ] as const) {
    await expect(page.getByRole('link', { name, exact: true }), name).toHaveAttribute('href', `#${section}`)
  }
  const reserved = page.getByRole('region', { name: 'เอกสารที่จองงบ' })
  await expect(reserved.getByRole('listitem').filter({ hasText: s.reserved.number })).toContainText('18,500.00')
  await expect(reserved).toContainText(`รวม ${s.figures.line.reserved} บาท`)
  const committed = page.getByRole('region', { name: 'ใบสั่งซื้อที่ถืองบ' })
  await expect(committed.getByRole('link', { name: `ใบสั่งซื้อ ${s.po.number}` })).toHaveAttribute('href', `/procurement/pos/${s.po.id}`)
  await expect(committed).toContainText('ส่งผู้ขายแล้ว')
  await expect(committed).toContainText(`รวม ${s.figures.line.committed} บาท`)
  const actual = page.getByRole('region', { name: 'ตัดจ่ายจริงจากใบกำกับ' })
  const invoices = actual.getByRole('list', { name: `ใบกำกับของ ${s.po.number}` })
  await expect(invoices).toContainText(`ใบกำกับ ${s.invoiceNo} ลงวันที่`)
  await expect(actual).toContainText(`รวม ${s.figures.line.actual} บาท`)
  // The planned amount leads to the import behind it, the available amount to the movements
  await page.getByRole('link', { name: `งบปัจจุบัน ${s.figures.line.planned} บาท ของ ${s.line.code}: ดูการนำเข้างบ` }).click()
  await expect(page).toHaveURL(new RegExp(`/budgets/${s.line.id}#planned$`))
  const planned = page.getByRole('region', { name: 'การนำเข้าที่รวมเป็นงบตั้งต้น' })
  await expect(planned.getByRole('listitem').filter({ hasText: `ไฟล์ ${s.line.code}.xlsx` })).toContainText(s.figures.line.planned)
  await page.getByRole('link', { name: `คงเหลือ ${s.figures.line.available} บาท ของ ${s.line.code}: ดูความเคลื่อนไหวในบัญชีงบ` }).click()
  await expect(page).toHaveURL(new RegExp(`/budgets/${s.line.id}#movements$`))
  // Import, two reservations, the PO approved (reservation given back, budget committed) and the invoice
  const movements = page.getByRole('region', { name: 'ความเคลื่อนไหวในบัญชีงบ' })
  await expect(movements).toContainText('ทั้งหมด 6 รายการ')
  // Each cell names its column for screen readers ("รายการ: …")
  for (const what of ['นำเข้างบ', 'จองงบ', 'คืนการจอง', 'ถืองบ', 'ตัดจ่ายจริง']) await expect(movements.getByText(new RegExp(`^รายการ: ${what}$`)).first()).toBeVisible()
  // Money sits at the right edge of each row, on a phone as on a wide screen (§9.9 rule 6)
  await expectAmountsAtTheRight(movements.getByRole('list', { name: 'ความเคลื่อนไหวในบัญชีงบ' }))
  await expectAmountsAtTheRight(invoices)
  await expectAmountsAtTheRight(reserved.getByRole('list', { name: 'เอกสารที่จองงบ' }))
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'budgets-line')

  // A document links to its own page for whoever may open it (EXECUTIVE: request.view ORG)
  await reserved.getByRole('link', { name: `คำขอ ${s.reserved.number}` }).click()
  await expect(page).toHaveURL(new RegExp(`/requests/${s.reserved.id}$`))
  await expect(page.getByRole('heading', { level: 1 })).toContainText('กระดาษและแฟ้มสำหรับทดสอบงบ')

  // The Excel file holds what the page shows
  await page.goto('/budgets')
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: `ส่งออก Excel ของปีงบ ${s.fiscalYear.code}` }).click()
  const file = await readFile((await (await download).path())!)
  const rows = await sheetRows(file)
  const header = rows.findIndex((r) => r[0] === 'ประเภทแถว')
  expect(rows[header]).toHaveLength(BUDGET_EXPORT_COLUMNS.length)
  const cell = (row: string[], column: (typeof BUDGET_EXPORT_COLUMNS)[number]) => row[BUDGET_EXPORT_COLUMNS.indexOf(column)]
  const exported = rows.find((r) => cell(r, 'lineCode') === s.line.code)!
  const plain = (amount: string) => amount.replace(/,/g, '')
  expect(['planned', 'available', 'reserved', 'committed', 'actual', 'heldPct', 'availablePct', 'low'].map((c) => cell(exported, c as (typeof BUDGET_EXPORT_COLUMNS)[number]))).toEqual([
    plain(s.figures.line.planned),
    plain(s.figures.line.available),
    plain(s.figures.line.reserved),
    plain(s.figures.line.committed),
    plain(s.figures.line.actual),
    '91.25',
    '8.75',
    'ใกล้หมด',
  ])
  const totalRow = rows.find((r) => cell(r, 'kind') === 'รวมทั้งหมด')!
  expect(cell(totalRow, 'planned')).toBe(plain(s.figures.total.planned))

  // AC3: a request approved now is on the page at the next read, with no delay
  const more = scene<{ line: Figures }>('reserve', s.requester.code, s.line.id, '1000.00')
  expect(more.line.reserved).toBe('19,500.00')
  await page.getByRole('link', { name: 'ดูตัวเลขล่าสุด' }).click()
  await expectFigures(lineBlock(page, wide, s.line.code), wide, more.line)
})

test('[FR-BUD-005/AC1] [FR-BUD-005/AC2] a department head sees the budgets of the departments they head and what makes them up, and a requester is refused', async ({ page }, testInfo) => {
  // Two sign-ins, several pages, axe and a screenshot at each state: longer than the default 30 s
  test.slow()
  const mobile = testInfo.project.name === 'mobile'
  const [head, department] = mobile ? ['dm_proc', 'ฝ่ายจัดซื้อ'] : ['dm_it', 'ฝ่ายไอที']
  await signIn(page, `${head}@demo.bcs.local`, head)
  await page.goto('/budgets')
  await expect(page.getByText(/· แผนกที่คุณดูแล$/)).toBeVisible()
  await expect(totalBlock(page, !mobile, `รวม${department}`)).toBeVisible()
  await expect(totalBlock(page, !mobile, 'รวมแผนกที่คุณดูแล')).toBeVisible()
  // No other department's line, and no import or grants for a head
  await expect(page.getByText(/^FIN-/)).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'นำเข้างบจาก Excel' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'สิทธิ์ใช้งบข้ามฝ่าย' })).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'budgets-department-head')

  // An old or cut link to a fiscal year that is not found: plain information in --info, never the --warn of what is
  // pending or nearly due (§9.9 token table), with the way to the current fiscal year
  await page.goto(`/budgets?fy=${randomUUID()}`)
  const notFound = page.getByRole('status').filter({ hasText: 'ไม่พบปีงบที่เลือก' })
  await expect(notFound).toHaveClass(/\bborder-info\b/)
  await expect(notFound).not.toHaveClass(/\bborder-warn\b/)
  await page.getByRole('link', { name: 'ดูปีงบปัจจุบัน', exact: true }).click()
  await expect(page.getByText(/· แผนกที่คุณดูแล$/)).toBeVisible()

  // The department's own page: its amounts, and the initial budget behind the planned amount
  await totalBlock(page, !mobile, `รวม${department}`).getByRole('link', { name: `รวม${department}`, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: `รวม${department}` })).toBeVisible()
  await expect(page.getByText(/^ปีงบ FY\d{4} \(.+ ถึง .+\)$/)).toBeVisible()
  await expect(page.getByRole('region', { name: 'การนำเข้าที่รวมเป็นงบตั้งต้น' }).getByRole('listitem').first()).toBeVisible()
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'budgets-head-department')

  await page.context().clearCookies()
  await signIn(page, `${mobile ? 'req_con2' : 'req_it'}@demo.bcs.local`, null)
  await page.goto('/budgets')
  await expect(page.getByText('หน้างบประมาณสำหรับหัวหน้าแผนก ฝ่ายบัญชีและการเงิน ผู้ดูแลงบ ผู้บริหาร และผู้ตรวจสอบ', { exact: false })).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  await page.goto('/budgets/total')
  await expect(page.getByText('หน้างบประมาณสำหรับหัวหน้าแผนก ฝ่ายบัญชีและการเงิน ผู้ดูแลงบ ผู้บริหาร และผู้ตรวจสอบ', { exact: false })).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'budgets-refused')

  // §9.9 rule 7: the Excel link followed by an account the budget pages are not for (e.g. its role was taken away after
  // the dashboard loaded) leads back to the dashboard, which says the refusal in words with its way on — never a failed
  // download the browser names in its own words. A call that is not a navigation still gets the code
  await page.goto('/budgets/export')
  await expect(page).toHaveURL(/\/budgets$/)
  await expect(page.getByText('หน้างบประมาณสำหรับหัวหน้าแผนก ฝ่ายบัญชีและการเงิน ผู้ดูแลงบ ผู้บริหาร และผู้ตรวจสอบ', { exact: false })).toBeVisible()
  await expect(page.getByRole('link', { name: 'กลับหน้าแรก' })).toBeVisible()
  const call = await page.request.get('/budgets/export', { maxRedirects: 0 })
  expect(call.status()).toBe(403)
  expect(await call.json()).toEqual({ code: 'FORBIDDEN' })
})
