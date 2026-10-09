import { E2E_BASE_URL } from '../support/e2e-env'
import { expectNoBlockingAxe, expectNoSideways, scene, shot, signIn, thaiDay, type AdminScene } from './budgets-support'
import { expect, test } from './fixtures'

// S3-07 · FR-BUD-004 AC1 (BR-BUD-04): BUDGET_ADMIN lets one member, and then a whole department, use a budget line of
// another department for whole days, and takes a grant back; the member granted then finds the line in the request
// form. Each project has its own budget administrator, member and line (tests/e2e/budgets-scene.ts); the department
// grant starts tomorrow and is taken back, so no other spec's request form ever offers the line.

test('[FR-BUD-004/AC1] [FR-INT-003/AC2] BUDGET_ADMIN grants a line to one member and to a department for whole days, takes a grant back, and the member granted is offered the line', async ({ page, browser, clientIp }, testInfo) => {
  // A scene of its own, several pages, axe and a screenshot at each state: longer than the default 30 s
  test.slow()
  const s = scene<AdminScene>('admin', testInfo.project.name)
  await signIn(page, s.budgetAdmin.email, s.budgetAdmin.code)
  await page.goto('/budgets')
  await page.getByRole('link', { name: 'สิทธิ์ใช้งบข้ามฝ่าย' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'สิทธิ์ใช้งบข้ามฝ่าย' })).toBeVisible()

  // Nothing chosen: each field says what it needs
  const grant = page.getByRole('button', { name: 'ให้สิทธิ์ใช้งบ', exact: true })
  await grant.click()
  await expect(page.getByText('เลือกบรรทัดงบที่จะให้สิทธิ์')).toBeVisible()
  await expect(page.getByText('เลือกแผนกที่ได้สิทธิ์')).toBeVisible()
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'budgets-grants-errors')

  // To one member: the last day starts at the end of the line's fiscal year
  const lineOption = `${s.line.code} · ${s.line.name} (งบของฝ่ายบัญชีและการเงิน)`
  await page.getByLabel('บรรทัดงบ', { exact: true }).selectOption({ label: lineOption })
  await expect(page.getByLabel('วันสุดท้าย (รวมวันนั้น)')).toHaveValue(s.fiscalYear.endsOn)
  await page.getByLabel('สมาชิกรายคน').check()
  await page.getByLabel('สมาชิกที่ได้สิทธิ์').selectOption({ label: `${s.member.name} (${s.member.code}) · ฝ่ายก่อสร้าง` })
  await expect(page.getByText(/^สิทธิ์มีผล \d{1,2} .+ \d{4} ถึง \d{1,2} .+ \d{4} ตามเวลาประเทศไทย$/)).toBeVisible()
  await grant.click()
  await expect(page.getByRole('status').filter({ hasText: `ให้สิทธิ์ใช้งบ ${s.line.code} กับ ${s.member.name}` })).toBeVisible()
  const current = page.getByRole('list', { name: 'สิทธิ์ที่มีผลและที่จะเริ่ม' })
  const memberRow = current.getByRole('listitem').filter({ hasText: `${s.member.name} (${s.member.code})` })
  await expect(memberRow).toContainText(s.line.code)
  await expect(memberRow).toContainText('มีผลอยู่')

  // To a whole department from tomorrow: the department that owns the line is not offered
  await page.getByLabel('บรรทัดงบ', { exact: true }).selectOption({ label: lineOption })
  await page.getByLabel('ทั้งแผนก').check()
  const department = page.getByLabel('แผนกที่ได้สิทธิ์')
  await expect(department.locator('option', { hasText: 'ฝ่ายบัญชีและการเงิน (FIN)' })).toHaveCount(0)
  await department.selectOption({ label: 'ฝ่ายจัดซื้อ (PROC)' })
  await page.getByLabel('วันเริ่ม', { exact: true }).fill(thaiDay(1))
  await page.getByLabel('วันสุดท้าย (รวมวันนั้น)').fill(thaiDay(8))
  await grant.click()
  await expect(page.getByRole('status').filter({ hasText: `ให้สิทธิ์ใช้งบ ${s.line.code} กับ ฝ่ายจัดซื้อ` })).toBeVisible()
  const departmentRow = current.getByRole('listitem').filter({ hasText: 'ทั้งฝ่ายจัดซื้อ' }).filter({ hasText: s.line.code })
  await expect(departmentRow).toContainText('รอเริ่ม')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'budgets-grants-list')

  // Taking it back asks for a tick first; it then moves to the grants that have ended
  await departmentRow.getByRole('button', { name: 'ยกเลิกสิทธิ์ของ ทั้งฝ่ายจัดซื้อ' }).click()
  await departmentRow.getByRole('button', { name: 'ยืนยันยกเลิกสิทธิ์' }).click()
  await expect(departmentRow.getByText('ติ๊กช่องยืนยันก่อนยกเลิกสิทธิ์')).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'budgets-grants-revoke')
  await departmentRow.getByRole('checkbox').check()
  await departmentRow.getByRole('button', { name: 'ยืนยันยกเลิกสิทธิ์' }).click()
  await expect(page.getByRole('status').filter({ hasText: `ยกเลิกสิทธิ์ใช้งบ ${s.line.code} · ${s.line.name} ของ ทั้งฝ่ายจัดซื้อ แล้ว` })).toBeVisible()
  const past = page.getByRole('list', { name: 'สิทธิ์ที่สิ้นสุดแล้ว' })
  await expect(past.getByRole('listitem').filter({ hasText: 'ทั้งฝ่ายจัดซื้อ' }).filter({ hasText: s.line.code })).toContainText('ยกเลิกแล้ว')
  await expect(current.getByRole('listitem').filter({ hasText: 'ทั้งฝ่ายจัดซื้อ' }).filter({ hasText: s.line.code })).toHaveCount(0)

  // The member granted now finds the line in their request form, marked as granted (BR-BUD-04)
  const context = await browser.newContext({ ...testInfo.project.use, baseURL: E2E_BASE_URL, extraHTTPHeaders: { 'x-forwarded-for': clientIp } })
  const memberPage = await context.newPage()
  await signIn(memberPage, s.member.email, null)
  await memberPage.goto('/requests/new/BUY_GOODS')
  // The budget line is chosen on the step of items, prices and budget (FR-INT-011, §9.10)
  await memberPage.getByLabel('ชื่อคำขอ').fill('ตรวจบรรทัดงบที่ได้รับสิทธิ์')
  await memberPage.getByRole('button', { name: 'ถัดไป: รายการ ราคา และงบ', exact: true }).click()
  const options = await memberPage.getByLabel('บรรทัดงบที่ใช้').locator('option').allTextContents()
  expect(options).toContain(`${s.line.code} · ${s.line.name} (งบของฝ่ายบัญชีและการเงิน ได้รับสิทธิ์ใช้)`)
  await context.close()
})

test('[FR-BUD-004/AC1] only BUDGET_ADMIN manages grants', async ({ page }, testInfo) => {
  const s = scene<AdminScene>('admin', testInfo.project.name)
  await signIn(page, s.member.email, null)
  await page.goto('/budgets/grants')
  await expect(page.getByRole('heading', { level: 1, name: 'สิทธิ์ใช้งบข้ามฝ่าย' })).toBeVisible()
  await expect(page.getByText('หน้าสิทธิ์ใช้งบข้ามฝ่ายสำหรับผู้ดูแลงบเท่านั้น', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ให้สิทธิ์ใช้งบ', exact: true })).toHaveCount(0)
})
