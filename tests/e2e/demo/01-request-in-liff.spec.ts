import { devices } from '@playwright/test'
import { expect, test } from '../fixtures'
import type { FormLine } from './support'

// Demo scene 1 "ขอซื้อจาก LINE ในหนึ่งนาที" (sheet Demo_Script; docs/DEMO_RUNBOOK.md §4): the row's requester opens the
// LIFF app from their rich menu's button in the LINE chat, chooses the row's request type and asks for plywood and nails
// adding up to the row's amount before VAT. The form fills the department, the cost center, the budget line and the
// site of the row (BR-FORM-02: the requester's latest requests in the demo history), which the requester may change,
// shows what is left on the line, and before sending the route the row's steps quote — the row's approver, the position
// the row's rule names in the department that holds it, the rule; sent, the request waits for that approver. At 375 px
// in the phone's browser standing in for the LINE app (LIFF_MOCK), every page checked and photographed (also at 1440 px).
// ./support.ts is imported inside the test: to the demo project every file of this folder is a test file (see there).

// The phone of LIFF at 375 px (§9.4): a Pixel 7 without its defaultBrowserType, a worker option that would give this file
// a worker of its own — Playwright runs each worker's files together, and the scenes must run in the files' name order
const { defaultBrowserType, ...pixel7 } = devices['Pixel 7']
test.use({ ...pixel7, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

/** Plywood and nails adding up to `net` (satang): 100 boxes of nails for about two sevenths, the sheets of plywood the rest */
function plywoodAndNails(net: bigint, typed: (satang: bigint) => string): FormLine[] {
  const perBox = (net * 2n) / 7n / 100n
  const plywood = net - perBox * 100n
  const [sheets, perSheet] = plywood % 20n === 0n ? [20n, plywood / 20n] : [1n, plywood]
  return [
    { description: 'ไม้อัด 10 มม.', quantity: String(sheets), uom: 'แผ่น', price: typed(perSheet) },
    { description: 'ตะปู 2 นิ้ว', quantity: '100', uom: 'กล่อง', price: typed(perBox) },
  ]
}

test('@demo [FR-INT-001/AC3] [FR-LINE-003/AC1] [FR-INT-003/AC1] [FR-INT-004/AC1] [FR-DOA-003/AC2] scene 1: the requester starts from the rich menu in LINE, asks for plywood and nails in LIFF; the form fills department, cost center, budget line and site, shows the budget left and the route to the approver under the rule before sending, and the request goes to that approver', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(240_000)
  const {
    amountOf,
    approverByRule,
    baht,
    budgetLeftNow,
    chargedDepartmentOf,
    checkLiffScreen,
    chosenIn,
    costCenterOf,
    countedOf,
    demoSheet,
    doaRuleFor,
    expectDelegation,
    expectEscalation,
    fillLine,
    formDefaultsOf,
    literally,
    nameIn,
    netOfLines,
    nextStep,
    nowLine,
    openLiffAs,
    openTaskOf,
    prepareTheDay,
    remainingOf,
    requestFacts,
    richMenuButtonOf,
    richMenuPath,
    routeRoleOf,
    sceneOf,
    sentNumber,
    sheetDoa,
    sheetDoaRef,
    stepHeading,
    th,
    typed,
    userOf,
    waitingFor,
  } = await import('./support')
  const sheet = await demoSheet()
  const scene = sceneOf(sheet, 1)
  expect(scene.channel).toBe('LIFF')
  expect(scene.expectedOutcome).toBe('ROUTED')
  const [net, vat, gross] = [amountOf(scene, 'net'), amountOf(scene, 'vat'), amountOf(scene, 'gross')]
  const approver = userOf(sheet, scene.expectedApprover)
  const typeName = nameIn(sheet.requestTypes, scene.requestType, 'request type')
  const lineName = nameIn(sheet.budgetLines, scene.budgetLine, 'budget line')
  const siteName = nameIn(sheet.sites, scene.site, 'site')
  const costCenter = sheet.budget.get(scene.budgetLine!)!.costCenter
  // The row holds together with the DOA and Users sheets: the amount the DOA counts falls in the row's rule, whose
  // position the row's approver holds up from the department that pays — the route the row's steps quote:
  // "VP สายปฏิบัติการ (PR-02)"
  expect(doaRuleFor(sheet, countedOf(sheet, scene)), 'the band of the DOA sheet that holds the amount the DOA counts').toBe(scene.expectedRule)
  const role = approverByRule(sheet, scene.expectedRule, scene.chargedDept)
  expect(role.member, `the holder of ${role.resolvedFrom} is the row's approver`).toBe(scene.expectedApprover)
  expect(scene.stepsTh, 'the steps of the scene quote the route').toContain(`"${role.position} ${role.departmentName} (${scene.expectedRule})"`)
  const lines = plywoodAndNails(net, typed)
  expect(netOfLines(lines), 'the plywood and the nails add up to the amount of the row').toBe(net)

  // Before the day: the rich menus are made and every phone of the demo is linked (runbook §1)
  prepareTheDay(sheet)
  // The DOA of sheet DOA_Policy is in effect (its code, version, basis and stepUpThreshold), and the line has what sheet
  // Budget leaves on it after the history
  const doa = sheetDoa(sheet)
  const available = budgetLeftNow(sheet, scene)
  // BR-FORM-02 fills a new form from the requester's latest requests, which the demo history left on the row's line and site
  expect(formDefaultsOf(scene.actor, scene.requestType!), 'what the requester used last: the row\'s budget line and site').toEqual({ budgetLine: scene.budgetLine, site: scene.site })

  // The rich menu's button the scene names opens the catalogue of request types (FR-INT-001 AC3)
  await openLiffAs(context, scene.actor)
  await page.goto(await richMenuPath(scene.actor, richMenuButtonOf(scene)))
  await expect(page.getByRole('heading', { level: 1, name: 'ขอซื้อ / ขอจ้าง' })).toBeVisible()
  await checkLiffScreen(page, testInfo, 'scene1-catalog')

  await page.getByRole('link', { name: new RegExp(`เริ่มคำขอ ${literally(typeName)}$`) }).click()
  await expect(page).toHaveURL(new RegExp(`/liff/requests/new/${scene.requestType}$`))
  await expect(page.getByRole('heading', { level: 1, name: `คำขอใหม่: ${typeName}` })).toBeVisible()
  await expect(stepHeading(page, 1, 'details', 3)).toBeVisible()
  // FR-INT-003 AC1: the budget line the requester used last for this type, the department that pays, the line's cost
  // center, and what is left on the line before anything is typed (FR-INT-004 AC1) — and the requester may change them
  await expect(chosenIn(page, th('requestForm.budget.line'))).toHaveText(`${scene.budgetLine} · ${lineName}`)
  await expect(page.getByLabel(th('requestForm.budget.line'))).toBeEnabled()
  await expect(chargedDepartmentOf(page)).toHaveText(nameIn(sheet.departments, scene.chargedDept, 'department'))
  await expect(costCenterOf(page)).toHaveText(new RegExp(`^${literally(costCenter)} `))
  await expect(remainingOf(page)).toContainText(th('requestForm.budget.baht', { amount: baht(available) }))
  await page.getByLabel(th('requestForm.details.title')).fill(`ไม้อัดและตะปู ${siteName}`)
  await checkLiffScreen(page, testInfo, 'scene1-form-details')

  await nextStep(page, 'items')
  await expect(stepHeading(page, 2, 'items', 3)).toBeVisible()
  // BR-FORM-02 "สถานที่ส่งล่าสุด": the site of the requester's latest request, which they may change
  await expect(chosenIn(page, th('requestForm.site.label'))).toHaveText(`${scene.site} · ${siteName}`)
  await expect(page.getByLabel(th('requestForm.site.label'))).toBeEnabled()
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.getByRole('button', { name: th('requestForm.lines.add') }).click()
    await fillLine(page.getByRole('group', { name: `รายการที่ ${i + 1}`, exact: true }), line)
  }
  // The row's amounts before VAT, the VAT and with VAT, and the line has room for it
  for (const amount of [net, vat, gross]) await expect(page.getByText(th('requestForm.totals.baht', { amount: baht(amount) })).first()).toBeVisible()
  await expect(page.getByText(th('requestForm.budget.enough'), { exact: true })).toBeVisible()
  await checkLiffScreen(page, testInfo, 'scene1-form-items')

  await nextStep(page, 'review')
  await expect(stepHeading(page, 3, 'review', 3)).toBeVisible()
  // FR-DOA-003 AC2: who approves — the approver, the position the rule names in the department that holds it — under
  // which rule of which DOA version, before pressing send
  const route = page.getByRole('region', { name: th('requestForm.route.title') })
  await expect(route.getByText(approver.nameTh, { exact: true })).toBeVisible()
  await expect(route).toContainText(routeRoleOf(role))
  await expect(route).toContainText(sheetDoaRef(sheet, scene.expectedRule))
  await expect(page.getByText(th('requestForm.review.ready'))).toBeVisible()
  await checkLiffScreen(page, testInfo, 'scene1-form-review')

  await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
  const number = await sentNumber(page, approver.nameTh)
  await checkLiffScreen(page, testInfo, 'scene1-sent')

  // The request as sent: the row's type, department, line, site and amounts, sent from LIFF, routed under the row's rule
  // to the row's approver, found at the position the rule names (the route the page showed is the route it took)
  const sent = requestFacts(number)
  expect(sent).toMatchObject({
    status: 'PENDING_APPROVAL',
    requester: scene.actor,
    requestType: scene.requestType,
    chargedDept: scene.chargedDept,
    budgetLine: scene.budgetLine,
    site: scene.site,
    net: net.toString(),
    vat: vat.toString(),
    gross: gross.toString(),
  })
  expect(sent.events.find((e) => e.type === 'request.submitted')?.channel).toBe('LIFF')
  expect(sent.route).toMatchObject({ ruleCode: scene.expectedRule, doa: { versionId: doa.id, code: sheet.doa.code, versionNo: sheet.doa.version } })
  expectEscalation(scene, sent.route)
  const task = openTaskOf(sent)
  expect(task).toMatchObject({ assignee: scene.expectedApprover, resolvedFrom: role.resolvedFrom })
  expectDelegation(scene, task)

  // Its page in LIFF: waiting for the approver at that position (FR-DOA-003 AC2, the route after sending)
  await page.getByRole('link', { name: th('requestForm.sent.open', { number }) }).click()
  await expect(page).toHaveURL(new RegExp(`/liff/requests/${sent.id}$`))
  await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible()
  await expect(nowLine(page)).toContainText(waitingFor(approver, role))
  await checkLiffScreen(page, testInfo, 'scene1-request')
})
