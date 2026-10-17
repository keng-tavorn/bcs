import { formatThaiDay } from '../../../src/core/thai/day'
import { literally, th } from '../demo/support'
import { expect, test } from '../fixtures'
import { confirmCoding, dayAfter, eventSeq, expectAmounts, expectBudgetMoved, expectEvents, expectRunDate, h1, invoiceOf, poOfHistory, proposalsFor, s8, sheetSatang, shown, submitDraft } from './money-steps'
import { columnOf, expectedOf, expectedSatang, historyOf, p1Sheet, sceneOf, signInAs, todayInBangkok, userOf } from './support'

// Scene 8 of the day of phase 1 (P1-08 · S8 · INVOICE_EMAIL): the supplier e-mails the e-Tax invoice of a delivery the
// history received in full (the row's Request_History ref) to the organization's invoice inbox; FINANCE pulls the inbox,
// opens the draft the e-Tax file filled in (number, date, VAT, the supplier and the PO proposed), confirms the coding
// of every line and submits it: it matches three ways and is ready for payment, due after the supplier's terms, and the
// PO's budget line moves from committed to actual. Who, which supplier, invoice number, amounts and what follows are the
// row's (sheet Demo_Script_P1) and its expectJson's; the PO is found from the history row, never typed.

test('@p1demo [FR-AP-101/AC2] [FR-AP-102/AC3] scene 8: an e-Tax invoice e-mailed to the inbox becomes a draft, matches three ways and is ready for payment', async ({ page }) => {
  test.setTimeout(8 * 60_000)
  const sheet = await p1Sheet()
  const scene = sceneOf(sheet, 8)
  expect(scene.channel, 'the invoice comes by e-mail').toBe('EMAIL')
  expect(scene.expectedOutcome).toBe('MATCHED')
  const history = historyOf(sheet, columnOf(scene, 'historyRef'))
  const supplier = columnOf(scene, 'supplier')
  const invoiceNo = columnOf(scene, 'invoiceNo')
  expect(history.supplier, `${history.ref} is ordered from the row's supplier`).toBe(supplier)
  expectRunDate(scene)
  const mailSpec = expectedOf<{ from: string; to: string; clearMailboxFirst: boolean }>(scene, 'mail')
  expect(mailSpec.from, 'the e-mail comes from the supplier').toBe('SUPPLIER_EMAIL')
  expect(mailSpec.to, "the e-mail goes to the organization's inbox address").toBe('SETTING:ap.inboxAddress')
  const poll = expectedOf<{ received: number; drafts: number; failed: number }>(scene, 'poll')
  const draft = expectedOf<{ channel: string; prefill: string; statedVat: string }>(scene, 'draft')
  const accountCode = expectedOf<string>(scene, 'accountCode')
  const payable = expectedSatang(scene, 'payable')
  const wht = expectedSatang(scene, 'expectedWht')
  const transfer = expectedSatang(scene, 'expectedTransfer')
  const today = todayInBangkok()
  const due = dayAfter(today, expectedOf<number>(scene, 'dueAfterDays'))

  // Before the scene: the delivery is received in full and waits for its invoice; the supplier's e-mail is sent
  const po = poOfHistory(history.ref)
  expect(po.supplier).toBe(supplier)
  expect(po.invoices, `${history.ref}'s PO has no invoice yet`).toBe(0)
  for (const l of po.lines) expect(Number(l.received), `line ${l.lineNo} of ${po.poNumber} is received in full`).toBe(Number(l.quantity))
  const budgetLine = po.lines[0]!.budgetLineId
  const before = po.balances[budgetLine]!
  // what the coding form will propose for each line (BR-AP-10): the supplier's history of the category, else the budget line's
  const proposals = proposalsFor(po)
  const since = eventSeq()
  const mail = s8<{ inbox: string; from: string; subject: string; issueDate: string; poNumber: string }>('mail', String(scene.scene))
  expect(mail.from, 'from the address sheet Suppliers gives the supplier').toBe(sheet.suppliers.get(supplier)!.email)
  expect(mail.inbox, 'to the address sheet Settings gives the inbox').toBe(sheet.settings.get('ap.inboxAddress'))
  expect(mail.issueDate).toBe(today)

  // FINANCE pulls the inbox: one new e-mail, one draft
  await signInAs(page, sheet, scene.actor)
  await page.goto('/finance/invoices')
  await expect(h1(page)).toHaveText(th('apList.title'))
  await page.getByRole('link', { name: th('apList.actions.inbox') }).click()
  await expect(h1(page)).toHaveText(th('apList.inbox.title'))
  await expect(page.getByText(th('apList.inbox.address', { address: mail.inbox }))).toBeVisible()
  await page.getByRole('button', { name: th('apList.inbox.poll.button') }).click()
  await expect(page.getByText(th('apList.inbox.poll.done', poll))).toBeVisible({ timeout: 30_000 })

  // The draft: the e-Tax file filled in its number, date and VAT; the supplier and the PO were found for it
  await page.getByRole('link', { name: new RegExp(`^${literally(th('apList.inbox.draftLink', { label: invoiceNo }))} · ${literally(th('apList.status.DRAFT'))}$`) }).click()
  await expect(h1(page)).toHaveText(th('apInvoice.titleDraft'))
  const header = page.getByRole('form', { name: th('apInvoice.header.title') })
  await expect(header.getByLabel(th('apInvoice.header.supplierInvoiceNo'))).toHaveValue(invoiceNo)
  await expect(header.getByLabel(th('apInvoice.header.invoiceDate'))).toHaveText(formatThaiDay(today)!)
  await expect(header.getByLabel(th('apInvoice.header.statedVat'))).toHaveValue(draft.statedVat)
  await expect(header.getByText(th('apInvoice.source.ETAX_XML'), { exact: true })).toHaveCount(3)
  await expect(page.getByRole('link', { name: th('apInvoice.header.poLink', { number: mail.poNumber }) })).toBeVisible()
  await expect(page.getByRole('link', { name: th('apInvoice.header.supplierName', { name: sheet.suppliers.get(supplier)!.nameTh, code: supplier }) })).toBeVisible()

  // Every line's coding — the account proposed, the row's — confirmed, then submitted: three-way match, ready for payment
  await confirmCoding(page, { accountCode, proposals })
  const number = await submitDraft(page, 'READY_FOR_PAYMENT')
  await expectAmounts(page, { payable, wht, transfer, due, dueText: formatThaiDay(due)! })

  // The database: the e-mail's draft, matched and ready, due after the terms, the budget line from committed to actual
  const invoice = invoiceOf(supplier, invoiceNo, since)
  expect(invoice.number).toBe(number)
  expect(invoice.poNumber).toBe(mail.poNumber)
  expect(invoice.channel).toBe(draft.channel)
  expect(invoice.prefill).toBe(draft.prefill)
  expect(invoice.inboundEmailId, 'the draft came from the inbox').not.toBeNull()
  expect(invoice.recordedBy).toBe(userOf(sheet, scene.actor).code)
  expect(invoice.status).toBe(expectedOf<string>(scene, 'status'))
  expect(invoice.matchResult).toBe(expectedOf<string>(scene, 'matchResult'))
  expect(invoice.invoiceDate).toBe(today)
  expect(invoice.dueDate).toBe(due)
  expect(invoice.netSatang).toBe(columnOf(scene, 'net').toString())
  expect(invoice.statedVatSatang).toBe(sheetSatang(draft.statedVat, 'draft.statedVat').toString())
  expect(invoice.grossSatang).toBe(columnOf(scene, 'gross').toString())
  expect(invoice.payableSatang).toBe(payable.toString())
  expect(invoice.expectedWhtSatang).toBe(wht.toString())
  expect(payable - wht).toBe(transfer)
  for (const l of invoice.lines) {
    expect(l.matchStatus, `line ${l.lineNo}`).toBe('MATCHED')
    expect(l.accountCode, `line ${l.lineNo}`).toBe(accountCode)
    expect(l.costCenter, `line ${l.lineNo}`).toBe(expectedOf<string>(scene, 'costCenter'))
    expect(l.codingConfirmed, `line ${l.lineNo}`).toBe(true)
  }
  expect(invoice.exceptions).toEqual([])
  expect(invoice.routes, 'a matched invoice needs no approval').toEqual([])
  expectBudgetMoved(before, invoice.balances[budgetLine]!, expectedOf(scene, 'budget'), po.lines[0]!.budgetLineCode)
  expectEvents(invoice.events, expectedOf<string[]>(scene, 'events'), `invoice ${invoiceNo}`)
  // The row's amounts are the PO's, received in full
  expect(po.lines.reduce((a, l) => a + BigInt(l.netSatang), 0n)).toBe(columnOf(scene, 'net'))
  await expect(shown(page, th('apInvoice.status.READY_FOR_PAYMENT'))).toBeVisible()
})
