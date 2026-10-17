import { formatThaiDay } from '../../../src/core/thai/day'
import { scannedInvoicePdf } from '../../../src/server/seed/etax-sample'
import { baht, literally, th } from '../demo/support'
import { expect, test } from '../fixtures'
import {
  confirmCoding,
  dayAfter,
  eventSeq,
  expectAmounts,
  expectBudgetMoved,
  expectEvents,
  expectRunDate,
  invoiceOf,
  moneySheet,
  poOfHistory,
  saveHeader,
  sheetSatang,
  submitDraft,
  uploadDraft,
} from './money-steps'
import { columnOf, expectedOf, expectedSatang, historyOf, p1Sheet, sceneOf, signInAs, todayInBangkok } from './support'

// Scene 10 of the day of phase 1 (P1-08 · S8 · WHT): FINANCE records the supplier's invoice for the hire of a machine
// the history received in full, chooses at coding the income type the tax is withheld for (sheet WHT_Types: its name and
// rate, not yet confirmed by an accountant) — nothing proposes it, the PO being of goods (expectJson.draft
// defaultIncomeType) — and submits it: it matches and is ready for payment with the tax expected to be withheld and the
// transfer expected, which the payment run of scene 11 withholds and certifies (50 ทวิ). Who, the amounts, the invoice
// number and what follows are the row's (sheet Demo_Script_P1) and its expectJson's; the PO is found from the history row.

test('@p1demo [FR-AP-104/AC2] scene 10: a rent invoice is coded with the income type withheld and shows the tax and the transfer expected', async ({ page }) => {
  test.setTimeout(8 * 60_000)
  const sheet = await p1Sheet()
  const money = await moneySheet()
  const scene = sceneOf(sheet, 10)
  expect(scene.expectedOutcome).toBe('READY')
  const history = historyOf(sheet, columnOf(scene, 'historyRef'))
  const supplier = columnOf(scene, 'supplier')
  const invoiceNo = columnOf(scene, 'invoiceNo')
  expect(history.supplier, `${history.ref} is ordered from the row's supplier`).toBe(supplier)
  expectRunDate(scene)
  const draft = expectedOf<{ channel: string; prefill: string; defaultIncomeType: string | null }>(scene, 'draft')
  const accountCode = expectedOf<string>(scene, 'accountCode')
  const incomeType = expectedOf<string>(scene, 'whtIncomeType')
  const type = money.whtTypes.get(incomeType)
  if (!type) throw new Error(`sheet WHT_Types has no ${incomeType}`)
  expect(type.rateBp, `the rate of ${incomeType} in sheet WHT_Types`).toBe(expectedOf<number>(scene, 'whtBp'))
  const net = columnOf(scene, 'net')
  const payable = expectedSatang(scene, 'payable')
  const wht = expectedSatang(scene, 'expectedWht')
  const transfer = expectedSatang(scene, 'expectedTransfer')
  const minimumBase = sheetSatang(sheet.settings.get('wht.minimumBase'), 'Settings wht.minimumBase')
  // The tax the row expects: the base before VAT at the type's rate, half up, once the base reaches the minimum
  expect(wht, `${baht(net)} × ${type.rateBp} bp`).toBe(net >= minimumBase ? (net * BigInt(type.rateBp) * 2n + 10_000n) / 20_000n : 0n)
  expect(transfer).toBe(payable - wht)
  expect(payable).toBe(columnOf(scene, 'gross'))
  const today = todayInBangkok()
  const due = dayAfter(today, expectedOf<number>(scene, 'dueAfterDays'))

  // Before the scene: the machine's days are received in full; the PO is of goods, so no service acceptance is waited for
  const po = poOfHistory(history.ref)
  expect(po.supplier).toBe(supplier)
  expect(po.kind).toBe(expectedOf<string>(scene, 'poKind'))
  expect(expectedOf<boolean>(scene, 'acceptanceNeeded')).toBe(po.kind === 'SERVICE')
  expect(po.invoices, `${history.ref}'s PO has no invoice yet`).toBe(0)
  for (const l of po.lines) expect(Number(l.received), `line ${l.lineNo} of ${po.poNumber} is received in full`).toBe(Number(l.quantity))
  expect(po.lines.reduce((a, l) => a + BigInt(l.netSatang), 0n)).toBe(net)
  const budgetLine = po.lines[0]!.budgetLineId
  const before = po.balances[budgetLine]!
  const since = eventSeq()

  // FINANCE: the PO, the scanned invoice, its header typed from the paper; the lines are the PO's as received
  await signInAs(page, sheet, scene.actor)
  const nameTh = sheet.suppliers.get(supplier)!.nameTh
  await uploadDraft(page, po.poNumber!, { name: `${invoiceNo.replace(/[^A-Za-z0-9-]/g, '-')}.pdf`, buffer: Buffer.from(scannedInvoicePdf([nameTh, invoiceNo, baht(columnOf(scene, 'gross'))])) })
  await saveHeader(page, { invoiceNo, day: today, dayText: formatThaiDay(today)!, vat: columnOf(scene, 'vat') })

  // The coding: nothing withheld is proposed on a PO of goods; FINANCE picks the income type, its rate not yet confirmed
  const coding = page.getByRole('region', { name: th('apInvoice.coding.title') })
  const typeOf = (code: string | null) => {
    if (code === null) return th('apInvoice.coding.noWithholding')
    const t = money.whtTypes.get(code)!
    const label = th('apInvoice.coding.typeOption', { name: t.nameTh, rate: (t.rateBp / 100).toString() })
    return expectedOf<boolean>(scene, 'whtRateConfirmed') ? label : `${label} · ${th('apInvoice.coding.rateNotConfirmed')}`
  }
  const typePickers = coding.getByRole('combobox', { name: new RegExp(`^${literally(th('apInvoice.coding.incomeType', { no: '@' })).replace('@', '\\d+')}$`) })
  await expect(typePickers.first()).toBeVisible()
  for (let i = 0; i < (await typePickers.count()); i++) await expect(typePickers.nth(i)).toHaveText(typeOf(draft.defaultIncomeType))
  expect(expectedOf<boolean>(scene, 'whtPickedInCoding')).toBe(draft.defaultIncomeType === null)
  await confirmCoding(page, accountCode, { label: new RegExp(`^${literally(typeOf(incomeType))}$`) })
  const number = await submitDraft(page, 'READY_FOR_PAYMENT')

  // Ready: the payable, the tax expected to be withheld and the transfer expected, due after the supplier's terms
  await expectAmounts(page, { payable, wht, transfer, due, dueText: formatThaiDay(due)! })
  await expect(page.getByRole('list', { name: th('apInvoice.coding.title') })).toContainText(th('apInvoice.coding.readType', { type: incomeType }))

  const invoice = invoiceOf(supplier, invoiceNo, since)
  expect(invoice.number).toBe(number)
  expect(invoice.channel).toBe(draft.channel)
  expect(invoice.prefill).toBe(draft.prefill)
  expect(invoice.recordedBy).toBe(scene.actor)
  expect(invoice.status).toBe(expectedOf<string>(scene, 'status'))
  expect(invoice.matchResult).toBe(expectedOf<string>(scene, 'matchResult'))
  expect(invoice.invoiceDate).toBe(today)
  expect(invoice.dueDate).toBe(due)
  expect(invoice.netSatang).toBe(net.toString())
  expect(invoice.grossSatang).toBe(columnOf(scene, 'gross').toString())
  expect(invoice.payableSatang).toBe(payable.toString())
  expect(invoice.expectedWhtSatang).toBe(wht.toString())
  expect(invoice.readyExpectedWhtSatang, 'invoice.ready carries the tax expected').toBe(wht.toString())
  for (const l of invoice.lines) {
    expect(l.matchStatus, `line ${l.lineNo}`).toBe('MATCHED')
    expect(l.accountCode, `line ${l.lineNo}`).toBe(accountCode)
    expect(l.costCenter, `line ${l.lineNo}`).toBe(expectedOf<string>(scene, 'costCenter'))
    expect(l.whtIncomeTypeCode, `line ${l.lineNo}`).toBe(incomeType)
  }
  expect(invoice.exceptions).toEqual([])
  expect(invoice.routes).toEqual([])
  expectBudgetMoved(before, invoice.balances[budgetLine]!, expectedOf(scene, 'budget'), po.lines[0]!.budgetLineCode)
  expectEvents(invoice.events, expectedOf<string[]>(scene, 'events'), `invoice ${invoiceNo}`)
  expect(expectedOf<string>(scene, 'whtCertificateAt'), 'the 50 ทวิ comes with the payment of scene 11').toBe('PAYMENT_SCENE_11')
})
