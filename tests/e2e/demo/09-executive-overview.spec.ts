import { randomUUID } from 'node:crypto'
import { expect, test } from '../fixtures'

// Demo scene 9 "ผู้บริหารเห็นทุกอย่าง" (sheet Demo_Script; runbook §4), on the web at 1440 px, after the day's scenes:
//  - the board: the row's actor (the CEO) sees the request of the history row the steps name (Demo_History H12) waiting
//    past its SLA at the holder of the position the steps name (its rule's VP), with the business hours the history
//    gave it — as many as ApprovalTask says now (FR-VIS-001 AC3: read from the database before and after the page);
//  - the budget dashboard: the budget line of the department the steps name ("ไอทีเหลือ 8%") running low, its share
//    left as the history leaves it (sheet Budget: planned and remaining, which no scene of the day changed), every
//    amount of that line, of its department and of the organization as the ledger's balances have them;
//  - the KPI: as §16.10 "ฉากที่ปรับ" has it, the share of purchase-request decisions made on LINE or in LIFF, counted from
//    the decision events of the period the page shows — scenes 2 and 3 among them (LINE chat, LIFF);
//  - the audit export: as §16.10 "ฉากที่ปรับ" has it, the CEO's export is refused with FORBIDDEN and the `auditor` (the
//    AUDITOR of sheet Users) exports the audit of scene 1's request, whose file holds scene 2's decision with its DOA
//    reference on channel LINE_CHAT.
// Every page is checked and photographed at 1440 px, the sign-in pages too. ./support.ts is imported inside the test: to
// the demo project every file of this folder is a test file (see there).

/** The columns of the audit export the scene reads (FR-VIS-004 AC2) */
const AUDIT_COLUMNS = ['type', 'aggregateId', 'actor', 'onBehalfOf', 'channel', 'doaVersionId', 'doaRuleCode'] as const

test('@demo [FR-VIS-001/AC1] [FR-VIS-001/AC3] [FR-BUD-005/AC1] [FR-VIS-003/AC2] [FR-VIS-004/AC2] [FR-DOA-005/AC3] scene 9: the CEO sees the history’s request past its SLA at the VP with its business hours, the IT budget line running low, and the share of purchase-request decisions on LINE or LIFF; the CEO’s audit export is refused, and the auditor’s holds scene 2’s decision with its DOA reference on LINE_CHAT', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(360_000)
  const {
    amountOf,
    anotherDesk,
    approverByRule,
    basisPointsOf,
    boardOf,
    boardStepIn,
    budgetLinesNow,
    budgetStepIn,
    channelLabel,
    checkWebScreen,
    demoSheet,
    doaRefOf,
    expectBudgetRow,
    exportedFile,
    historyOf,
    historyRequest,
    hoursBetween,
    kpiOf,
    latestRequestOf,
    leftShareOf,
    nameIn,
    openTaskOf,
    prepareTheDay,
    ruleOf,
    sceneOf,
    settingOf,
    sha256,
    shareText,
    sheetDoa,
    sheetRows,
    shownChecksum,
    signInChecked,
    sumFigures,
    th,
    thaiDateTime,
    userOf,
  } = await import('./support')
  const sheet = await demoSheet()
  const scene = sceneOf(sheet, 9)
  expect(scene.channel).toBe('WEB')
  const ceo = userOf(sheet, scene.actor)

  // The board step: "(H12 ค้างที่ VP 18 ชม.)" — the history row still waiting, at the holder of its rule's position the
  // steps name, its hours the sheet's and past the SLA of its rule
  const boardStep = boardStepIn(scene)
  const late = historyOf(sheet, boardStep.ref)
  expect(late.status, `${late.ref} still waits for its approver`).toBe('PENDING_APPROVAL')
  expect(late.hours, `the hours of ${late.ref} in Demo_History`).toBe(boardStep.hours)
  const lateRole = approverByRule(sheet, late.expectedRule, late.chargedDept)
  expect(lateRole, `${late.ref} waits at the position the steps name`).toMatchObject({ member: late.expectedApprover, position: boardStep.position })
  const sla = ruleOf(sheet, late.expectedRule).slaBusinessHours
  if (sla === null) throw new Error(`DOA rule ${late.expectedRule} has no SLA in the DOA sheet`)
  expect(late.hours, `past the ${sla} business hours of rule ${late.expectedRule}`).toBeGreaterThan(sla)
  const vp = userOf(sheet, lateRole.member)

  // The dashboard step: "(ไอทีเหลือ 8%)" — the budget line of the department the steps name, below the share sheet
  // Settings warns at (digest.budgetLowPct), its share left the steps' whole percent
  const budgetStep = budgetStepIn(scene)
  const lowBp = basisPointsOf(settingOf(sheet, 'digest.budgetLowPct'))
  const named = [...sheet.budget].filter(([, l]) => nameIn(sheet.departments, l.department, 'department').includes(budgetStep.department))
  expect(named.map(([code]) => code), `sheet Budget has one line of the department "${budgetStep.department}"`).toHaveLength(1)
  const [lowCode, lowLine] = named[0]!
  const left = leftShareOf(lowLine.planned, lowLine.remaining)
  expect(left.bp / 100n, 'the whole percent the steps say').toBe(BigInt(budgetStep.pct))
  expect(left.bp, 'below the share sheet Settings warns at').toBeLessThan(lowBp)

  // The audit step: the AUDITOR of sheet Users exports (§16.10: user `auditor`); the decision of scene 2, on scene 1's request
  const auditors = [...sheet.users.values()].filter((u) => u.roles.includes('AUDITOR'))
  expect(auditors.map((u) => u.code), 'sheet Users has the one AUDITOR §16.10 names').toEqual(['auditor'])
  const auditor = auditors[0]!
  const asked = sceneOf(sheet, 1)
  const chat = sceneOf(sheet, 2)
  const pinned = sceneOf(sheet, 3)

  prepareTheDay(sheet)
  const doa = sheetDoa(sheet)
  const lateRequest = historyRequest(late.ref)
  const lateTask = openTaskOf(lateRequest)
  expect(lateTask, `${late.ref} waits at the approver the sheet expects`).toMatchObject({ assignee: vp.code, resolvedFrom: lateRole.resolvedFrom })
  // The hours of the history (from the seed's time), and the business minutes since the seed — under two business hours
  expect(lateRequest.waiting).toMatchObject({ taskId: lateTask.id, overdue: true })
  expect(lateRequest.waiting!.waitedMinutes, `${late.ref} has waited its hours of the history`).toBeGreaterThanOrEqual(late.hours * 60)
  expect(lateRequest.waiting!.waitedMinutes, 'and the business minutes since the seed of this run').toBeLessThan(late.hours * 60 + 120)
  const first = latestRequestOf(asked.actor, amountOf(asked, 'net'))
  const third = latestRequestOf(pinned.actor, amountOf(pinned, 'net'))
  if (!first?.number || !third?.number) throw new Error('scenes 1 and 3 sent no requests: run the demo scenes in order')
  const onChat = first.tasks.find((t) => t.decided?.channel === 'LINE_CHAT')
  const onLiff = third.tasks.find((t) => t.decided?.channel === 'LIFF')
  expect(onChat, 'scene 2 approved scene 1\'s request in the LINE chat').toMatchObject({ decided: { by: chat.actor, onBehalfOf: null, doaVersionId: doa.id, doaRuleCode: asked.expectedRule } })
  expect(onLiff, 'scene 3\'s request was approved in LIFF').toMatchObject({ decided: { by: pinned.expectedApprover, doaVersionId: doa.id, doaRuleCode: pinned.expectedRule } })

  // ---- the board (FR-VIS-001 AC1, AC3): the CEO sees the whole organization; the VP's row says how many wait, how many
  // are past their SLA and the oldest wait — H12's — as ApprovalTask says while the page is read
  await signInChecked(page, sheet, ceo.code, testInfo, 'scene9-ceo')
  const before = boardOf(vp.code)
  expect(before.tasks.find((t) => t.waitedMinutes === before.oldestMinutes)?.id, `the oldest wait at ${vp.code} is ${late.ref}'s`).toBe(lateTask.id)
  await page.goto('/board/pending')
  await expect(page.getByRole('heading', { level: 1, name: th('board.title') })).toBeVisible()
  await expect(page.getByText(th('board.scope.ORG'), { exact: true })).toBeVisible()
  const vpLink = page.getByRole('link', { name: th('board.table.nameLink', { name: vp.nameTh }), exact: true })
  const row = page.locator('tr:visible').filter({ has: vpLink })
  await expect(row).toHaveCount(1)
  await expect(row.getByRole('link', { name: th('board.table.openLink', { count: before.open, name: vp.nameTh }), exact: true })).toBeVisible()
  await expect(row.getByRole('link', { name: th('board.table.overdueLink', { count: before.overdue, name: vp.nameTh }), exact: true })).toBeVisible()
  const oldest = (await row.locator('td').nth(3).textContent())?.trim() ?? ''
  const between = boardOf(vp.code)
  expect(hoursBetween(before.oldestMinutes, between.oldestMinutes), `the oldest wait at ${vp.code} as the board writes it`).toContain(/^\d+\.\d/.exec(oldest)?.[0])
  await checkWebScreen(page, testInfo, 'scene9-board')

  // The VP's documents: H12 with its wait in business hours and the time it went past its SLA (FR-VIS-001 AC2's list)
  await vpLink.click()
  await expect(page).toHaveURL(new RegExp(`/board/pending/${before.memberId}$`))
  await expect(page.getByRole('heading', { level: 1, name: th('board.person.title', { name: vp.nameTh }) })).toBeVisible()
  await expect(page.getByText(th('board.person.summary', { open: before.open, overdue: before.overdue, waiting: before.waiting }))).toBeVisible()
  const item = page.getByRole('list', { name: th('board.person.listLabel', { name: vp.nameTh }) }).getByRole('listitem').filter({ hasText: lateRequest.number! })
  await expect(item).toHaveCount(1)
  await expect(item).toContainText(`${lateRequest.number} ${lateRequest.title}`)
  await expect(item).toContainText(th('board.document.overdue', { time: thaiDateTime(lateTask.dueAt!) }))
  const waited = (await item.textContent()) ?? ''
  const after = historyRequest(late.ref)
  const shown = hoursBetween(lateRequest.waiting!.waitedMinutes, after.waiting!.waitedMinutes).map((hours) => th('board.document.waited', { hours }))
  expect(shown.some((words) => waited.includes(words)), `"${waited}" says the wait of ${late.ref}: ${shown.join(' or ')}`).toBe(true)
  await checkWebScreen(page, testInfo, 'scene9-board-vp')

  // ---- the budget dashboard (FR-BUD-005 AC1): the line running low first, with its share left; its amounts, its
  // department's and the organization's as the ledger's balances have them
  const lines = budgetLinesNow()
  const lowNow = lines.find((l) => l.code === lowCode)
  if (!lowNow) throw new Error(`no budget line ${lowCode} in the database`)
  expect({ planned: BigInt(lowNow.planned), available: BigInt(lowNow.available) }, `${lowCode} as the history leaves it (sheet Budget)`).toEqual({ planned: lowLine.planned, available: lowLine.remaining })
  const low = lines.filter((l) => BigInt(l.planned) > 0n && BigInt(l.available) * 10_000n < BigInt(l.planned) * lowBp)
  expect(low.map((l) => l.code), 'the lines running low now: the one the steps name').toEqual([lowCode])
  await page.goto('/budgets')
  await expect(page.getByRole('heading', { level: 1, name: th('budgets.title') })).toBeVisible()
  await expect(page.getByText(th('budgets.low.title', { count: low.length }), { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: th('budgets.low.item', { code: lowCode, name: lowNow.nameTh, left: left.text }), exact: true })).toBeVisible()
  const lineRow = page.locator('tr:visible').filter({ has: page.getByRole('link', { name: lowCode, exact: true }) })
  await expect(lineRow).toHaveCount(1)
  await expect(lineRow).toContainText(th('budgets.low.badge', { left: left.text }))
  await expectBudgetRow(lineRow, lowCode, sumFigures([lowNow]))
  const departmentName = nameIn(sheet.departments, lowLine.department, 'department')
  const departmentRow = page.locator('tr:visible').filter({ has: page.getByRole('link', { name: th('budgets.table.departmentTotal', { name: departmentName }), exact: true }) })
  await expect(departmentRow).toHaveCount(1)
  await expectBudgetRow(departmentRow, departmentName, sumFigures(lines.filter((l) => l.department === lowLine.department)))
  const totalRow = page.locator('tfoot tr:visible')
  await expect(totalRow.getByRole('link', { name: th('budgets.table.total.ORG'), exact: true })).toBeVisible()
  await expectBudgetRow(totalRow, th('budgets.scope.ORG'), sumFigures(lines))
  await checkWebScreen(page, testInfo, 'scene9-budgets')

  // ---- the KPI (FR-VIS-003 AC2, §16.10): the share of purchase-request decisions on LINE or LIFF in the period the page
  // shows, counted from the decision events — scene 2's in the chat and scene 3's in LIFF among them
  await page.goto('/kpi')
  await expect(page.getByRole('heading', { level: 1, name: th('kpi.title') })).toBeVisible()
  const from = await page.locator('#kpi-from').inputValue()
  const to = await page.locator('#kpi-to').inputValue()
  const g5 = kpiOf(from, to)
  expect(g5.decisions).toEqual(
    expect.arrayContaining([
      { taskId: onChat!.id, channel: 'LINE_CHAT', kind: 'PURCHASE_REQUEST', onLine: true },
      { taskId: onLiff!.id, channel: 'LIFF', kind: 'PURCHASE_REQUEST', onLine: true },
    ]),
  )
  const pr = g5.byKind.PURCHASE_REQUEST
  if (!pr) throw new Error(`no purchase-request decisions from ${from} to ${to}`)
  const share = `${th('kpi.values.percent', { value: shareText(pr.numerator, pr.denominator) })} (${th('kpi.values.of.decisions', { numerator: pr.numerator, denominator: pr.denominator })})`
  const measure = th('kpi.measures.g5.byKind', { kind: th('kpi.kinds.PURCHASE_REQUEST') })
  const kpiLink = page.getByRole('link', { name: th('kpi.linkLabel', { name: measure, value: share }), exact: true })
  await expect(kpiLink).toBeVisible()
  // Beside it the Phase 0 baseline — none is recorded for the demo organization, and the page says so rather than
  // invent one — and the proposed target
  const kpiRow = page.locator('tr:visible').filter({ has: kpiLink })
  await expect(kpiRow).toContainText(th('kpi.baseline.notRecorded'))
  await expect(kpiRow).toContainText(th('kpi.measures.g5.target'))
  await expect(page.getByText(th('kpi.baseline.noneTitle'), { exact: true })).toBeVisible()
  await checkWebScreen(page, testInfo, 'scene9-kpi')

  // ---- the audit (§16.10, ADR-038 item 5): the audit trail is not the CEO's — the page says so, and the export the
  // CEO's browser asks for is refused with FORBIDDEN
  await page.goto('/audit')
  await expect(page.getByText(th('audit.forbidden'))).toBeVisible()
  await expect(page.getByRole('button', { name: th('audit.search.submit') })).toHaveCount(0)
  await checkWebScreen(page, testInfo, 'scene9-audit-ceo')
  const refused = await page.evaluate(async (body) => {
    const response = await fetch('/audit/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: (await response.json()) as unknown }
  }, { idempotencyKey: randomUUID(), format: 'xlsx', filter: { document: first.number } })
  expect(refused).toMatchObject({ status: 403, body: { ok: false, code: 'FORBIDDEN' } })

  // The auditor, at their own computer: scene 1's request's trail — the decision of scene 2 in the LINE chat by the
  // approver, under the DOA version and rule — exported as Excel (FR-VIS-004 AC2, FR-DOA-005 AC3)
  const desk = await anotherDesk(browser)
  try {
    const audit = await desk.newPage()
    await signInChecked(audit, sheet, auditor.code, testInfo, 'scene9-auditor')
    await audit.goto(`/audit?document=${encodeURIComponent(first.number)}`)
    await expect(audit.getByRole('heading', { level: 1, name: th('audit.title') })).toBeVisible()
    const decision = audit.locator('table:visible tbody tr').filter({ hasText: 'ตัดสินงานอนุมัติ: อนุมัติ' }).filter({ hasText: channelLabel('LINE_CHAT') })
    await expect(decision).toHaveCount(1)
    await expect(decision).toContainText(userOf(sheet, chat.actor).nameTh)
    await expect(decision).toContainText(doaRefOf(doa, asked.expectedRule!))
    await checkWebScreen(audit, testInfo, 'scene9-audit')
    const bytes = await exportedFile(audit, 'ส่งออก Excel')
    await expect(audit.getByRole('status').filter({ hasText: /^ส่งออกแล้ว \d+ แถว/ })).toBeVisible()
    expect(sha256(bytes), 'the file is the one whose checksum the page shows').toBe(await shownChecksum(audit))
    const [header = [], ...rows] = await sheetRows(bytes, 20)
    const column = Object.fromEntries(AUDIT_COLUMNS.map((name) => [name, header.indexOf(name)])) as Record<(typeof AUDIT_COLUMNS)[number], number>
    for (const name of AUDIT_COLUMNS) expect(column[name], `the export has the column ${name}`).toBeGreaterThanOrEqual(0)
    const decided = rows.filter((r) => r[column.type] === 'approval_task.decided' && r[column.aggregateId] === onChat!.id)
    expect(decided, 'scene 2\'s decision is in the file once').toHaveLength(1)
    expect(Object.fromEntries((['channel', 'doaVersionId', 'doaRuleCode', 'actor', 'onBehalfOf'] as const).map((name) => [name, decided[0]![column[name]]]))).toEqual({
      channel: 'LINE_CHAT',
      doaVersionId: doa.id,
      doaRuleCode: asked.expectedRule,
      actor: userOf(sheet, chat.actor).nameTh,
      onBehalfOf: '',
    })
    await checkWebScreen(audit, testInfo, 'scene9-audit-exported')
  } finally {
    await desk.close()
  }
  // What the board's figures were read from did not change while the page was read: still past the SLA
  expect(after.waiting).toMatchObject({ taskId: lateTask.id, overdue: true })
})
