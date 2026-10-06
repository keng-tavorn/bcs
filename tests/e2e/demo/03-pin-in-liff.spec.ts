import { devices } from '@playwright/test'
import { E2E_PIN } from '../../support/e2e-env'
import { expect, test } from '../fixtures'

// Demo scene 3 "ยอดสูงต้องยืนยัน PIN" (sheet Demo_Script; runbook §4): the row's requester asks in LIFF for a deep-well
// pump of the row's amount on the row's budget line — the form opens with the line they used last, and they change it.
// At this amount the form asks for quotations (the request type's rule of the RequestTypes sheet: three, or one with the
// single-source reason), so the requester types the reason and attaches a photo of the paper quotation, as the presenter
// will; the route goes to the row's approver (the CEO) under the row's rule. The premise, by the sheets: the amount the
// DOA counts is at or above sheet DOA_Policy's stepUpThreshold, so in the CEO's LINE chat the card — the summary only —
// has no in-chat approve: its "อนุมัติ (ยืนยัน PIN)" opens the task in LIFF with approve ready (§9.3, BR-TOK-05). There
// approving without the PIN does not go through — the page asks for it before sending anything, and a decision that
// reaches the server without it is refused there too, so the page is never the guard — and with it the request is
// approved on channel LIFF with a step-up (FR-LINE-003 AC2). Both phones at 375 px, every page checked and photographed.
// ./support.ts is imported inside the test: to the demo project every file of this folder is a test file (see there).

// The phone of LIFF at 375 px (§9.4): a Pixel 7 without its defaultBrowserType, a worker option that would give this file
// a worker of its own — Playwright runs each worker's files together, and the scenes must run in the files' name order
const { defaultBrowserType, ...pixel7 } = devices['Pixel 7']
test.use({ ...pixel7, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

/** A photo of the paper quotation from the phone's gallery: a small PNG, which the browser decodes and makes a JPEG */
const QUOTATION_PHOTO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

test('@demo [FR-INT-005/AC1] [FR-LINE-002/AC1] [FR-LINE-003/AC1] [FR-LINE-003/AC2] scene 3: a request at or above the step-up threshold sent from LIFF with its quotation photo goes to the CEO, whose card opens LIFF instead of approving in the chat; without the PIN nothing is approved, by the page or by the server, and with it the request is approved on channel LIFF with the step-up', async ({
  page,
  context,
  browser,
}, testInfo) => {
  test.setTimeout(300_000)
  const {
    amountOf,
    approverByRule,
    baht,
    budgetLeftNow,
    cardTo,
    channelLabel,
    chargedDepartmentOf,
    checkLiffScreen,
    chosenIn,
    countedOf,
    deliverPending,
    demoSheet,
    expectApprovalCard,
    expectCardButtons,
    expectDelegation,
    expectEscalation,
    fillLine,
    formDefaultsOf,
    leaveOutThePin,
    liffPathOf,
    literally,
    nameIn,
    nextStep,
    openLiffAs,
    openTaskOf,
    phoneOf,
    prepareTheDay,
    remainingOf,
    requestFacts,
    requestTimeline,
    richMenuButtonOf,
    richMenuPath,
    sceneOf,
    sentNumber,
    sheetDoa,
    sheetDoaRef,
    stampRoleOf,
    stepHeading,
    th,
    thaiDateTime,
    typed,
    userOf,
  } = await import('./support')
  const sheet = await demoSheet()
  const scene = sceneOf(sheet, 3)
  expect(scene.channel).toBe('LIFF')
  expect(scene.expectedOutcome).toBe('ROUTED')
  const [net, vat, gross] = [amountOf(scene, 'net'), amountOf(scene, 'vat'), amountOf(scene, 'gross')]
  const approver = userOf(sheet, scene.expectedApprover)
  const role = approverByRule(sheet, scene.expectedRule, scene.chargedDept)
  expect(role.member, `the holder of ${role.resolvedFrom} is the row's approver`).toBe(scene.expectedApprover)
  // The premise (FR-LINE-003 AC2): the amount the DOA counts is at or above sheet DOA_Policy's stepUpThreshold, so
  // deciding needs the PIN
  expect(countedOf(sheet, scene), 'the row\'s amount on the DOA\'s basis is at or above the stepUpThreshold of sheet DOA_Policy').toBeGreaterThanOrEqual(sheet.doa.stepUpThreshold)
  const doaRef = sheetDoaRef(sheet, scene.expectedRule)
  const typeName = nameIn(sheet.requestTypes, scene.requestType, 'request type')
  const lineName = nameIn(sheet.budgetLines, scene.budgetLine, 'budget line')
  const siteName = nameIn(sheet.sites, scene.site, 'site')
  const supplier = 'ร้านปั๊มบาดาลท้องถิ่น'
  // The attachment rule of the request type that asks for quotations at this amount
  const quotesRule = sheet.attachmentRules.get(scene.requestType!)?.find((rule) => /QUOTE/.test(rule))
  if (!quotesRule) throw new Error(`RequestTypes names no quotation rule for ${scene.requestType}`)

  prepareTheDay(sheet)
  // The DOA of sheet DOA_Policy (with its stepUpThreshold), and the line with what sheet Budget leaves on it after the history
  const doa = sheetDoa(sheet)
  const available = budgetLeftNow(sheet, scene)
  // The line a new form starts with: the one the requester's latest request of the type went on (BR-FORM-02)
  const filled = formDefaultsOf(scene.actor, scene.requestType!)

  // The requester: the rich menu's button of the day (scene 1's steps name it), then the request type of the row
  await openLiffAs(context, scene.actor)
  await page.goto(await richMenuPath(scene.actor, richMenuButtonOf(sceneOf(sheet, 1))))
  await expect(page.getByRole('heading', { level: 1, name: 'ขอซื้อ / ขอจ้าง' })).toBeVisible()
  await checkLiffScreen(page, testInfo, 'scene3-catalog')
  await page.getByRole('link', { name: new RegExp(`เริ่มคำขอ ${literally(typeName)}$`) }).click()
  await expect(stepHeading(page, 1, 'details', 3)).toBeVisible()
  // The form opens with the line the requester used last; they change it to the row's
  if (filled.budgetLine) await expect(chosenIn(page, th('requestForm.budget.line'))).toHaveText(`${filled.budgetLine} · ${nameIn(sheet.budgetLines, filled.budgetLine, 'budget line')}`)
  await page.getByLabel(th('requestForm.budget.line')).selectOption({ label: `${scene.budgetLine} · ${lineName}` })
  await expect(chosenIn(page, th('requestForm.budget.line'))).toHaveText(`${scene.budgetLine} · ${lineName}`)
  await expect(chargedDepartmentOf(page)).toHaveText(nameIn(sheet.departments, scene.chargedDept, 'department'))
  await expect(remainingOf(page)).toContainText(th('requestForm.budget.baht', { amount: baht(available) }))
  await page.getByLabel(th('requestForm.details.title')).fill(`ปั๊มน้ำบาดาล ${siteName}`)
  // The single-source reason is not a question of this step: the rule that takes it is asked beside the documents
  await expect(page.getByLabel(/^เหตุผลกรณีมีผู้ขายรายเดียว/)).toHaveCount(0)
  await checkLiffScreen(page, testInfo, 'scene3-form-details')

  await nextStep(page, 'items')
  await page.getByLabel(th('requestForm.site.label')).selectOption({ label: `${scene.site} · ${siteName}` })
  await fillLine(page.getByRole('group', { name: 'รายการที่ 1', exact: true }), { description: 'ปั๊มน้ำบาดาล', quantity: '1', uom: 'เครื่อง', price: typed(net) })
  for (const amount of [net, vat, gross]) await expect(page.getByText(th('requestForm.totals.baht', { amount: baht(amount) })).first()).toBeVisible()
  await expect(page.getByText(th('requestForm.budget.enough'), { exact: true })).toBeVisible()
  await checkLiffScreen(page, testInfo, 'scene3-form-items')

  await nextStep(page, 'review')
  await expect(stepHeading(page, 3, 'review', 3)).toBeVisible()
  // FR-INT-005 AC1: at this amount the rule asks for quotations, and is not met yet
  const rule = page.locator(`[data-rule="${quotesRule}"]`)
  await expect(rule).toContainText(th('requestForm.documents.notMet'))
  // Above 100,000.00 baht with VAT the rule's single-source reason is asked here, beside the rule that takes it
  const reason = page.getByLabel(/^เหตุผลกรณีมีผู้ขายรายเดียว/)
  await expect(reason).toBeVisible()
  await checkLiffScreen(page, testInfo, 'scene3-form-documents')
  // One quotation only: the single-source reason the rule takes with it (a field of the form)
  await reason.fill('ผู้ขายรายเดียวในพื้นที่ที่ติดตั้งและรับประกันปั๊มบาดาลได้')
  // The one quotation, as data (BR-FORM-06): the supplier, its amount before VAT, the photo of the paper; chosen. With
  // the single-source reason the rule is met
  await page.getByRole('button', { name: th('requestForm.quotations.add') }).click()
  const quotation = page.getByRole('group', { name: th('requestForm.quotations.item', { n: 1 }) })
  await quotation.getByLabel(th('requestForm.quotations.supplier')).fill(supplier)
  await quotation.getByLabel(th('requestForm.quotations.amount')).fill(typed(net))
  await quotation.locator('input[type="file"]').setInputFiles({ name: 'quotation.png', mimeType: 'image/png', buffer: QUOTATION_PHOTO })
  await expect(quotation.getByText(th('requestForm.quotations.file', { name: 'quotation' }), { exact: false })).toBeVisible()
  await quotation.getByLabel(th('requestForm.quotations.choose', { n: 1 })).check()
  await expect(rule).toContainText(th('requestForm.documents.met'))
  // The route: the row's approver under the row's rule
  const route = page.getByRole('region', { name: th('requestForm.route.title') })
  await expect(route.getByText(approver.nameTh, { exact: true })).toBeVisible()
  await expect(route).toContainText(doaRef)
  await expect(page.getByText(th('requestForm.review.ready'))).toBeVisible()
  await checkLiffScreen(page, testInfo, 'scene3-form-review')

  await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
  const number = await sentNumber(page, approver.nameTh)
  await checkLiffScreen(page, testInfo, 'scene3-sent')
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
  expect(sent.route).toMatchObject({ ruleCode: scene.expectedRule, amount: countedOf(sheet, scene).toString(), doa: { versionId: doa.id, code: sheet.doa.code, versionNo: sheet.doa.version } })
  expectEscalation(scene, sent.route)
  expect(sent.files).toContain('QUOTATION')
  expect(sent.events.find((e) => e.type === 'request.submitted')?.channel).toBe('LIFF')
  const task = openTaskOf(sent)
  expect(task).toMatchObject({ assignee: scene.expectedApprover, resolvedFrom: role.resolvedFrom })
  expectDelegation(scene, task)

  // The CEO's chat: the card is the summary only (FR-LINE-002 AC1) — not the title, the line, the quotation's supplier
  // or its file — and says the PIN is needed; §9.3: its "อนุมัติ (ยืนยัน PIN)" opens the task's LIFF page with approve
  // ready, and no button approves in the chat
  const delivered = deliverPending(approver.code, sent.id)
  expect(delivered.map((d) => ({ template: d.templateKey, status: d.outcome.status, channel: d.outcome.channel }))).toContainEqual({ template: 'task.assigned', status: 'SENT', channel: 'LINE' })
  const card = await cardTo(approver.code, number)
  expectApprovalCard(sheet, card, { number, scene, task, doaRef, hidden: [sent.title, ...sent.lines, supplier, 'quotation'] })
  const approve = expectCardButtons(card, { taskId: task.id, number, inChat: false })

  const phone = await phoneOf(browser, approver.code)
  try {
    const ceo = await phone.newPage()
    const decisions: string[] = []
    ceo.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname.startsWith('/liff/tasks/')) decisions.push(r.url())
    })
    // The button opens the task in LIFF with approve ready (§9.3: /liff/tasks/<id>?action=approve)
    await ceo.goto(liffPathOf(approve.uri!))
    await expect(ceo).toHaveURL(new RegExp(`/liff/tasks/${task.id}(\\?action=approve)?$`))
    await expect(ceo.getByText('ยอดของงานนี้ถึงเกณฑ์ที่ต้องยืนยันด้วย PIN 6 หลัก', { exact: false })).toBeVisible()
    const summary = ceo.getByRole('region', { name: 'สรุปงานนี้' })
    await expect(summary).toContainText(`${baht(countedOf(sheet, scene))} บาท`)
    await expect(summary.getByText(doaRef, { exact: true })).toBeVisible()
    const confirm = ceo.getByRole('region', { name: 'ตัดสินงานนี้' }).getByRole('group', { name: new RegExp(`^อนุมัติ ${number} `) })
    await expect(confirm).toBeVisible()
    await checkLiffScreen(ceo, testInfo, 'scene3-ceo-task')

    // Without the PIN: refused at the field, nothing is sent, the task still waits
    await confirm.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
    await expect(confirm.getByText(th('tasks.errors.PIN'))).toBeVisible()
    await ceo.waitForLoadState('networkidle')
    expect(decisions).toEqual([])
    expect(requestFacts(number).tasks.find((t) => t.id === task.id)?.status).toBe('OPEN')
    await checkLiffScreen(ceo, testInfo, 'scene3-ceo-no-pin')

    // The page is not the guard: a decision that reaches the server without the PIN — the one typed is taken out on its
    // way — is refused there and said at the field; nothing is decided, and the second press stays for the next try
    const withoutPin = await leaveOutThePin(ceo, task.id)
    await confirm.getByLabel('PIN 6 หลัก').fill(E2E_PIN)
    await confirm.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
    // The press clears the field's last word before it sends, so the words that come back are the server's answer
    await expect.poll(() => withoutPin.sent() + withoutPin.problems().length, { message: 'the decision went out', timeout: 15_000 }).toBe(1)
    expect(withoutPin.problems()).toEqual([])
    await expect(confirm.getByText(th('tasks.errors.PIN'))).toBeVisible({ timeout: 15_000 })
    await withoutPin.stop()
    expect(withoutPin.sent(), 'the decision reached the server, without the PIN').toBe(1)
    expect(decisions, 'one decision was sent').toHaveLength(1)
    expect(requestFacts(number).tasks.find((t) => t.id === task.id), 'the server decided nothing').toMatchObject({ status: 'OPEN', decision: null, decided: null })
    await expect(confirm.getByLabel('PIN 6 หลัก')).toHaveValue('')
    await checkLiffScreen(ceo, testInfo, 'scene3-ceo-pin-refused-by-server')

    // With the PIN: approved, by the CEO for nobody else, on channel LIFF with the step-up, under the row's rule
    await confirm.getByLabel('PIN 6 หลัก').fill(E2E_PIN)
    await confirm.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
    await expect(ceo.getByRole('status').filter({ hasText: `อนุมัติแล้วโดย ${approver.nameTh} เมื่อ` })).toBeVisible({ timeout: 15_000 })
    const decided = requestFacts(number)
    expect(decided.status).toBe('APPROVED')
    const done = decided.tasks.find((t) => t.id === task.id)
    expect(done).toMatchObject({
      status: 'APPROVED',
      decision: 'APPROVE',
      channel: 'LIFF',
      decided: { channel: 'LIFF', by: approver.code, onBehalfOf: null, doaVersionId: doa.id, doaRuleCode: scene.expectedRule, stepUp: true },
    })
    // The timeline stamps it: the CEO by position, when and on channel LIFF, and the DOA version and rule
    const stamp = requestTimeline(ceo).getByRole('listitem').filter({ hasText: doaRef }).filter({ hasText: approver.nameTh })
    await expect(stamp).toContainText(`${approver.nameTh} · ${stampRoleOf(role)}`)
    await expect(stamp).toContainText(`${thaiDateTime(done!.decided!.at)} · ${channelLabel('LIFF')}`)
    await checkLiffScreen(ceo, testInfo, 'scene3-ceo-approved')
  } finally {
    await phone.close()
  }
})
