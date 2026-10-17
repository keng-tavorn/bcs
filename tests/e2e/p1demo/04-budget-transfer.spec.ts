import { E2E_PIN } from '../../support/e2e-env'
import { anotherDesk, baht, literally, th, typed } from '../demo/support'
import { expect, test } from '../fixtures'
import { budgetLineOf, columnOf, day, expectedOf, expectedSatang, fiscalYearOf, p1Sheet, ruleOf, satangOf, sceneOf, script, signInAs, todayInBangkok } from './support'

// Scene 4 of the day of phase 1 (sheet Demo_Script_P1 · S6 · FR-BUD-103): the budget officer moves money that the
// equipment rental of project P07 will not use to its subcontract line, both lines of the fiscal year of the day the
// scene runs. Sent, the source line holds the amount and the DOA's BUDGET_TRANSFER rule of the row sends it to the VP of
// the lines' division, who approves on the web with the PIN (the amount is at the DOA's stepUpThreshold or above). The
// budget dashboard then shows, for each line, how it came to its planned amount: the initial budget of sheet Budget, the
// transfer out or in, and the planned amount now. Who acts, the lines, the amount, the reason, the rule and the approver
// come from the row and the sheets it names; the transfer and its task are found by what the form sent, never by a
// typed number or by place in the inbox — the approver holds other open tasks already, of the history's requests.

interface LineNow {
  readonly code: string
  readonly planned: string
  readonly available: string
  readonly reserved: string
  readonly moves: ReadonlyArray<{ readonly from: string; readonly to: string; readonly amount: string }>
}

interface TaskNow {
  readonly id: string
  readonly status: string
  readonly decision: string | null
  readonly channel: string | null
  readonly assignee: string | null
  readonly resolvedFrom: string
  readonly decided: { readonly channel: string; readonly by: string | null; readonly doaRuleCode: string | null; readonly stepUp: boolean } | null
  readonly stepUpGrant: { readonly method: string; readonly by: string | null; readonly subjectType: string; readonly subjectId: string; readonly used: boolean } | null
}

interface TransferNow {
  readonly id: string
  readonly number: string | null
  readonly kind: string
  readonly status: string
  readonly amount: string
  readonly reason: string
  readonly submittedBy: string | null
  readonly from: LineNow | null
  readonly to: LineNow | null
  readonly routes: ReadonlyArray<{ readonly ruleCode: string; readonly amount: string | null; readonly doa: { readonly code: string; readonly versionNo: number }; readonly tasks: readonly TaskNow[] }>
  readonly events: ReadonlyArray<{ readonly type: string; readonly channel: string }>
}

interface BudgetLineNow {
  readonly code: string
  readonly fiscalYear: string
  readonly planned: string
  readonly available: string
  readonly reserved: string
}

const S6 = 'scripts/s6-admin.ts'
const transferNow = (id: string) => script<TransferNow>(S6, 'transfer', id)
const UUID = /\/budgets\/transfers\/([0-9a-f-]{36})\?sent=1$/

test('@p1demo [FR-BUD-103/AC1] [FR-BUD-103/AC3] scene 4: the budget officer transfers between two lines of P07; the VP of the division approves with the PIN; the dashboard shows each line’s initial budget, the transfer and its planned amount now', async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000)
  const sheet = await p1Sheet()
  const scene = sceneOf(sheet, 4)
  expect(scene.channel).toBe('WEB')
  expect(scene.expectedOutcome).toBe('APPROVED')
  const kind = expectedOf<string>(scene, 'kind')
  const fromKey = expectedOf<string>(scene, 'fromKey')
  const toKey = expectedOf<string>(scene, 'toKey')
  const amount = expectedSatang(scene, 'amount')
  const reason = expectedOf<string>(scene, 'reasonTh')
  const rule = expectedOf<string>(scene, 'rule')
  const approver = expectedOf<string>(scene, 'approver')
  const events = expectedOf<string[]>(scene, 'events')
  expect(expectedOf<string>(scene, 'plannedFrom')).toBe('SHEET_BUDGET_OF_RUN_FY')
  const dashboard = expectedOf<{
    from: { transferredOut: string; currentIsPlannedMinusAmount: boolean }
    to: { transferredIn: string; currentIsPlannedPlusAmount: boolean }
  }>(scene, 'dashboard')
  expect(expectedOf<boolean>(scene, 'pin')).toBe(true)
  // The row's columns say the same as its expectJson; the amount is at the step-up threshold or above
  expect(scene.budgetKey).toBe(fromKey)
  expect(columnOf(scene, 'net')).toBe(amount)
  expect(scene.expectedRule).toBe(rule)
  expect(scene.expectedApprover).toBe(approver)
  expect(scene.others).toContain(approver)
  expect(amount).toBeGreaterThanOrEqual(sheet.doa.stepUpThreshold)
  const band = ruleOf(sheet, rule)
  expect(band.documentType).toBe('BUDGET_TRANSFER')
  if (band.gt !== null) expect(amount).toBeGreaterThan(band.gt)
  if (band.lte !== null) expect(amount).toBeLessThanOrEqual(band.lte)

  // The two lines of the fiscal year of today, as sheet Budget plans them and as they stand before the scene
  const fiscalYear = fiscalYearOf(todayInBangkok())
  const from = budgetLineOf(sheet, fromKey)
  const to = budgetLineOf(sheet, toKey)
  const lines = day<BudgetLineNow[]>('budgets')
  const lineNow = (code: string) => {
    const line = lines.find((l) => l.code === code)
    if (!line) throw new Error(`no budget line ${code} in the database`)
    expect(line.fiscalYear).toBe(fiscalYear)
    return line
  }
  const [fromBefore, toBefore] = [lineNow(from.code), lineNow(to.code)]
  // The planned amounts are still sheet Budget's (nothing before this scene moved them), and the source has the room
  expect(BigInt(fromBefore.planned), `${from.code} is planned as sheet Budget says`).toBe(from.planned)
  expect(BigInt(toBefore.planned), `${to.code} is planned as sheet Budget says`).toBe(to.planned)
  expect(BigInt(fromBefore.available), `${from.code} has ${baht(amount)} left to move`).toBeGreaterThanOrEqual(amount)

  // The budget officer: the dashboard → the transfers → a new transfer between the two lines
  await signInAs(page, sheet, scene.actor)
  await page.goto('/budgets')
  await expect(page.getByRole('heading', { level: 1, name: th('budgets.title') })).toBeVisible()
  await page.getByRole('link', { name: th('budgetTransfer.title'), exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: th('budgetTransfer.title') })).toBeVisible()
  await page.getByRole('link', { name: th('budgetTransfer.new'), exact: true }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: th('budgetTransfer.new') })).toBeVisible()
  await expect(page.getByText(th('budgetTransfer.form.intro', { code: fiscalYear }))).toBeVisible()
  await page.getByRole('radio', { name: new RegExp(`^${literally(th(`budgetTransfer.kind.${kind}`))}`) }).check()
  const option = (code: string, nameTh: string, department: string, available: string) => th('budgetTransfer.form.lineOption', { code, name: nameTh, department, available: baht(BigInt(available)) })
  const fromSelect = page.getByLabel(th('budgetTransfer.form.from'), { exact: true })
  await fromSelect.selectOption({ label: option(from.code, from.nameTh, from.department, fromBefore.available) })
  await expect(page.getByText(th('budgetTransfer.form.available', { amount: baht(BigInt(fromBefore.available)) }))).toBeVisible()
  await page.getByLabel(th('budgetTransfer.form.to'), { exact: true }).selectOption({ label: option(to.code, to.nameTh, to.department, toBefore.available) })
  await page.getByLabel(th('budgetTransfer.form.amount'), { exact: true }).fill(typed(amount))
  await page.getByLabel(th('budgetTransfer.form.reason'), { exact: true }).fill(reason)
  await page.getByRole('button', { name: th('budgetTransfer.form.submit'), exact: true }).click()

  // Sent: its page says so, with its number; the source line holds the amount until it is decided
  await expect(page).toHaveURL(UUID)
  const transferId = UUID.exec(page.url())![1]!
  const sent = transferNow(transferId)
  expect(sent).toMatchObject({ kind, status: 'PENDING_APPROVAL', amount: amount.toString(), reason, submittedBy: scene.actor, from: { code: from.code }, to: { code: to.code } })
  const number = sent.number!
  await expect(page.getByText(th('budgetTransfer.detail.sent', { number }))).toBeVisible()
  await expect(page.getByText(th('budgetTransfer.status.PENDING_APPROVAL'), { exact: true }).first()).toBeVisible()
  expect(BigInt(sent.from!.reserved)).toBe(BigInt(fromBefore.reserved) + amount)
  expect(BigInt(sent.from!.available)).toBe(BigInt(fromBefore.available) - amount)
  // The route: the row's rule of the DOA in effect, for the amount, at the row's approver
  expect(sent.routes).toHaveLength(1)
  expect(sent.routes[0]).toMatchObject({ ruleCode: rule, amount: amount.toString(), doa: { code: sheet.doa.code, versionNo: sheet.doa.version } })
  const open = script<{ open: ReadonlyArray<TaskNow & { ruleCode: string; amount: string | null }> }>(S6, 'subject-task', 'BUDGET_TRANSFER', transferId).open
  expect(open).toEqual([expect.objectContaining({ assignee: approver, ruleCode: rule, amount: amount.toString() })])
  const taskId = open[0]!.id

  // The VP on a computer of their own: the inbox says this one needs the PIN; the task names the transfer and what
  // approving does; approved with the PIN in the second press
  const desk = await anotherDesk(browser)
  try {
    const vp = await desk.newPage()
    await signInAs(vp, sheet, approver)
    await vp.goto('/tasks')
    const row = vp
      .getByRole('list', { name: th('tasks.listLabel') })
      .getByRole('listitem')
      .filter({ has: vp.locator(`a[href="/tasks/${taskId}"]`) })
    await expect(row).toContainText(number)
    await expect(row).toContainText(th('tasks.item.stepUp'))
    await row.locator(`a[href="/tasks/${taskId}"]`).first().click()
    await expect(vp.getByRole('heading', { level: 1 })).toHaveText(th('budgetTransfer.task.heading', { kind: th(`budgetTransfer.kind.${kind}`), number }))
    await expect(vp.getByText(th(`budgetTransfer.task.effect.${kind}`))).toBeVisible()
    await vp.getByRole('button', { name: th('tasks.decide.approve'), exact: true }).click()
    const confirm = vp.getByRole('group', { name: th('tasks.decide.transfer.confirmText', { label: number, amount: baht(amount) }) })
    await confirm.getByLabel(th('tasks.decide.pin'), { exact: true }).fill(E2E_PIN)
    await confirm.getByRole('button', { name: th('tasks.decide.confirm'), exact: true }).click()
    await expect(vp.getByRole('status').filter({ hasText: th('tasks.decide.approved') }).first()).toBeVisible()
  } finally {
    await desk.close()
  }

  // Approved under the row's rule on the web with the PIN — a step-up grant of the VP for this transfer, spent on the
  // decision: the amount left the source and entered the destination
  const done = transferNow(transferId)
  expect(done.status).toBe('APPROVED')
  expect(done.routes[0]!.tasks).toEqual([
    expect.objectContaining({
      id: taskId,
      status: 'APPROVED',
      decision: 'APPROVE',
      assignee: approver,
      decided: { channel: scene.channel, by: approver, doaRuleCode: rule, stepUp: true },
      stepUpGrant: { method: 'PIN', by: approver, subjectType: 'BUDGET_TRANSFER', subjectId: transferId, used: true },
    }),
  ])
  expect(done.events.map((e) => e.type)).toEqual(expect.arrayContaining(events))
  expect(done.events.filter((e) => events.includes(e.type)).map((e) => e.type)).toEqual(events)
  const out = satangOf(dashboard.from.transferredOut)!
  const into = satangOf(dashboard.to.transferredIn)!
  expect(out).toBe(amount)
  expect(into).toBe(amount)
  const fromPlanned = dashboard.from.currentIsPlannedMinusAmount ? from.planned - amount : from.planned
  const toPlanned = dashboard.to.currentIsPlannedPlusAmount ? to.planned + amount : to.planned
  expect(BigInt(done.from!.planned)).toBe(fromPlanned)
  expect(BigInt(done.to!.planned)).toBe(toPlanned)
  expect(BigInt(done.from!.reserved)).toBe(BigInt(fromBefore.reserved))
  expect(BigInt(done.to!.available)).toBe(BigInt(toBefore.available) + amount)
  // In the ledger: the source's hold left it (to OUTSIDE), the destination got it (from OUTSIDE)
  expect(done.from!.moves.filter((m) => m.to === 'OUTSIDE').map((m) => BigInt(m.amount))).toEqual([out])
  expect(done.to!.moves.filter((m) => m.from === 'OUTSIDE').map((m) => BigInt(m.amount))).toEqual([into])

  // The dashboard (FR-BUD-103 AC3): each line's changes behind its button — the initial budget of sheet Budget, the
  // transfer, and the planned amount now
  await page.goto('/budgets')
  for (const [line, term, moved, now] of [
    [from, 'transferredOut', out, fromPlanned],
    [to, 'transferredIn', into, toPlanned],
  ] as const) {
    const toggle = page.getByRole('button', { name: `${th('budgets.changes.toggle')} ${line.code}`, exact: true })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('link', { name: th('budgets.changes.initialLink', { amount: baht(line.planned), code: line.code }), exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: th('budgets.changes.link', { term: th(`budgets.changes.${term}`), amount: baht(moved), code: line.code }), exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: th('budgets.table.plannedLink', { amount: baht(now), code: line.code }), exact: true }).last()).toBeVisible()
  }
})

