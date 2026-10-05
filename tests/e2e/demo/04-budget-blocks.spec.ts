import { devices } from '@playwright/test'
import { expect, test } from '../fixtures'

// Demo scene 4 "งบไม่พอ ไม่ถึงผู้อนุมัติ" (sheet Demo_Script; runbook §4): the row's requester asks in LIFF for a backup
// server of the row's amount on the row's budget line, which the demo history has nearly used up. The form shows what
// is left on the line and by how much the request is short — both worked out from the workbook, never typed in: what
// sheet Budget leaves on the line (which the database must hold) and the row's amount before VAT, the figures the row's
// steps have the presenter say — and the send button stays off with the reason; no request reaches an approver (G-4).
// At 375 px, every page checked and photographed. ./support.ts is imported inside the test: to the demo project every
// file of this folder is a test file (see there).

// The phone of LIFF at 375 px (§9.4): a Pixel 7 without its defaultBrowserType, a worker option that would give this file
// a worker of its own — Playwright runs each worker's files together, and the scenes must run in the files' name order
const { defaultBrowserType, ...pixel7 } = devices['Pixel 7']
test.use({ ...pixel7, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

test('@demo [FR-INT-004/AC1] [FR-INT-004/AC2] [FR-BUD-003/AC1] [FR-INT-007/AC2] scene 4: a request above what is left on its budget line shows the balance and the shortfall in LIFF, cannot be sent, and reaches no approver', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(240_000)
  const {
    amountOf,
    availableOf,
    baht,
    budgetLeftNow,
    chargedDepartmentOf,
    checkLiffScreen,
    chosenIn,
    countsNow,
    demoSheet,
    fillLine,
    literally,
    nameIn,
    nextStep,
    openLiffAs,
    prepareTheDay,
    remainingOf,
    richMenuButtonOf,
    richMenuPath,
    sceneOf,
    spokenBaht,
    stepHeading,
    th,
    typed,
  } = await import('./support')
  const sheet = await demoSheet()
  const scene = sceneOf(sheet, 4)
  expect(scene.channel).toBe('LIFF')
  expect(scene.expectedOutcome).toBe('BLOCKED')
  const [net, vat, gross] = [amountOf(scene, 'net'), amountOf(scene, 'vat'), amountOf(scene, 'gross')]
  const typeName = nameIn(sheet.requestTypes, scene.requestType, 'request type')
  const lineName = nameIn(sheet.budgetLines, scene.budgetLine, 'budget line')
  const siteName = nameIn(sheet.sites, scene.site, 'site')

  prepareTheDay(sheet)
  // What is left on the line — what sheet Budget leaves on it after the history, which the database holds — and what the
  // row's amount before VAT lacks (the budget counts before VAT, BR-BUD-03); the row's steps say the same figures
  const available = budgetLeftNow(sheet, scene)
  const shortfall = net - available
  expect(shortfall, `the row's amount is above what is left on ${scene.budgetLine}`).toBeGreaterThan(0n)
  for (const said of [net, available, shortfall]) expect(scene.stepsTh, `the steps of the scene say ${spokenBaht(said)}`).toContain(spokenBaht(said))
  const before = countsNow()

  await openLiffAs(context, scene.actor)
  await page.goto(await richMenuPath(scene.actor, richMenuButtonOf(sceneOf(sheet, 1))))
  await expect(page.getByRole('heading', { level: 1, name: 'ขอซื้อ / ขอจ้าง' })).toBeVisible()
  await checkLiffScreen(page, testInfo, 'scene4-catalog')
  await page.getByRole('link', { name: new RegExp(`เริ่มคำขอ ${literally(typeName)}$`) }).click()
  await expect(page).toHaveURL(new RegExp(`/liff/requests/new/${scene.requestType}$`))
  await expect(stepHeading(page, 1, 'details', 3)).toBeVisible()
  // The row's budget line — the department's only one, so the form chose it — with what is left on it
  const budgetLine = page.getByLabel(th('requestForm.budget.line'))
  if ((await chosenIn(page, th('requestForm.budget.line')).textContent()) !== `${scene.budgetLine} · ${lineName}`) await budgetLine.selectOption({ label: `${scene.budgetLine} · ${lineName}` })
  await expect(chosenIn(page, th('requestForm.budget.line'))).toHaveText(`${scene.budgetLine} · ${lineName}`)
  await expect(chargedDepartmentOf(page)).toHaveText(nameIn(sheet.departments, scene.chargedDept, 'department'))
  await expect(remainingOf(page)).toContainText(th('requestForm.budget.baht', { amount: baht(available) }))
  await page.getByLabel(th('requestForm.details.title')).fill('เซิร์ฟเวอร์สำรองข้อมูล')
  // The questions of the IT form: hardware, and no personal data, systems or premises for the supplier
  await page.getByRole('radio', { name: 'ฮาร์ดแวร์' }).check()
  for (const question of [/ประมวลผลข้อมูลส่วนบุคคล/, /เข้าถึงระบบหรือข้อมูลภายใน/, /เข้าพื้นที่ทำงาน/]) {
    await page.getByRole('group', { name: question }).getByRole('radio', { name: 'ไม่ใช่' }).check()
  }
  await checkLiffScreen(page, testInfo, 'scene4-form-details')

  await nextStep(page, 'items')
  await page.getByLabel(th('requestForm.site.label')).selectOption({ label: `${scene.site} · ${siteName}` })
  await fillLine(page.getByRole('group', { name: 'รายการที่ 1', exact: true }), { description: 'เซิร์ฟเวอร์สำรองข้อมูล', quantity: '1', uom: 'เครื่อง', price: typed(net) })
  // The row's amounts before VAT, the VAT and with VAT
  for (const amount of [net, vat, gross]) await expect(page.getByText(th('requestForm.totals.baht', { amount: baht(amount) })).first()).toBeVisible()
  // FR-INT-004 AC1: not enough, by how much, at once
  await expect(page.getByText(th('requestForm.budget.short', { shortfall: baht(shortfall) }))).toBeVisible()
  await checkLiffScreen(page, testInfo, 'scene4-form-items')

  await nextStep(page, 'review')
  await expect(stepHeading(page, 3, 'review', 3)).toBeVisible()
  // FR-INT-004 AC2, FR-BUD-003 AC1: the button says why — what is left and what is lacking — and cannot send
  const send = page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true })
  await expect(send).toBeDisabled()
  await expect(page.getByText(th('requestForm.submit.blockedBudget', { available: baht(available), shortfall: baht(shortfall) }))).toBeVisible()
  // The row's "ส่งไม่ได้", said the same way on the step (§9.9 principle 3): "ตรวจก่อนส่ง" leads with what stops the
  // button — the budget, with what is left and what is lacking, to be fixed before sending — and never says
  // "…ครบแล้ว กดส่งได้" (review.ready) while the budget blocks sending
  const beforeSending = page.getByRole('region', { name: th('requestForm.review.problemsTitle') })
  await expect(beforeSending).toBeVisible()
  await expect(beforeSending.getByRole('listitem').first()).toHaveText(`${th('requestForm.review.budgetShort', { available: baht(available), shortfall: baht(shortfall) })} ${th('requestForm.review.mustFix')}`)
  await expect(beforeSending, 'the review step does not say the request can be sent while the budget blocks it').not.toContainText(th('requestForm.review.ready'))
  await checkLiffScreen(page, testInfo, 'scene4-form-review')

  // FR-INT-007 AC2 (G-4): nothing was sent, no approver got a task or a notice, and the line keeps what it had
  expect(countsNow()).toEqual(before)
  expect(availableOf(scene.budgetLine!)).toBe(available)
})
