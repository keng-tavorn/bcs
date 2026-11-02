import { type Page } from '@playwright/test'
import { castOf, expectNoBlockingAxe, expectNoSideways, fixture, PIN_LABEL, shot, signIn, stepUpFixture } from './tasks-support'
import { expect, test } from './fixtures'

// ADR-076: the route on the document page is a map of boxes on a computer's screen, dragged and zoomed, and the long line
// of cards on a phone. The box of the reader's own open task has the decide buttons; they open the decision bar's own
// confirmation, so the second press, the PIN and the reason stay, and the same service decides. tasks-fixtures.ts makes
// the documents through the services; screenshots at 1440 and 375 px and axe on every screen (§9.9 steps 4–5).

type Created = { requestId: string; number: string; taskId: string }

const steps = (page: Page) => page.getByRole('list', { name: 'ขั้นอนุมัติ' })
const bar = (page: Page) => page.getByRole('region', { name: 'ตัดสินงานนี้' })
const current = (page: Page) => steps(page).locator('[aria-current="step"]')
const viewport = (page: Page) => page.locator('.react-flow__viewport').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform))

test('[FR-INT-012/AC3] a computer shows the route as a map that is dragged and zoomed; a phone keeps the long line of cards', async ({ page }, testInfo) => {
  test.slow()
  const cast = castOf(testInfo)
  const created = fixture<Created>('request', cast.requester, '21500.00', 'flow-map')
  await signIn(page, cast.approver, true)
  const scripts: string[] = []
  page.on('response', (response) => {
    if (response.url().includes('/_next/static/')) scripts.push(response.url())
  })
  await page.goto(`/requests/${created.requestId}`)
  await expect(current(page)).toContainText(cast.approverName)

  if (testInfo.project.name === 'mobile') {
    await expect(page.locator('[data-step-flow]')).toHaveCount(0)
    await expect(steps(page).getByRole('listitem').first()).toContainText(cast.approverName)
    // A phone never fetches the map or its library: the box's words reach it in no script at all
    await page.waitForLoadState('networkidle')
    const bodies = await Promise.all(scripts.filter((u) => u.endsWith('.js')).map((u) => page.request.get(u).then((r) => r.text())))
    expect(bodies.some((body) => body.includes('react-flow__viewport'))).toBe(false)
    await expectNoSideways(page)
    await shot(page, testInfo, 'step-flow-phone')
    return
  }

  const map = page.locator('[data-step-flow]')
  await expect(map).toBeVisible()
  await expect(map.locator('.react-flow__attribution')).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'step-flow-map')

  // Dragged: the canvas moves; the boxes themselves stay where the route puts them (NG-4)
  const before = await viewport(page)
  await map.scrollIntoViewIfNeeded()
  const pane = await map.boundingBox()
  await page.mouse.move(pane!.x + pane!.width - 60, pane!.y + pane!.height - 20)
  await page.mouse.down()
  await page.mouse.move(pane!.x + pane!.width - 160, pane!.y + pane!.height - 60, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await viewport(page)).e).toBeLessThan(before.e)
  const box = page.locator('.react-flow__node').first()
  await expect(box).not.toHaveClass(/draggable/)

  // Zoomed with its buttons, and fitted back to no more than full size
  await page.getByRole('button', { name: 'ซูมออก' }).click()
  await expect.poll(async () => (await viewport(page)).a).toBeLessThan(1)
  await page.getByRole('button', { name: 'ซูมเข้า' }).click()
  await page.getByRole('button', { name: 'ซูมเข้า' }).click()
  await expect.poll(async () => (await viewport(page)).a).toBeGreaterThan(1)
  await page.getByRole('button', { name: 'ดูทั้งผัง' }).click()
  await expect.poll(async () => (await viewport(page)).a).toBeLessThanOrEqual(1)

  // The wheel keeps scrolling the page: the map does not trap it
  await page.setViewportSize({ width: 1440, height: 500 })
  await map.hover()
  const scrolled = await page.evaluate(() => window.scrollY)
  await page.mouse.wheel(0, 300)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrolled)
  await page.setViewportSize({ width: 1440, height: 900 })

  // A press on a box opens the step's panel; a drag that starts on it does not
  await current(page).getByRole('button', { name: /ดูประวัติของขั้นนี้/ }).click()
  const panel = page.getByRole('dialog')
  await expect(panel.getByRole('heading', { name: /^ขั้นที่ 1/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await current(page).scrollIntoViewIfNeeded()
  const shown = await current(page).boundingBox()
  const from = await viewport(page)
  await page.mouse.move(shown!.x + shown!.width / 2, shown!.y + 20)
  await page.mouse.down()
  await page.mouse.move(shown!.x + shown!.width / 2 + 40, shown!.y + 40, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await viewport(page)).e).toBeGreaterThan(from.e)
  await expect(panel).toHaveCount(0)

  // The line of cards comes back when the window is narrow, with the same words
  await page.setViewportSize({ width: 800, height: 900 })
  await expect(map).toHaveCount(0)
  await expect(current(page)).toContainText(cast.approverName)
})

test('[FR-INT-012/AC4] the approver decides from the box of their step: the same second press and service as the bar; others see no buttons', async ({ page }, testInfo) => {
  test.slow()
  const cast = castOf(testInfo)
  const created = fixture<Created>('request', cast.requester, '21500.00', 'flow-decide')

  // A phone has no map: it decides on the bar, fixed to the bottom of the screen, and no box has buttons
  if (testInfo.project.name === 'mobile') {
    await signIn(page, cast.approver, true)
    await page.goto(`/requests/${created.requestId}`)
    await expect(bar(page).getByRole('button', { name: 'อนุมัติ', exact: true })).toBeVisible()
    await expect(page.locator('[data-box-decide]')).toHaveCount(0)
    await expect(page.locator('[data-step-flow]')).toHaveCount(0)
    return
  }

  // The requester reads the same map without any button on it
  await signIn(page, cast.requester, false)
  await page.goto(`/requests/${created.requestId}`)
  await expect(current(page)).toContainText(cast.approverName)
  await expect(page.locator('[data-box-decide]')).toHaveCount(0)
  await page.context().clearCookies()

  await signIn(page, cast.approver, true)
  await page.goto(`/requests/${created.requestId}`)
  const box = current(page)
  await expect(box.locator('[data-box-decide]')).toBeVisible()
  // The one who decides reads the items without changing tabs (§9.9 principle 5); the requester above reads them in their tab
  await expect(page.getByRole('heading', { name: 'รายการ', exact: true })).toBeVisible()
  await shot(page, testInfo, 'step-flow-decide')

  // Rejecting from the box's menu asks for the reason in the bar's dialog
  await box.getByRole('button', { name: 'ตัดสินแบบอื่น' }).click()
  await expect(page.getByRole('menuitem')).toHaveText(['ขอข้อมูลเพิ่ม', 'ตีกลับให้แก้', 'ไม่อนุมัติ'])
  await page.getByRole('menuitem', { name: 'ไม่อนุมัติ' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('heading', { name: 'ไม่อนุมัติ' })).toBeVisible()
  await dialog.getByRole('button', { name: 'ไม่อนุมัติคำขอนี้' }).click()
  await expect(dialog).toContainText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')
  await dialog.getByRole('button', { name: 'กลับไปตรวจก่อน' }).click()
  await expect(dialog).toHaveCount(0)

  // Approving asks a second time, naming the document and the amount; going back decides nothing
  await box.getByRole('button', { name: /^อนุมัติ ขั้นที่ 1/ }).click()
  await expect(dialog).toContainText(`อนุมัติ ${created.number} ยอดรวม VAT 21,500.00 บาท`)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'step-flow-confirm')
  await dialog.getByRole('button', { name: 'กลับไปตรวจก่อน' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(bar(page)).toBeVisible()

  // The answer does not come back: the dialog stays and says so where the reader pressed, and the same press tries again
  const action = `**/requests/${created.requestId}`
  await page.route(action, (route) => (route.request().method() === 'POST' ? route.abort('connectionreset') : route.continue()))
  await box.getByRole('button', { name: /^อนุมัติ ขั้นที่ 1/ }).click()
  await dialog.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(bar(page).getByRole('alert')).toHaveCount(0)
  await page.unroute(action)
  await dialog.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(page.getByText('อนุมัติแล้ว', { exact: true }).first()).toBeVisible()
  await expect(dialog).toHaveCount(0)

  // The box is a stamp now, with no buttons, and the bar is gone: it was decided once, by the service
  await expect(bar(page)).toHaveCount(0)
  await expect(page.locator('[data-box-decide]')).toHaveCount(0)
  const stamp = steps(page).getByRole('listitem').first()
  await expect(stamp).toContainText(cast.approverName)
  await expect(stamp).toContainText(/\d{1,2} \S+ 25\d\d \d\d:\d\d น\. · เว็บ/)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'step-flow-stamped')
})

test('[FR-INT-012/AC4] an amount at the step-up threshold asks for the PIN from the box too', async ({ page }, testInfo) => {
  test.slow()
  const cast = castOf(testInfo)
  const made = stepUpFixture<{ requestId: string; number: string }>('at-threshold', cast.requester)
  await signIn(page, cast.approver, true)
  await page.goto(`/requests/${made.requestId}`)
  // A phone asks for it on the bar, as it always did (tests/e2e/tasks.spec.ts)
  if (testInfo.project.name === 'mobile') {
    await expect(bar(page)).toContainText('PIN')
    return
  }
  await current(page).getByRole('button', { name: /^อนุมัติ ขั้นที่ 1/ }).click()
  const dialog = page.getByRole('alertdialog')
  const pin = dialog.getByLabel(PIN_LABEL)
  await expect(pin).toBeVisible()
  await dialog.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(dialog.getByText('ใส่ PIN ตัวเลข 6 หลัก')).toBeVisible()
  // A wrong PIN is told at its field and approves nothing; the dialog stays
  await pin.fill('480263')
  await dialog.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(dialog).toContainText(/PIN/)
  await expect(pin).toHaveValue('')
  await dialog.getByRole('button', { name: 'กลับไปตรวจก่อน' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(bar(page)).toBeVisible()
  // The tries used are this approver's: leave them as the other scenes expect
  stepUpFixture('pin-unlock', cast.approver)
})
