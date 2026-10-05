import { expect, test } from '../fixtures'

// Demo scene 5 "ยอดก่อน VAT กับรวม VAT" (sheet Demo_Script; runbook §4): the row's requester on the web (1440 px) asks
// for the row's amount before VAT. The form fills the department, the cost center, the budget line and the site
// (BR-FORM-02: the line of the requester's latest request of the type — scene 3's — and the site of their latest), and
// the requester changes the line to the row's. The form shows the amount before VAT, the VAT and with VAT — the figures
// the row's steps say — and the route goes to the row's approver under the row's rule: because the DOA counts the amount
// with VAT (sheet DOA_Policy amountBasis), the amount before VAT alone would fall in a lower band of the DOA sheet and go
// to the holder of that band's position instead ("ไป VP ไม่ใช่ DM", the presenter's question to the customer, Q-02).
// Every page checked with axe and photographed, the sign-in page first. ./support.ts is imported inside the test: to the
// demo project every file of this folder is a test file (see there).

test('@demo [FR-INT-003/AC1] [FR-INT-004/AC1] [FR-DOA-003/AC2] scene 5: on the web, a request whose amount before VAT is in one DOA band and with VAT in the next shows both, and goes to the approver of the band with VAT as the DOA counts it', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000)
  const {
    amountOf,
    approverByRule,
    baht,
    budgetLeftNow,
    chargedDepartmentOf,
    checkWebScreen,
    chosenIn,
    costCenterOf,
    countedOf,
    demoSheet,
    doaRefOf,
    doaRuleFor,
    expectDelegation,
    expectEscalation,
    fillLine,
    formDefaultsOf,
    literally,
    nameIn,
    nextStep,
    nowLine,
    openTaskOf,
    remainingOf,
    requestFacts,
    routeRoleOf,
    sceneOf,
    sentNumber,
    sheetDoa,
    signInAs,
    spokenBaht,
    stepHeading,
    th,
    typed,
    userOf,
    waitingFor,
  } = await import('./support')
  const sheet = await demoSheet()
  const scene = sceneOf(sheet, 5)
  expect(scene.channel).toBe('WEB')
  expect(scene.expectedOutcome).toBe('ROUTED')
  const [net, vat, gross] = [amountOf(scene, 'net'), amountOf(scene, 'vat'), amountOf(scene, 'gross')]
  const counted = countedOf(sheet, scene)
  // The point of the scene, by the sheets: the amount the DOA counts is in the row's band, whose position the row's
  // approver holds; the amount before VAT is in another band, whose position someone else holds — the two positions and
  // the two figures the row's steps say ("ยอดก่อน VAT 18,700 แต่รวม VAT 20,009 → ไป VP ไม่ใช่ DM")
  expect(doaRuleFor(sheet, counted)).toBe(scene.expectedRule)
  const netRule = doaRuleFor(sheet, net)
  expect(netRule, 'before VAT the amount falls in another band of the DOA sheet').not.toBe(scene.expectedRule)
  const role = approverByRule(sheet, scene.expectedRule, scene.chargedDept)
  const notRole = approverByRule(sheet, netRule, scene.chargedDept)
  expect(role.member, `the holder of ${role.resolvedFrom} is the row's approver`).toBe(scene.expectedApprover)
  expect(notRole.member, `the holder of ${notRole.resolvedFrom}, whom the amount before VAT would go to, is someone else`).not.toBe(role.member)
  expect(scene.stepsTh, 'the steps of the scene say whom it goes to and whom not').toContain(`ไป ${role.position} ไม่ใช่ ${notRole.position}`)
  for (const said of [net, gross]) expect(scene.stepsTh, `the steps of the scene say ${spokenBaht(said)}`).toContain(spokenBaht(said))
  const approver = userOf(sheet, scene.expectedApprover)
  const typeName = nameIn(sheet.requestTypes, scene.requestType, 'request type')
  const lineName = nameIn(sheet.budgetLines, scene.budgetLine, 'budget line')
  const siteName = nameIn(sheet.sites, scene.site, 'site')
  const costCenter = sheet.budget.get(scene.budgetLine!)!.costCenter
  // The DOA of sheet DOA_Policy (it counts the amount with VAT), and the line with what sheet Budget leaves on it after
  // the history and scene 1's request
  const doa = sheetDoa(sheet)
  const available = budgetLeftNow(sheet, scene)
  // What the new form fills in (BR-FORM-02): the line of the requester's latest request of the type, the latest site
  const filled = formDefaultsOf(scene.actor, scene.requestType!)
  if (!filled.budgetLine || !filled.site) throw new Error(`${scene.actor} has sent no ${scene.requestType} before: run the demo scenes in order`)

  // The sign-in page, then the requester's home
  await page.goto('/login')
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeVisible()
  await checkWebScreen(page, testInfo, 'scene5-login')
  await signInAs(page, sheet, scene.actor)
  await checkWebScreen(page, testInfo, 'scene5-home')
  await page.goto('/requests/new')
  await expect(page.getByRole('heading', { level: 1, name: 'ขอซื้อ / ขอจ้าง' })).toBeVisible()
  await checkWebScreen(page, testInfo, 'scene5-catalog')
  await page.getByRole('link', { name: new RegExp(`เริ่มคำขอ ${literally(typeName)}$`) }).click()
  await expect(page).toHaveURL(new RegExp(`/requests/new/${scene.requestType}$`))
  await expect(stepHeading(page, 1, 'details', 4)).toBeVisible()
  // FR-INT-003 AC1: filled — the line the requester used last for this type, its department and cost center — and the
  // requester changes the line to the row's, whose department, cost center and balance follow
  const lineLabel = (code: string) => `${code} · ${nameIn(sheet.budgetLines, code, 'budget line')}`
  await expect(chosenIn(page, th('requestForm.budget.line'))).toHaveText(lineLabel(filled.budgetLine))
  await expect(chargedDepartmentOf(page)).toHaveText(nameIn(sheet.departments, sheet.budget.get(filled.budgetLine)!.department, 'department'))
  await expect(costCenterOf(page)).toHaveText(new RegExp(`^${literally(sheet.budget.get(filled.budgetLine)!.costCenter)} `))
  await page.getByLabel(th('requestForm.budget.line')).selectOption({ label: `${scene.budgetLine} · ${lineName}` })
  await expect(chosenIn(page, th('requestForm.budget.line'))).toHaveText(`${scene.budgetLine} · ${lineName}`)
  await expect(chargedDepartmentOf(page)).toHaveText(nameIn(sheet.departments, scene.chargedDept, 'department'))
  await expect(costCenterOf(page)).toHaveText(new RegExp(`^${literally(costCenter)} `))
  await expect(remainingOf(page)).toContainText(th('requestForm.budget.baht', { amount: baht(available) }))
  await page.getByLabel(th('requestForm.details.title')).fill(`วัสดุซ่อมบำรุง ${siteName}`)
  await checkWebScreen(page, testInfo, 'scene5-form-details')

  await nextStep(page, 'items')
  await expect(stepHeading(page, 2, 'items', 4)).toBeVisible()
  // The latest site, filled; the row's site, chosen (the same here, or changed)
  await expect(chosenIn(page, th('requestForm.site.label'))).toHaveText(`${filled.site} · ${nameIn(sheet.sites, filled.site, 'site')}`)
  await page.getByLabel(th('requestForm.site.label')).selectOption({ label: `${scene.site} · ${siteName}` })
  await expect(chosenIn(page, th('requestForm.site.label'))).toHaveText(`${scene.site} · ${siteName}`)
  // The row's amount as a price before VAT
  await expect(page.getByLabel(th('requestForm.lines.pricesIncludeVat'))).not.toBeChecked()
  await fillLine(page.getByRole('group', { name: 'รายการที่ 1', exact: true }), { description: 'วัสดุซ่อมบำรุงไซต์งาน', quantity: '1', uom: 'ชุด', price: typed(net) })
  // Before VAT, the VAT and with VAT: the row's three amounts
  for (const amount of [net, vat, gross]) await expect(page.getByText(th('requestForm.totals.baht', { amount: baht(amount) })).first()).toBeVisible()
  await expect(page.getByText(th('requestForm.budget.enough'), { exact: true })).toBeVisible()
  await checkWebScreen(page, testInfo, 'scene5-form-items')

  await nextStep(page, 'documents')
  await expect(stepHeading(page, 3, 'documents', 4)).toBeVisible()
  await checkWebScreen(page, testInfo, 'scene5-form-documents')
  await nextStep(page, 'review')
  await expect(stepHeading(page, 4, 'review', 4)).toBeVisible()
  // FR-DOA-003 AC2: the row's approver at the position of the band with VAT, under the row's rule, for the amount the DOA
  // counts — not the holder of the band before VAT
  const route = page.getByRole('region', { name: th('requestForm.route.title') })
  await expect(route.getByText(approver.nameTh, { exact: true })).toBeVisible()
  await expect(route).toContainText(routeRoleOf(role))
  await expect(route).toContainText(doaRefOf(doa, scene.expectedRule!))
  await expect(route).toContainText(`ยอด ${baht(counted)} บาท`)
  await expect(route).not.toContainText(userOf(sheet, notRole.member).nameTh)
  await expect(page.getByText(th('requestForm.review.ready'))).toBeVisible()
  await checkWebScreen(page, testInfo, 'scene5-form-review')

  await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
  const number = await sentNumber(page, approver.nameTh)
  await checkWebScreen(page, testInfo, 'scene5-sent')

  // As sent: the row's amounts; the route counted the amount with VAT and went to the row's approver under the row's rule
  const sent = requestFacts(number)
  expect(sent).toMatchObject({
    status: 'PENDING_APPROVAL',
    requester: scene.actor,
    requestType: scene.requestType,
    chargedDept: scene.chargedDept,
    budgetLine: scene.budgetLine,
    site: scene.site,
    priceIncludesVat: false,
    net: net.toString(),
    vat: vat.toString(),
    gross: gross.toString(),
  })
  expect(sent.events.find((e) => e.type === 'request.submitted')?.channel).toBe('WEB')
  expect(sent.route).toMatchObject({ ruleCode: scene.expectedRule, amountBasis: sheet.doa.amountBasis, amount: counted.toString(), doa: { code: doa.code, versionNo: doa.versionNo } })
  expectEscalation(scene, sent.route)
  const task = openTaskOf(sent)
  expect(task).toMatchObject({ assignee: scene.expectedApprover, resolvedFrom: role.resolvedFrom })
  expectDelegation(scene, task)

  // Its page: waiting for that approver at that position (FR-DOA-003 AC2, the route after sending)
  await page.getByRole('link', { name: th('requestForm.sent.open', { number }) }).click()
  await expect(page).toHaveURL(new RegExp(`/requests/${sent.id}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(sent.title)
  await expect(page.getByText(number).first()).toBeVisible()
  await expect(nowLine(page)).toContainText(waitingFor(approver, role))
  await checkWebScreen(page, testInfo, 'scene5-request')
})
