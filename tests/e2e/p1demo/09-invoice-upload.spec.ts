import { formatThaiDay } from '../../../src/core/thai/day'
import { scannedInvoicePdf } from '../../../src/server/seed/etax-sample'
import { baht, th, typed } from '../demo/support'
import { expect, test } from '../fixtures'
import {
  confirmCoding,
  dayAfter,
  deskAs,
  eventSeq,
  expectAmounts,
  expectBudgetMoved,
  expectEvents,
  expectRunDate,
  h1,
  invoiceOf,
  poOfHistory,
  saveHeader,
  shown,
  submitDraft,
  uploadDraft,
} from './money-steps'
import { approverByRule, columnOf, expectedOf, expectedSatang, historyOf, p1Sheet, ruleOf, sceneOf, signInAs, todayInBangkok, userOf } from './support'

// Scene 9 of the day of phase 1 (P1-08 · S8 · INVOICE_UPLOAD): FINANCE uploads the supplier's paper invoice for a
// delivery the history received in full, types its number, date and VAT, and its unit price — higher than the PO's,
// beyond the tolerance of sheet Settings — and submits it: the match sends the difference to procurement. Procurement
// asks for the variance to be approved; the DOA routes it by the variance with its VAT to the rule and the approver the
// row names (no PIN below the stepUpThreshold); once approved the invoice is ready for payment and the budget line holds
// the extra and moves the invoice to actual. Who, the amounts, the invoice number and what follows are the row's (sheet
// Demo_Script_P1) and its expectJson's; the PO is found from the history row, never typed.

test('@p1demo [FR-AP-101/AC1] [FR-AP-103/AC2] [FR-AP-105/AC2] [FR-AP-105/AC3] scene 9: a paper invoice over the PO price goes to procurement, its variance is approved by the DOA, and it is ready for payment', async ({ page, browser }) => {
  test.setTimeout(10 * 60_000)
  const sheet = await p1Sheet()
  const scene = sceneOf(sheet, 9)
  expect(scene.expectedOutcome).toBe('EXCEPTION')
  const history = historyOf(sheet, columnOf(scene, 'historyRef'))
  const supplier = columnOf(scene, 'supplier')
  const invoiceNo = columnOf(scene, 'invoiceNo')
  const unitPrice = columnOf(scene, 'invoiceUnitPrice')
  expect(history.supplier, `${history.ref} is ordered from the row's supplier`).toBe(supplier)
  expectRunDate(scene)
  const draft = expectedOf<{ channel: string; prefill: string }>(scene, 'draft')
  const accountCode = expectedOf<string>(scene, 'accountCode')
  const invoiceNet = expectedSatang(scene, 'invoiceNet')
  const invoiceVat = expectedSatang(scene, 'invoiceVat')
  const invoiceGross = expectedSatang(scene, 'invoiceGross')
  const variance = expectedSatang(scene, 'variance')
  const varianceVat = expectedSatang(scene, 'varianceVat')
  const varianceGross = expectedSatang(scene, 'varianceGross')
  const exceptionType = expectedOf<string>(scene, 'exceptionType')
  const assignee = expectedOf<string>(scene, 'exceptionAssignee')
  const asker = expectedOf<string>(scene, 'varianceBy')
  const rule = expectedOf<string>(scene, 'varianceRule')
  const approver = expectedOf<string>(scene, 'varianceApprover')
  const reason = expectedOf<string>(scene, 'varianceReasonTh')
  const payable = expectedSatang(scene, 'payable')
  const wht = expectedSatang(scene, 'expectedWht')
  const today = todayInBangkok()
  const due = dayAfter(today, expectedOf<number>(scene, 'dueAfterDays'))

  // The row holds together: who asks and who approves act in the scene; the rule and its approver are the sheet DOA's
  expect(scene.others, 'procurement and the approver act in the scene').toEqual([asker, approver])
  expect(scene.expectedRule).toBe(rule)
  expect(scene.expectedApprover).toBe(approver)
  expect(invoiceGross).toBe(invoiceNet + invoiceVat)
  expect(varianceGross).toBe(variance + varianceVat)
  const counted = sheet.doa.amountBasis === 'GROSS' ? varianceGross : variance
  const doaRule = ruleOf(sheet, rule)
  expect(doaRule.documentType).toBe('INVOICE_EXCEPTION')
  expect((doaRule.gt === null || counted > doaRule.gt) && (doaRule.lte === null || counted <= doaRule.lte), `${baht(counted)} is within rule ${rule}`).toBe(true)
  const budgetDepartment = [...(sheet.budget.get(columnOf(scene, 'budgetKey'))?.values() ?? [])][0]?.department ?? null
  expect(approverByRule(sheet, rule, budgetDepartment ?? '').code, `rule ${rule} names ${approver} for the department of the budget line`).toBe(approver)
  expect(expectedOf<boolean>(scene, 'stepUp')).toBe(counted >= sheet.doa.stepUpThreshold)

  // Before the scene: the delivery is received in full and waits for its invoice
  const po = poOfHistory(history.ref)
  expect(po.supplier).toBe(supplier)
  expect(po.invoices, `${history.ref}'s PO has no invoice yet`).toBe(0)
  expect(po.lines, `${po.poNumber} has the one line the scene prices`).toHaveLength(1)
  const line = po.lines[0]!
  expect(Number(line.received), `${po.poNumber} is received in full`).toBe(Number(line.quantity))
  expect(Number(line.quantity)).toBe(Number(columnOf(scene, 'qty')))
  expect(line.unitPriceSatang).toBe(columnOf(scene, 'unitPrice').toString())
  expect(line.department).toBe(budgetDepartment)
  const before = po.balances[line.budgetLineId]!
  const since = eventSeq()

  // FINANCE: the PO, the scanned invoice, a draft typed from the paper
  await signInAs(page, sheet, scene.actor)
  const nameTh = sheet.suppliers.get(supplier)!.nameTh
  const draftPath = await uploadDraft(page, po.poNumber!, { name: `${invoiceNo.replace(/[^A-Za-z0-9-]/g, '-')}.pdf`, buffer: Buffer.from(scannedInvoicePdf([nameTh, invoiceNo, baht(invoiceGross)])) })
  await saveHeader(page, { invoiceNo, day: today, dayText: formatThaiDay(today)!, vat: invoiceVat })
  // the line comes with the quantity received at the PO's price; the paper says another price
  const lines = page.getByRole('region', { name: th('apInvoice.lines.title') })
  // (the table's field from md up; the list's below it is hidden)
  await lines.getByLabel(th('apInvoice.lines.unitPriceOf', { no: 1 })).filter({ visible: true }).fill(typed(unitPrice))
  await lines.getByRole('button', { name: th('apInvoice.lines.save') }).click()
  await expect(lines.getByText(th('apInvoice.lines.saved'))).toBeVisible({ timeout: 30_000 })
  await page.reload()
  await expect(page.getByRole('region', { name: th('apInvoice.amounts.title') })).toContainText(baht(invoiceNet))
  await confirmCoding(page, accountCode)
  const number = await submitDraft(page, 'EXCEPTION')

  // The difference, on which line, how much and to whom
  const differences = page.getByRole('region', { name: th('apInvoice.exceptions.title') })
  await expect(differences).toContainText(th(`apInvoice.exceptions.type.${exceptionType}`))
  await expect(differences).toContainText(
    `${th('apInvoice.exceptions.line', { no: 1 })} · ${th('apInvoice.exceptions.amount', { amount: baht(variance) })} · ${th('apInvoice.exceptions.sentTo', { role: th(`apInvoice.exceptions.role.${assignee}`) })}`,
  )
  const raised = invoiceOf(supplier, invoiceNo, since)
  expect(raised.number).toBe(number)
  expect(raised.status).toBe('EXCEPTION')
  expect(raised.matchResult).toBe(expectedOf<string>(scene, 'matchResult'))
  expect(raised.channel).toBe(draft.channel)
  expect(raised.prefill).toBe(draft.prefill)
  expect(raised.recordedBy).toBe(scene.actor)
  expect(raised.netSatang).toBe(invoiceNet.toString())
  expect(raised.statedVatSatang).toBe(invoiceVat.toString())
  expect(raised.grossSatang).toBe(invoiceGross.toString())
  expect(raised.exceptions).toEqual([{ type: exceptionType, amountSatang: variance.toString(), assigneeRole: assignee, status: 'OPEN', lineNo: 1 }])

  // Procurement asks for the variance to be approved, from the list of invoices over their PO
  const procurement = await deskAs(browser, sheet, asker)
  await procurement.goto('/procurement/pos')
  await procurement.getByRole('link', { name: th('purchaseOrder.list.invoiceExceptionsLink') }).click()
  await expect(h1(procurement)).toHaveText(th('apInvoice.exceptionsPage.title'))
  const row = procurement.getByRole('row').filter({ hasText: th('apInvoice.exceptionsPage.supplierInvoiceNo', { no: invoiceNo }) })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(number)
  await expect(row).toContainText(baht(variance))
  await row.getByRole('button', { name: th('apInvoice.exceptions.variance') }).click()
  const dialog = procurement.getByRole('dialog')
  await dialog.getByLabel(th('apInvoice.dialog.reason')).fill(reason)
  await dialog.getByRole('button', { name: th('apInvoice.exceptions.varianceConfirm') }).click()
  await expect(row, 'the invoice waits for the approver now and leaves the list').toHaveCount(0, { timeout: 30_000 })
  await procurement.context().close()

  const asked = invoiceOf(supplier, invoiceNo, since)
  expect(asked.status).toBe('PENDING_APPROVAL')
  expect(asked.variance).toEqual({ doaRuleCode: rule, netSatang: variance.toString(), vatSatang: varianceVat.toString() })
  expect(asked.routes).toHaveLength(1)
  expect(asked.routes[0]!.ruleCode).toBe(rule)
  expect(asked.routes[0]!.amountSatang).toBe(counted.toString())
  expect(asked.routes[0]!.tasks).toEqual([{ assignee: approver, status: 'OPEN', decision: null, channel: null }])

  // The approver decides it on the task's page: below the stepUpThreshold no PIN is asked
  const decider = await deskAs(browser, sheet, approver)
  await decider.goto('/tasks')
  await decider.getByRole('link', { name: new RegExp(number) }).first().click()
  await expect(h1(decider)).toHaveText(th('tasks.invoice.heading'))
  await decider.getByRole('button', { name: th('tasks.decide.approve'), exact: true }).click()
  const confirmApprove = decider.getByRole('button', { name: th('tasks.decide.confirm') })
  await expect(confirmApprove).toBeVisible()
  await expect(decider.getByLabel(th('tasks.decide.pin'))).toHaveCount(0)
  await confirmApprove.click()
  await expect(decider.getByRole('status').filter({ hasText: th('tasks.decide.approved') }).first()).toBeVisible({ timeout: 30_000 })
  await decider.context().close()

  // FINANCE reads the invoice again: ready for payment, due after the supplier's terms
  await page.goto(draftPath)
  await expect(h1(page)).toHaveText(th('apInvoice.title', { number }))
  await expect(shown(page, th('apInvoice.status.READY_FOR_PAYMENT'))).toBeVisible()
  await expectAmounts(page, { payable, wht, transfer: payable - wht, due, dueText: formatThaiDay(due)! })

  const ready = invoiceOf(supplier, invoiceNo, since)
  expect(ready.status).toBe(expectedOf<string>(scene, 'status'))
  expect(ready.dueDate).toBe(due)
  expect(ready.invoiceDate).toBe(today)
  expect(ready.payableSatang).toBe(payable.toString())
  expect(ready.expectedWhtSatang).toBe(wht.toString())
  // asking matched the invoice again (BR-MATCH-10): the first difference was settled by the new one, which is approved
  expect(ready.exceptions.filter((e) => e.status !== 'RESOLVED')).toEqual([{ type: exceptionType, amountSatang: variance.toString(), assigneeRole: assignee, status: 'APPROVED', lineNo: 1 }])
  expect(ready.routes[0]!.tasks).toEqual([{ assignee: approver, status: 'APPROVED', decision: 'APPROVE', channel: 'WEB' }])
  for (const l of ready.lines) {
    expect(l.accountCode, `line ${l.lineNo}`).toBe(accountCode)
    expect(l.costCenter, `line ${l.lineNo}`).toBe(expectedOf<string>(scene, 'costCenter'))
    expect(l.unitPriceSatang, `line ${l.lineNo}`).toBe(unitPrice.toString())
  }
  expectBudgetMoved(before, ready.balances[line.budgetLineId]!, expectedOf(scene, 'budget'), line.budgetLineCode)
  expectEvents(ready.events, expectedOf<string[]>(scene, 'events'), `invoice ${invoiceNo}`)
  expect(userOf(sheet, scene.actor).twoFactor).toBe(true)
})
