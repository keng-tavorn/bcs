import { type Locator } from '@playwright/test'
import { E2E_PIN } from '../../support/e2e-env'
import { anotherDesk, baht, th, typed } from '../demo/support'
import { expect, test } from '../fixtures'
import { columnOf, day, expectedOf, historyOf, p1Sheet, satangOf, sceneOf, script, signInAs, todayInBangkok, userOf, type P1Sheet } from './support'

// Scene 3 of the day of phase 1 (sheet Demo_Script_P1 · S6 · FR-WF-103): the second admin lowers the threshold of the
// parallel reviewers of contract work in a draft of the workflow in effect, tries the draft with one request of the
// row's amount beside the version in effect, backtests it over 90 days and sends it; the CEO — the approver of the
// DOA's DOA_CHANGE rule — reads the change and approves it with the PIN. The draft is approved for its default date (the
// first day of next month, never today), so the version in effect stays in effect for the rest of the day and no later
// scene meets the new thresholds (expectJson.changesLaterScenes = false). Who acts, the workflow, the rules and their
// thresholds, the try-out request, the backtest's answer and the approver come from the row and the sheets it names.

interface VersionFacts {
  readonly id: string
  readonly versionNo: number
  readonly status: string
  readonly effectiveFrom: string
  readonly effectiveTo: string | null
  readonly changeReason: string | null
  readonly submittedBy: string | null
  readonly approvedBy: string | null
  readonly rules: ReadonlyArray<{ readonly code: string; readonly requestTypeCodes: readonly string[]; readonly when: unknown }>
  readonly events: ReadonlyArray<{ readonly type: string; readonly data: Record<string, unknown> }>
}

interface WorkflowFacts {
  readonly now: string
  readonly inEffectVersionNo: number | null
  readonly versions: readonly VersionFacts[]
  readonly open: ReadonlyArray<{ readonly taskId: string; readonly versionId: string; readonly versionNo: number; readonly assignee: string | null; readonly ruleCode: string; readonly doa: { readonly code: string; readonly versionNo: number } }>
}

interface DraftRule {
  readonly rule: string
  readonly field: string
  readonly op: string
  readonly from: string
  readonly to: string
}

const S6 = 'scripts/s6-admin.ts'
const workflowOf = (code: string) => script<WorkflowFacts>(S6, 'workflow', code)

/** "RV-03=dm_leg" of expectJson → the rule and the member */
function pairOf(text: string): { rule: string; member: string } {
  const [rule, member] = text.split('=').map((s) => s.trim())
  if (!rule || !member) throw new Error(`"${text}" is not RULE=member`)
  return { rule, member }
}

/** A condition row as the workflow screens write it: "ยอดรวม VAT มากกว่า 500,000.00 บาท" */
function conditionText(r: DraftRule, value: string): string {
  const amount = satangOf(value)
  if (amount === null) throw new Error(`expectJson draftRules ${r.rule}: ${value} is not an amount in baht`)
  return th('adminWorkflow.rowText', { field: th(`adminWorkflow.variables.${r.field.replace(/^\$/, '')}`), op: th(`adminWorkflow.ops.${r.op}`), value: th('adminWorkflow.baht', { amount: baht(amount) }) })
}

/** The first day of next month, 00:00 Thai time: the default start the editor offers (DEFAULT_FIRST_OF_NEXT_MONTH) */
function firstOfNextMonth(today: string): string {
  const [year, month] = today.split('-').map(Number) as [number, number]
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 }
  return new Date(`${next.y}-${String(next.m).padStart(2, '0')}-01T00:00:00+07:00`).toISOString()
}

const nameOf = (sheet: P1Sheet, code: string) => userOf(sheet, code).nameTh

async function selectByLabel(select: Locator, label: string) {
  await expect(select.locator('option', { hasText: label }).first()).toBeAttached()
  await select.selectOption({ label })
}

test('@p1demo [FR-WF-103/AC1] [FR-WF-103/AC2] [FR-WF-103/AC3] scene 3: the second admin lowers the contract-work reviewer threshold in a draft, tries it beside the version in effect, backtests and sends it; the CEO approves with the PIN and the draft waits for its date', async ({
  page,
  browser,
}) => {
  test.setTimeout(480_000)
  const sheet = await p1Sheet()
  const scene = sceneOf(sheet, 3)
  expect(scene.channel).toBe('WEB')
  expect(scene.expectedOutcome).toBe('APPROVED')
  const code = expectedOf<string>(scene, 'workflowCode')
  const fromVersion = expectedOf<number>(scene, 'fromVersion')
  const draftVersion = expectedOf<number>(scene, 'draftVersion')
  const ruleCount = expectedOf<number>(scene, 'rules')
  const draftRules = expectedOf<DraftRule[]>(scene, 'draftRules')
  const reason = expectedOf<string>(scene, 'changeReasonTh')
  expect(expectedOf<string>(scene, 'effectiveDate')).toBe('DEFAULT_FIRST_OF_NEXT_MONTH')
  const dryRun = expectedOf<{ requestType: string; amountGross: string; requester: string; department: string }>(scene, 'dryRun')
  const liveReviewers = expectedOf<string[]>(scene, 'liveReviewers').map(pairOf)
  const draftReviewers = expectedOf<string[]>(scene, 'draftReviewers').map(pairOf)
  const doaRule = expectedOf<string>(scene, 'doaRule')
  const doaApprover = expectedOf<string>(scene, 'doaApprover')
  const backtest = expectedOf<{ windowDays: number; changed: number; refs: string[] }>(scene, 'backtest')
  const approvalRule = expectedOf<string>(scene, 'approvalRule')
  const approver = expectedOf<string>(scene, 'approver')
  expect(expectedOf<boolean>(scene, 'pin')).toBe(true)
  const afterApproval = expectedOf<{ v1: string; v2: string }>(scene, 'afterApproval')
  expect(expectedOf<boolean>(scene, 'changesLaterScenes')).toBe(false)
  // The row's columns say the same as its expectJson
  expect(scene.expectedRule).toBe(approvalRule)
  expect(scene.expectedApprover).toBe(approver)
  expect(scene.others).toContain(approver)
  expect(scene.requestType).toBe(dryRun.requestType)
  expect(scene.chargedDept).toBe(dryRun.department)
  expect(columnOf(scene, 'gross')).toBe(satangOf(dryRun.amountGross))

  const v1 = th('adminWorkflow.versionName', { code, version: fromVersion })
  const v2 = th('adminWorkflow.versionName', { code, version: draftVersion })
  const ceoName = nameOf(sheet, approver)
  // The backtest's documents: requests of Request_History, by the titles the seed gave them
  const changedDocs = backtest.refs.map((ref) => {
    const facts = day<{ number: string; title: string } | null>('history', ref)
    if (!facts) throw new Error(`no request of Request_History ${ref} in the database`)
    expect(facts.title).toBe(historyOf(sheet, ref).title)
    expect(historyOf(sheet, ref).daysAgo, `${ref} was sent inside the backtest's window`).toBeLessThan(backtest.windowDays)
    return facts
  })
  expect(changedDocs).toHaveLength(backtest.changed)

  // Before: the workflow has the version of the seed only, in effect, with the rules of sheet Workflow_Reviewers
  const before = workflowOf(code)
  expect(before.versions.map((v) => [v.versionNo, v.status])).toEqual([[fromVersion, 'PUBLISHED']])
  expect(before.inEffectVersionNo).toBe(fromVersion)
  expect(before.versions[0]!.rules).toHaveLength(ruleCount)
  for (const r of draftRules) {
    const rule = before.versions[0]!.rules.find((x) => x.code === r.rule)
    expect(rule, `${v1} has rule ${r.rule}`).toBeTruthy()
    expect(rule!.requestTypeCodes).toContain(dryRun.requestType)
    expect(rule!.when).toEqual({ field: r.field, op: r.op, value: r.from })
  }

  await signInAs(page, sheet, scene.actor)

  // The list: version 1 in effect; the main action makes a draft copied from it
  await page.goto('/admin/workflows')
  await expect(page.getByRole('heading', { level: 1, name: th('adminWorkflow.title') })).toBeVisible()
  const versions = page.getByRole('region', { name: th('adminWorkflow.list.title', { count: 1 }) })
  const v1Item = versions.getByRole('listitem').filter({ hasText: v1 })
  await expect(v1Item).toContainText(th('adminWorkflow.status.IN_EFFECT'))
  await expect(v1Item).toContainText(th('adminWorkflow.rulesCount', { count: ruleCount }))
  await page
    .getByRole('region', { name: th('adminWorkflow.list.startTitle') })
    .getByRole('button', { name: th('adminWorkflow.list.create', { name: v1 }) })
    .click()

  // The draft: the three rules of contract work, each edited in its Dialog to the row's new threshold
  await expect(page).toHaveURL(/\/admin\/workflows\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { level: 1, name: v2 })).toBeVisible()
  const rules = page.getByRole('list', { name: th('adminWorkflow.rulesListLabel') })
  await expect(rules.getByRole('listitem')).toHaveCount(ruleCount)
  for (const r of draftRules) {
    const item = rules.getByRole('listitem').filter({ hasText: r.rule })
    await expect(item).toContainText(conditionText(r, r.from))
    await page.getByRole('button', { name: th('adminWorkflow.editRule', { rule: r.rule }), exact: true }).click()
    const dialog = page.getByRole('dialog', { name: th('adminWorkflow.dialog.editTitle', { rule: r.rule }) })
    const row = dialog.getByRole('group', { name: th('adminWorkflow.conditionRow', { n: 1 }), exact: true })
    const amount = row.getByLabel(th('adminWorkflow.conditionAmount'), { exact: true })
    await expect(amount).toHaveValue(r.from)
    await amount.fill(typed(satangOf(r.to)!))
    await dialog.getByRole('button', { name: th('adminWorkflow.dialog.next'), exact: true }).click()
    await dialog.getByRole('button', { name: th('adminWorkflow.dialog.saveRule'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(item).toContainText(conditionText(r, r.to))
  }
  // The start date stays as the editor offers it; the reason, then the draft is saved
  await page.getByLabel(th('adminWorkflow.reason'), { exact: true }).fill(reason)
  await page.getByRole('button', { name: th('adminWorkflow.save', { name: v2 }), exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: th('adminWorkflow.saved', { name: v2 }) })).toBeVisible()

  // Saved but not tried: the send stays closed and says why
  await page.getByRole('tab', { name: th('adminWorkflow.tabs.check') }).click()
  await expect(page.getByText(th('adminWorkflow.submit.needDryRun'))).toBeVisible()
  await expect(page.getByRole('button', { name: th('adminWorkflow.submit.button'), exact: true })).toBeDisabled()

  // The try-out (FR-WF-103 AC2): the row's request type and amount with VAT, its requester and department — the version
  // in effect sends it straight to the DOA, the draft through the three reviewers first
  await page.getByRole('tab', { name: th('adminWorkflow.tabs.dryRun') }).click()
  await selectByLabel(page.getByLabel(th('adminWorkflow.document.requestType'), { exact: true }), sheet.requestTypes.get(dryRun.requestType)!)
  await page.getByLabel(th('adminWorkflow.document.amountGross'), { exact: true }).fill(typed(satangOf(dryRun.amountGross)!))
  await selectByLabel(page.getByLabel(th('adminWorkflow.dryRun.requester'), { exact: true }), nameOf(sheet, dryRun.requester))
  const department = page.getByLabel(th('adminWorkflow.dryRun.department'), { exact: true })
  const departmentValue = await department.locator('option', { hasText: `(${dryRun.department})` }).first().getAttribute('value')
  await department.selectOption(departmentValue!)
  await page.getByRole('button', { name: th('adminWorkflow.dryRun.run'), exact: true }).click()
  await expect(page.getByText(th('adminWorkflow.dryRun.changed'))).toBeVisible()
  const current = page.getByRole('region', { name: th('adminWorkflow.dryRun.currentTitle', { name: v1 }) })
  const draft = page.getByRole('region', { name: th('adminWorkflow.dryRun.draftTitle', { name: v2 }) })
  if (liveReviewers.length === 0) await expect(current).toContainText(th('adminWorkflow.dryRun.noReview'))
  for (const r of liveReviewers) await expect(current).toContainText(th('adminWorkflow.dryRun.slot', { rules: r.rule, names: nameOf(sheet, r.member) }))
  const doaLine = th('adminWorkflow.dryRun.approvalLine', { rule: doaRule, names: nameOf(sheet, doaApprover) })
  await expect(current).toContainText(doaLine)
  for (const r of draftReviewers) await expect(draft).toContainText(th('adminWorkflow.dryRun.slot', { rules: r.rule, names: nameOf(sheet, r.member) }))
  await expect(draft).toContainText(doaLine)
  await expect(draft).toContainText(th('adminWorkflow.dryRun.differs'))

  // The 90-day backtest (FR-WF-103 AC2, BR-WF-13): the requests of the history the draft would route otherwise
  await page.getByRole('tab', { name: th('adminWorkflow.tabs.backtest') }).click()
  await page.getByRole('button', { name: th('backtest.run'), exact: true }).click()
  await expect(page.getByText(`เปลี่ยนเส้นทาง ${backtest.changed} ฉบับ`)).toBeVisible()
  const changed = page.getByRole('region', { name: th('backtest.rowsTitle', { count: backtest.changed }) })
  const rows = changed.getByRole('list', { name: th('backtest.rowsLabel') }).getByRole('listitem')
  await expect(rows).toHaveCount(backtest.changed)
  for (const doc of changedDocs) {
    const row = rows.filter({ hasText: `${doc.number} ${doc.title}` })
    await expect(row).toBeVisible()
    await expect(row).toContainText(th('backtest.noReviewers'))
    for (const r of draftReviewers) await expect(row).toContainText(nameOf(sheet, r.member))
  }

  // The send (FR-WF-103 AC3): open now, every warning ticked, to the approver of DOA_CHANGE under the DOA in effect
  await page.getByRole('tab', { name: th('adminWorkflow.tabs.check') }).click()
  await expect(page.getByRole('listitem').filter({ hasText: th('adminWorkflow.submit.dryRunDone') })).toContainText(th('adminWorkflow.submit.met'))
  for (const box of await page.getByRole('group', { name: th('adminWorkflow.submit.warningsTitle') }).getByRole('checkbox').all()) await box.check()
  const ref = th('adminWorkflow.doaRef', { code: sheet.doa.code, version: sheet.doa.version, rule: approvalRule })
  await expect(page.getByText(th('adminWorkflow.submit.approverLine', { names: ceoName, ref }))).toBeVisible()
  await page.getByRole('button', { name: th('adminWorkflow.submit.button'), exact: true }).click()
  const confirm = page.getByRole('alertdialog', { name: th('adminWorkflow.submit.confirmTitle', { name: v2 }) })
  await expect(confirm).toContainText(ceoName)
  await confirm.getByRole('button', { name: th('adminWorkflow.submit.button'), exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: th('adminWorkflow.submit.sent', { name: ceoName }) }).first()).toBeVisible()
  await expect(page.getByText(th('adminWorkflow.readOnlyPending'))).toBeVisible()

  // Waiting for the CEO under DOA_CHANGE's rule; the draft as saved: the three thresholds and the reason
  const sent = workflowOf(code)
  const pending = sent.versions.find((v) => v.versionNo === draftVersion)!
  expect(pending).toMatchObject({ status: 'PENDING_APPROVAL', submittedBy: scene.actor, changeReason: reason, effectiveFrom: firstOfNextMonth(todayInBangkok()) })
  for (const r of draftRules) expect(pending.rules.find((x) => x.code === r.rule)?.when).toEqual({ field: r.field, op: r.op, value: r.to })
  expect(pending.rules).toHaveLength(ruleCount)
  expect(sent.open).toEqual([expect.objectContaining({ versionNo: draftVersion, assignee: approver, ruleCode: approvalRule, doa: { code: sheet.doa.code, versionNo: sheet.doa.version } })])
  const task = sent.open[0]!

  // The CEO on a computer of their own: reads the change, then approves it with the PIN (BR-WF-12: every time), on the
  // PIN path whether or not a passkey is offered beside it
  const desk = await anotherDesk(browser)
  try {
    const ceo = await desk.newPage()
    await signInAs(ceo, sheet, approver)
    await ceo.goto(`/tasks/${task.taskId}`)
    await expect(ceo.getByRole('heading', { level: 1 })).toContainText(v2)
    await ceo.getByRole('link', { name: th('tasks.workflow.open') }).click()
    await expect(ceo).toHaveURL(new RegExp(`/admin/workflows/${task.versionId}$`))
    await ceo.getByRole('tab', { name: th('adminWorkflow.tabs.diff') }).click()
    for (const r of draftRules) await expect(ceo.getByText(th('adminWorkflow.diff.changed', { rule: r.rule })).first()).toBeVisible()
    await ceo.goto(`/tasks/${task.taskId}`)
    const approve = ceo.getByRole('button', { name: th('tasks.policy.approve'), exact: true })
    const approveForm = ceo.locator('form').filter({ has: approve })
    await approveForm.getByLabel(th('tasks.policy.pin'), { exact: true }).fill(E2E_PIN)
    await approve.click()
    await expect(ceo.getByRole('status').filter({ hasText: th('tasks.policy.approved') })).toBeVisible()
  } finally {
    await desk.close()
  }

  // Approved for its date: version 2 waits for it, version 1 stays in effect until then — no later scene of the day
  // meets the new thresholds
  const after = workflowOf(code)
  const [one, two] = [after.versions.find((v) => v.versionNo === fromVersion)!, after.versions.find((v) => v.versionNo === draftVersion)!]
  expect(two).toMatchObject({ status: 'PUBLISHED', approvedBy: approver, effectiveFrom: firstOfNextMonth(todayInBangkok()) })
  expect(one).toMatchObject({ status: 'PUBLISHED', effectiveTo: two.effectiveFrom })
  expect(new Date(two.effectiveFrom).getTime()).toBeGreaterThan(new Date(after.now).getTime())
  expect(after.inEffectVersionNo).toBe(fromVersion)
  expect(after.open).toEqual([])
  const story = ['workflow_version.drafted', 'workflow_version.updated', 'workflow_version.dry_run', 'workflow_version.submitted', 'workflow_version.approved', 'workflow_version.published']
  expect(two.events.map((e) => e.type).filter((type) => story.includes(type))).toEqual(story)
  expect(two.events.find((e) => e.type === 'workflow_version.published')?.data).toMatchObject({ effectiveFrom: two.effectiveFrom, via: 'APPROVAL' })
  const look = (v: string) => th(`adminWorkflow.status.${v}`)
  await page.goto('/admin/workflows')
  const all = page.getByRole('region', { name: th('adminWorkflow.list.title', { count: 2 }) })
  await expect(all.getByRole('listitem').filter({ hasText: v2 })).toContainText(look(afterApproval.v2))
  await expect(all.getByRole('listitem').filter({ hasText: v1 })).toContainText(look(afterApproval.v1))
  await expect(all.getByRole('listitem').filter({ hasText: v2 })).toContainText(th('adminWorkflow.approvedBy', { name: ceoName, time: '' }).trim())
})
