import { E2E_PIN } from '../../support/e2e-env'
import { expect, test } from '../fixtures'

// Demo scene 7 "จัดซื้อรวม PR เป็น PO" (sheet Demo_Script; runbook §4), on the web at 1440 px: the row's actor
// (procurement) opens the pool and finds scene 1's request — approved in scene 2 — with the request of the history row
// the steps name (Demo_History H11: its supplier and its site, which are scene 1's site), chooses that supplier for the
// lines of both and makes the drafts now: one PO of both, at one site for one supplier (BR-CONS-01). The draft shows
// the totals the server worked out (the sheet's amounts before VAT and the VAT at sheet Settings' rate) and the prices
// paid before for each item, as the database has them; before sending it the route the DOA expects — the PO rule the
// steps name, whose band of the DOA sheet holds the PO's amount, to the holder of that rule's position — and sent, the
// route it took. The approver decides on the web in their own browser (with the PIN when the amount the DOA counts is at
// or above sheet DOA_Policy's stepUpThreshold); procurement then sends the PO, and Mailpit holds the e-mail to the
// supplier's address of sheet Suppliers with the very PDF the PO was sent with; the requesters and the department's
// receiver are told (§16.10 "ฉากที่ปรับ": the RECEIVER of the department stands in for an assigned receiver). Every
// page is checked and photographed at 1440 px, the sign-in pages too. ./support.ts is imported inside the test: to the
// demo project every file of this folder is a test file (see there).

test('@demo [FR-P2P-001/AC2] [FR-P2P-001/AC3] [FR-P2P-002/AC3] [FR-P2P-003/AC3] [FR-P2P-004/AC1] [FR-DOA-005/AC1] [FR-P2P-005/AC1] scene 7: procurement finds scene 1’s request and the history’s in the pool, makes one PO of both with the prices paid before, sends it on the DOA’s route; its approver approves it on the web and procurement e-mails it to the supplier with its PDF', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(360_000)
  const {
    amountOf,
    anotherDesk,
    approverByRule,
    baht,
    basisPointsOf,
    checkWebScreen,
    chooseSupplier,
    consolidateNow,
    demoSheet,
    doaRefOf,
    doaRuleFor,
    expectPdfLink,
    historyOf,
    historyRefsIn,
    historyRequest,
    latestRequestOf,
    literally,
    nameIn,
    percentOfBp,
    poActions,
    poBudget,
    poHeader,
    poLineItems,
    poNumberOf,
    poolGroup,
    poOrdering,
    poRequests,
    poTimeline,
    prepareTheDay,
    rowWith,
    ruleNamedIn,
    sceneOf,
    settingOf,
    sheetDoa,
    shownQuantity,
    signInChecked,
    stampRoleOf,
    supplierMail,
    supplierOf,
    th,
    thaiDate,
    userOf,
    vatOf,
  } = await import('./support')
  const sheet = await demoSheet()
  const scene = sceneOf(sheet, 7)
  expect(scene.channel).toBe('WEB')
  // The two requests the row names: scene 1's, and the history row its steps name — approved, waiting in the pool, at
  // the same site and on the same budget line, its supplier the one the steps name
  const asked = sceneOf(sheet, 1)
  const refs = historyRefsIn(scene)
  expect(refs, 'the steps name one request of the history').toHaveLength(1)
  const past = historyOf(sheet, refs[0])
  expect(past.status, `${past.ref} is approved and not ordered yet: it waits in the pool`).toBe('APPROVED')
  expect(past.site, `scene 1's request and ${past.ref} go to one site, so one PO (BR-CONS-01)`).toBe(asked.site)
  expect(past.budgetLine, `scene 1's request and ${past.ref} are on one budget line`).toBe(asked.budgetLine)
  const supplier = supplierOf(sheet, past.supplier)
  expect(scene.stepsTh, 'the steps name the supplier of the history row').toContain(`ผู้ขาย ${supplier.code}`)
  const siteName = nameIn(sheet.sites, past.site, 'site')
  // The PO of both: the amounts before VAT of the two rows, the VAT at sheet Settings' rate; the DOA counts it on the
  // basis of sheet DOA_Policy and its band of the PO rules is the rule the steps name, whose position's holder approves
  const net = amountOf(asked, 'net') + past.net
  const vat = vatOf(sheet, net)
  const gross = net + vat
  const counted = sheet.doa.amountBasis === 'GROSS' ? gross : net
  const rule = ruleNamedIn(sheet, scene, 'PURCHASE_ORDER')
  expect(doaRuleFor(sheet, counted, 'PURCHASE_ORDER'), 'the band of the DOA sheet\'s PO rules that holds the PO\'s amount').toBe(rule.ruleCode)
  const role = approverByRule(sheet, rule.ruleCode, past.chargedDept)
  expect(scene.stepsTh, 'the steps name the approver by position, and the rule').toContain(`${role.position} อนุมัติ (${rule.ruleCode})`)
  const approver = userOf(sheet, role.member)
  const buyer = userOf(sheet, scene.actor)
  const stepUp = counted >= sheet.doa.stepUpThreshold
  // Who hears the PO went out (§10.1 po.sent, §16.10): the requesters, and the receiver of their department — the actor
  // of scene 8
  const receiver = userOf(sheet, sceneOf(sheet, 8).actor)
  expect(receiver.roles, 'scene 8\'s actor is a RECEIVER').toContain('RECEIVER')
  expect(receiver.department, 'of the requesters\' department').toBe(userOf(sheet, asked.actor).department)

  prepareTheDay(sheet)
  const doa = sheetDoa(sheet)
  const doaRef = doaRefOf(doa, rule.ruleCode)
  const first = latestRequestOf(asked.actor, amountOf(asked, 'net'))
  if (!first?.number) throw new Error('scene 1 sent no request: run the demo scenes in order')
  expect(first.status, 'scene 2 approved scene 1\'s request').toBe('APPROVED')
  const second = historyRequest(past.ref)
  if (!second.number) throw new Error(`the history's ${past.ref} has no number`)
  expect(second).toMatchObject({ status: 'APPROVED', requester: past.requester, site: past.site, budgetLine: past.budgetLine, net: past.net.toString() })
  const requests = [first, second] as const
  const numbers = [first.number, second.number]
  expect(poOrdering(first.number), 'no PO orders scene 1\'s request yet').toBeNull()
  const lineCount = first.lines.length + second.lines.length

  // Procurement signs in (password and authenticator code) and opens the pool: both requests wait there, every line
  // needing its supplier, the history's with the supplier its requester suggested
  await signInChecked(page, sheet, buyer.code, testInfo, 'scene7-procurement')
  await page.goto('/procurement/pool')
  await expect(page.getByRole('heading', { level: 1, name: th('procurement.pool.title') })).toBeVisible()
  for (const r of requests) {
    const group = poolGroup(page, r.number!)
    await expect(group).toContainText(siteName)
    await expect(group.getByText(th('procurement.pool.line.needsSupplier'), { exact: true })).toHaveCount(r.lines.length)
  }
  await expect(poolGroup(page, second.number)).toContainText(th('procurement.pool.request.suggested', { name: supplier.nameTh }))
  await checkWebScreen(page, testInfo, 'scene7-pool')

  // FR-P2P-001 AC2: one supplier for the lines of both at once; FR-P2P-002 AC3: the drafts now — one PO of both
  await chooseSupplier(page, numbers, `${supplier.code} · ${supplier.nameTh}`, lineCount)
  for (const n of numbers) await expect(poolGroup(page, n).getByText(th('procurement.pool.line.needsSupplier'), { exact: true })).toHaveCount(0)
  await consolidateNow(page)
  const round = page.getByRole('status').filter({ hasText: new RegExp(literally(th('procurement.pool.round.made', { count: '__N__' })).replace('__N__', '\\d+')) })
  const draft = round.getByRole('listitem').filter({ hasText: first.number }).filter({ hasText: second.number })
  await expect(draft).toHaveCount(1)
  await expect(draft).toContainText(th('procurement.pool.round.draftLines', { lines: lineCount }))
  await expect(draft).toContainText(th('procurement.pool.round.draftAmountValue', { amount: baht(net) }))
  for (const n of numbers) await expect(poolGroup(page, n)).toHaveCount(0)
  await checkWebScreen(page, testInfo, 'scene7-pool-drafted')
  await draft.getByRole('link').click()
  await expect(page).toHaveURL(/\/procurement\/pos\/[0-9a-f-]{36}$/)

  // The draft: the supplier and site of the row, made by procurement, the lines of both requests with their sources
  const drafted = poOrdering(first.number)
  if (!drafted) throw new Error('the round made no PO of scene 1\'s request')
  expect(drafted).toMatchObject({ status: 'DRAFT', number: null, supplier: { code: supplier.code, email: supplier.email }, site: past.site, createdBy: buyer.code })
  expect(page.url()).toMatch(new RegExp(`/procurement/pos/${drafted.id}$`))
  expect(drafted.lines).toHaveLength(lineCount)
  expect(drafted.requests.map((r) => r.number).sort()).toEqual([...numbers].sort())
  await expect(poHeader(page)).toContainText(th('purchaseOrder.detail.draftLabel'))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(supplier.nameTh)
  // FR-P2P-003 AC3: the totals the server worked out — the rows' amounts before VAT, the VAT at the sheet's rate
  const amounts = page.getByRole('region', { name: th('purchaseOrder.amounts.title') })
  const rate = th('purchaseOrder.amounts.vat', { rate: percentOfBp(basisPointsOf(settingOf(sheet, 'vatRate'))) })
  await expect(amounts).toContainText(new RegExp(`${literally(th('purchaseOrder.amounts.net'))}\\s*${literally(baht(net))}`))
  await expect(amounts).toContainText(new RegExp(`${literally(rate)}\\s*${literally(baht(vat))}`))
  await expect(amounts).toContainText(new RegExp(`${literally(th('purchaseOrder.amounts.gross'))}\\s*${literally(baht(gross))}`))
  // The budget it charges is what the two requests reserve for it on their line (§9.9 principle 5)
  await expect(poBudget(page)).toContainText(past.budgetLine)
  await expect(poBudget(page)).toContainText(new RegExp(`${literally(th('purchaseOrder.budget.requestReserved'))}\\s*${literally(baht(net))}`))
  await expect(poBudget(page)).toContainText(th('purchaseOrder.budget.state.DRAFT'))
  // Every line with the request line it orders, and the prices paid before for the same item as the database has them
  // (none yet for an item no approved PO ordered)
  for (const line of drafted.lines) {
    const item = poLineItems(page).filter({ hasText: `${line.lineNo}. ${line.description}` })
    await expect(item, `line ${line.lineNo}`).toHaveCount(1)
    for (const s of line.sources) {
      await expect(item).toContainText(th('purchaseOrder.lines.source', { number: s.requestNumber ?? '', line: s.lineNo, quantity: th('purchaseOrder.lines.qty', { quantity: shownQuantity(s.quantity), uom: line.uom }) }))
    }
    await expect(item).toContainText(th('purchaseOrder.lines.pricesTitle'))
    if (line.earlierPrices.length === 0) await expect(item).toContainText(th('purchaseOrder.lines.pricesNone'))
    for (const p of line.earlierPrices) {
      await expect(item).toContainText(th('purchaseOrder.lines.price', { number: p.poNumber ?? '', date: thaiDate(p.approvedAt), price: baht(BigInt(p.unitPrice)) }))
    }
  }
  for (const r of requests) await expect(poRequests(page).getByRole('link', { name: th('purchaseOrder.requests.title', { number: r.number!, title: r.title }) })).toBeVisible()
  await expect(page.getByRole('region', { name: th('purchaseOrder.facts.title') })).toContainText(new RegExp(`${literally(th('purchaseOrder.facts.createdBy'))}\\s*${literally(buyer.nameTh)}`))
  // FR-P2P-004 AC1: before sending, the route the DOA expects — the approver under the rule
  await expect(poActions(page)).toContainText(th('purchaseOrder.actions.submit.step', { no: 1, name: approver.nameTh }))
  await expect(poActions(page)).toContainText(doaRef)
  await checkWebScreen(page, testInfo, 'scene7-po-draft')

  // Sent for approval: a number, waiting for the approver under the rule — the route the page showed is the route taken
  await poActions(page).getByRole('button', { name: th('purchaseOrder.actions.submit.button') }).click()
  await expect(page.getByRole('status').filter({ hasText: th('purchaseOrder.actions.submit.done') })).toBeVisible()
  await expect(poHeader(page)).toContainText(th('purchaseOrder.status.PENDING_APPROVAL'))
  await expect(poHeader(page)).toContainText(th('purchaseOrder.waiting.APPROVER', { name: `${approver.nameTh} (${stampRoleOf(role)})` }))
  const number = await poNumberOf(page)
  await expect(page.getByRole('region', { name: 'เส้นทางอนุมัติ' })).toContainText(doaRef)
  await expect(page.getByRole('region', { name: th('purchaseOrder.facts.title') })).toContainText(new RegExp(`${literally(th('purchaseOrder.facts.submittedBy'))}\\s*${literally(buyer.nameTh)}`))
  const pending = poOrdering(first.number)!
  expect(pending).toMatchObject({ id: drafted.id, number, status: 'PENDING_APPROVAL', net: net.toString(), vat: vat.toString(), gross: gross.toString() })
  expect(pending.route).toMatchObject({ ruleCode: rule.ruleCode, amountBasis: sheet.doa.amountBasis, amount: counted.toString(), doa: { versionId: doa.id, code: doa.code, versionNo: doa.versionNo } })
  const task = pending.route!.tasks.find((t) => t.status === 'OPEN')
  expect(task, 'one step: the approver of the rule').toMatchObject({ assignee: role.member, principal: null, resolvedFrom: role.resolvedFrom })
  await checkWebScreen(page, testInfo, 'scene7-po-pending')

  // The approver, in their own browser: the PO in the inbox with its amount and supplier, decided on one screen
  const desk = await anotherDesk(browser)
  try {
    const decider = await desk.newPage()
    await signInChecked(decider, sheet, approver.code, testInfo, 'scene7-approver')
    await decider.goto('/tasks')
    const row = rowWith(decider.getByRole('list', { name: 'งานรออนุมัติของคุณ' }), number)
    await expect(row).toContainText(baht(gross))
    await expect(row).toContainText(supplier.nameTh)
    await checkWebScreen(decider, testInfo, 'scene7-approver-tasks')
    await row.getByRole('link').click()
    await expect(decider).toHaveURL(new RegExp(`/tasks/${task!.id}$`))
    await expect(decider.getByRole('heading', { level: 1 })).toHaveText(supplier.nameTh)
    await expect(decider.getByText(th('purchaseOrder.detail.numberLabel', { number }), { exact: true })).toBeVisible()
    await expect(decider.getByRole('region', { name: 'เส้นทางอนุมัติ' })).toContainText(doaRef)
    await expect(poBudget(decider)).toContainText(th('purchaseOrder.budget.state.RESERVED'))
    for (const n of numbers) await expect(poRequests(decider)).toContainText(n)
    await checkWebScreen(decider, testInfo, 'scene7-approver-task')
    await decider.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
    const confirm = decider.getByRole('group', { name: new RegExp(`^อนุมัติ ${literally(number)} ยอดรวม VAT ${literally(baht(gross))} บาท`) })
    await expect(confirm).toBeVisible()
    // At or above the stepUpThreshold the approval asks for the PIN (FR-AUTH-005 AC2); below it, it does not
    if (stepUp) await confirm.getByLabel('PIN 6 หลัก').fill(E2E_PIN)
    else await expect(confirm.getByLabel('PIN 6 หลัก')).toHaveCount(0)
    await confirm.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
    await expect(decider.getByRole('status').filter({ hasText: `อนุมัติแล้วโดย ${approver.nameTh} เมื่อ` })).toBeVisible({ timeout: 15_000 })
    const stamp = decider.getByRole('list', { name: th('purchaseOrder.track.label') }).getByRole('listitem').filter({ hasText: doaRef })
    await expect(stamp).toContainText(approver.nameTh)
    await checkWebScreen(decider, testInfo, 'scene7-approver-approved')
  } finally {
    await desk.close()
  }
  // FR-DOA-005 AC1: decided once, by the approver for nobody else, on the web, under the DOA version and the rule
  const approved = poOrdering(first.number)!
  expect(approved.status).toBe('APPROVED')
  expect(approved.route!.tasks.find((t) => t.id === task!.id)).toMatchObject({
    status: 'APPROVED',
    decision: 'APPROVE',
    channel: 'WEB',
    decided: { channel: 'WEB', by: role.member, onBehalfOf: null, doaVersionId: doa.id, doaRuleCode: rule.ruleCode, stepUp },
  })

  // Procurement sends it (FR-P2P-005 AC1): the address of sheet Suppliers, asked a second time, then the PO is sent
  await page.reload()
  await expect(poHeader(page)).toContainText(th('purchaseOrder.status.APPROVED'))
  await expect(poHeader(page)).toContainText(th('purchaseOrder.waiting.SEND'))
  await expect(poBudget(page)).toContainText(new RegExp(`${literally(th('purchaseOrder.budget.committed'))}\\s*${literally(baht(net))}`))
  const send = page.getByRole('region', { name: th('purchaseOrder.actions.send.title') })
  await expect(send).toContainText(supplier.email)
  await checkWebScreen(page, testInfo, 'scene7-po-approved')
  const before = Date.now()
  await send.getByRole('button', { name: th('purchaseOrder.actions.send.button') }).click()
  await expect(page.getByText(th('purchaseOrder.actions.send.confirmText', { number, email: supplier.email }))).toBeVisible()
  await checkWebScreen(page, testInfo, 'scene7-po-send-confirm')
  await page.getByRole('button', { name: th('purchaseOrder.actions.send.confirm') }).click()
  await expect(page.getByRole('status').filter({ hasText: th('purchaseOrder.actions.send.sent') })).toBeVisible()
  await expect(poHeader(page)).toContainText(th('purchaseOrder.status.SENT'))
  await expect(poHeader(page)).toContainText(`ส่งถึง ${supplier.email} เมื่อ`)
  await expect(poTimeline(page)).toContainText(th('purchaseOrder.track.what.SENT'))
  await checkWebScreen(page, testInfo, 'scene7-po-sent')

  // Sent and recorded: when and to which address, with the PDF named after its number (FR-PLT-009), by procurement on
  // the web; Mailpit holds the e-mail to the supplier with that very PDF, and the page opens it too
  const sent = poOrdering(first.number)!
  expect(sent).toMatchObject({ status: 'SENT', sentToEmail: supplier.email, pdf: { fileName: `${number}.pdf`, mimeType: 'application/pdf' } })
  expect(sent.sentAt).not.toBeNull()
  expect(sent.events.filter((e) => e.type === 'po.sent')).toEqual([{ type: 'po.sent', channel: 'WEB', by: buyer.code }])
  const mail = await supplierMail(supplier.email, number, before, sent.pdf!)
  expect(mail.Subject).toContain(`ใบสั่งซื้อ ${number}`)
  await expectPdfLink(page, page.getByRole('link', { name: th('purchaseOrder.detail.pdf', { label: number }) }))
  // The requesters and the department's receiver hear of it in their next digest; the receiver's notice opens the
  // receiving of the PO (/receiving/<id>, in LINE /gr/<id>: scene 8)
  const told = sent.notices.filter((n) => n.templateKey === 'po.sent')
  expect(told.map((n) => n.recipient).sort()).toEqual([...new Set([asked.actor, past.requester, receiver.code])].sort())
  for (const n of told) expect(n, `po.sent to ${n.recipient}`).toMatchObject({ urgency: 'DIGEST', data: { forReceiver: n.recipient === receiver.code } })
  expect(told.find((n) => n.recipient === receiver.code)?.href).toBe(`/receiving/${sent.id}`)
})
