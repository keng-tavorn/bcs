import { readFileSync } from 'node:fs'
import { readNeutralFile } from '../../../src/core/bankfile/neutral'
import { E2E_PIN } from '../../support/e2e-env'
import { messagesTo } from '../../support/mailpit'
import { baht, cardTo, expectCardButtons, lineUserOf, liffPathOf, literally, phoneOf, th, typed, type Delivered } from '../demo/support'
import { expect, test } from '../fixtures'
import { deskAs, h1, moneySheet, s9, sheetSatang } from './money-steps'
import { approverByRule, columnOf, day, expectedOf, expectedSatang, p1Sheet, ruleOf, sceneOf, signInAs, todayInBangkok } from './support'

// Scene 11 of the day of phase 1 (P1-08 · S9 · PAYMENT_RUN): the invoices of scenes 8, 9 and 10 are paid in one run.
// First another FINANCE member (expectJson.parkFirst) keeps in a draft of her own every invoice of the history due by
// the next run day, so the preparer's proposal is empty and her run holds exactly the scene's invoices, added by hand
// (paid early: they are due after the run day). The run goes to the DOA by its transfer: the approver the row names
// approves it in LIFF from the LINE card with the PIN (at or above the stepUpThreshold). FINANCE makes the neutral bank
// file (BCS-NEUTRAL-1, not a bank's format), downloads it and marks it sent; on the pay day one supplier's transfer
// fails and the others are paid: the tax withheld is recorded with its 50 ทวิ, and the paid suppliers get their payment
// advice by e-mail (Mailpit), the 50 ทวิ attached. Who, the documents, the amounts and what follows are the row's (sheet
// Demo_Script_P1), its expectJson's and those of the rows of scenes 8 to 10; the invoices are found by their numbers.

interface DocRow {
  readonly scene: number
  readonly supplier: string
  readonly payable: string
  readonly wht: string
  readonly transfer: string
  readonly whtIncomeType?: string
  readonly whtBp?: number
  readonly whtBase?: string
}

interface DocFacts {
  readonly supplier: string
  readonly invoiceNo: string
  readonly found: boolean
  readonly number: string | null
  readonly status: string | null
  readonly invoiceDate: string | null
  readonly dueDate: string | null
  readonly payableSatang: string | null
  readonly expectedWhtSatang: string | null
}

interface RunFacts {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly payDate: string
  readonly payer: string | null
  readonly preparedBy: string | null
  readonly fileTemplateCode: string
  readonly totalPayableSatang: string
  readonly totalWhtSatang: string
  readonly totalTransferSatang: string
  readonly itemCount: number
  readonly documentCount: number
  readonly flagsKey: string | null
  readonly files: ReadonlyArray<{ readonly fileName: string; readonly status: string; readonly itemCount: number; readonly totalSatang: string }>
  readonly items: ReadonlyArray<{
    readonly seq: number | null
    readonly supplier: string
    readonly payableSatang: string
    readonly whtSatang: string
    readonly transferSatang: string
    readonly flags: readonly string[]
    readonly status: string
    readonly paidOn: string | null
    readonly failureReason: string | null
    readonly whtLines: ReadonlyArray<{ readonly incomeType: string; readonly rateBp: number; readonly baseSatang: string; readonly whtSatang: string }>
    readonly documents: ReadonlyArray<{ readonly supplierInvoiceNo: string | null; readonly number: string | null; readonly status: string; readonly invoiceStatus: string | null }>
    readonly certificate: { readonly number: string; readonly form: string; readonly totalBaseSatang: string; readonly totalTaxSatang: string; readonly hasFile: boolean } | null
    readonly advices: ReadonlyArray<{ readonly templateKey: string; readonly status: string }>
  }>
  readonly routes: ReadonlyArray<{
    readonly ruleCode: string
    readonly amountSatang: string | null
    readonly status: string
    readonly tasks: ReadonlyArray<{ readonly id: string; readonly assignee: string | null; readonly status: string; readonly decision: string | null; readonly channel: string | null }>
  }>
  readonly decided: { readonly channel: string; readonly decision: string | null; readonly stepUp: boolean } | null
  readonly events: readonly string[]
}

const count = (list: readonly string[], type: string) => list.filter((t) => t === type).length

test('@p1demo [FR-PAY-101/AC2] [FR-PAY-101/AC7] [FR-PAY-101/AC9] [FR-PAY-102/AC1] [FR-PAY-102/AC3] [FR-PAY-103/AC1] [FR-PAY-103/AC2] [FR-PAY-103/AC3] scene 11: a payment run of the day’s invoices, approved in LINE with the PIN, its neutral bank file, one transfer failed, the advices and the 50 ทวิ e-mailed', async ({
  page,
  browser,
}) => {
  test.setTimeout(12 * 60_000)
  const sheet = await p1Sheet()
  const money = await moneySheet()
  const scene = sceneOf(sheet, 11)
  expect(scene.expectedOutcome).toBe('PAID')
  const parker = expectedOf<string>(scene, 'parkFirst')
  const approver = columnOf(scene, 'expectedApprover')
  const rule = columnOf(scene, 'expectedRule')
  const payer = expectedOf<string>(scene, 'payer')
  const docRows = expectedOf<DocRow[]>(scene, 'docs')
  const payable = expectedSatang(scene, 'payable')
  const wht = expectedSatang(scene, 'wht')
  const transfer = expectedSatang(scene, 'transfer')
  const failed = expectedOf<Array<{ supplier: string; reasonTh: string }>>(scene, 'failed')
  const certificates = expectedOf<Array<{ supplier: string; form: string; base: string; tax: string }>>(scene, 'certificates')
  const adviceTo = expectedOf<string[]>(scene, 'advices')
  const stepUp = expectedOf<boolean>(scene, 'stepUp')
  const fileTemplate = expectedOf<string>(scene, 'fileTemplate')
  const fileRows = expectedOf<number>(scene, 'fileRows')
  const today = todayInBangkok()

  // The row holds together with the rows of the scenes whose invoices it pays, the sheet's DOA and its payment rules
  expect(scene.others, 'the one who parks the due invoices first, then the approver').toEqual([parker, approver])
  const docs = docRows.map((d) => {
    const source = sceneOf(sheet, d.scene)
    expect(source.supplier, `scene ${d.scene}'s supplier`).toBe(d.supplier)
    expect(expectedSatang(source, 'payable'), `scene ${d.scene}'s payable`).toBe(sheetSatang(d.payable, `docs of scene ${d.scene}`))
    expect(expectedSatang(source, 'expectedWht'), `scene ${d.scene}'s tax expected`).toBe(sheetSatang(d.wht, `docs of scene ${d.scene}`))
    const doc = { ...d, invoiceNo: columnOf(source, 'invoiceNo'), payableSatang: sheetSatang(d.payable, 'payable'), whtSatang: sheetSatang(d.wht, 'wht'), transferSatang: sheetSatang(d.transfer, 'transfer') }
    expect(doc.transferSatang).toBe(doc.payableSatang - doc.whtSatang)
    // the invoice's own amounts: the paper's when they differ from the PO (scene 9), the row's columns otherwise
    const net = source.expect.invoiceNet !== undefined ? expectedSatang(source, 'invoiceNet') : columnOf(source, 'net')
    const vat = source.expect.invoiceVat !== undefined ? expectedSatang(source, 'invoiceVat') : columnOf(source, 'vat')
    return { ...doc, net, vat }
  })
  const sum = (pick: (d: (typeof docs)[number]) => bigint) => docs.reduce((a, d) => a + pick(d), 0n)
  expect(sum((d) => d.payableSatang)).toBe(payable)
  expect(sum((d) => d.whtSatang)).toBe(wht)
  expect(sum((d) => d.transferSatang)).toBe(transfer)
  expect(sum((d) => d.net)).toBe(columnOf(scene, 'net'))
  expect(sum((d) => d.vat)).toBe(columnOf(scene, 'vat'))
  expect(sum((d) => d.net + d.vat)).toBe(columnOf(scene, 'gross'))
  const doaRule = ruleOf(sheet, rule)
  expect(doaRule.documentType).toBe('PAYMENT_RUN')
  expect((doaRule.gt === null || transfer > doaRule.gt) && (doaRule.lte === null || transfer <= doaRule.lte), `the transfer ${baht(transfer)} is within rule ${rule}`).toBe(true)
  const root = [...sheet.departmentParents].find(([, parent]) => parent === null)![0]
  expect(approverByRule(sheet, rule, root).code).toBe(approver)
  expect(stepUp, 'the PIN is asked at or above the stepUpThreshold').toBe(transfer >= sheet.doa.stepUpThreshold)
  const suppliers = [...new Set(docs.map((d) => d.supplier))]
  expect(fileRows, 'one row of the file per supplier').toBe(suppliers.length)
  const failedSet = new Set(failed.map((f) => f.supplier))
  const paid = docs.filter((d) => !failedSet.has(d.supplier))
  expect(sheetSatang(expectedOf<string>(scene, 'paidTransfer'), 'paidTransfer')).toBe(paid.reduce((a, d) => a + d.transferSatang, 0n))
  expect(adviceTo).toEqual(paid.map((d) => d.supplier))
  expect(certificates.map((c) => c.supplier)).toEqual(paid.filter((d) => d.whtSatang > 0n).map((d) => d.supplier))
  expect(expectedOf<string>(scene, 'approveChannel')).toBe('LIFF')

  // Before the scene: the invoices of scenes 8 to 10 are ready for payment and dated today, so due after the run day
  const pairs = docs.map((d) => `${d.supplier}:${d.invoiceNo}`)
  const ready = s9<DocFacts[]>('docs', ...pairs)
  for (const [i, f] of ready.entries()) {
    expect(f.found, `${pairs[i]} was recorded by scene ${docs[i]!.scene}`).toBe(true)
    expect(f.status, `${pairs[i]} is ready for payment`).toBe('READY_FOR_PAYMENT')
    expect(f.invoiceDate, `${pairs[i]} is dated today`).toBe(today)
    expect(f.payableSatang).toBe(docs[i]!.payableSatang.toString())
    expect(f.expectedWhtSatang).toBe(docs[i]!.whtSatang.toString())
  }
  // The approver's phone is linked to LINE before the run is sent (runbook: every phone of the day is linked first)
  day('prepare', `${approver}:${lineUserOf(approver)}`)

  // Another FINANCE member keeps every invoice due by the next run day in a draft of her own
  const parking = await deskAs(browser, sheet, parker)
  await parking.goto('/finance/payments')
  await expect(h1(parking)).toHaveText(th('payRun.list.title'))
  await parking.getByRole('link', { name: th('payRun.list.prepare') }).first().click()
  await expect(h1(parking)).toHaveText(th('payRun.new.title'))
  await parking.getByRole('button', { name: th('payRun.new.submit') }).click()
  await expect(h1(parking)).toHaveText(th('payRun.run.titleDraft'), { timeout: 30_000 })
  await parking.context().close()

  // The preparer: nothing is due by the run day any more; the draft from the payer the row names, empty
  await signInAs(page, sheet, scene.actor)
  await page.goto('/finance/payments')
  await expect(h1(page)).toHaveText(th('payRun.list.title'))
  await page.getByRole('link', { name: th('payRun.list.prepare') }).first().click()
  await expect(h1(page)).toHaveText(th('payRun.new.title'))
  await expect(page.getByText(th('payRun.new.proposedNone'))).toBeVisible()
  await expect(page.getByRole('combobox', { name: th('payRun.new.payer') })).toContainText(payer)
  await page.getByRole('button', { name: th('payRun.new.submit') }).click()
  await expect(h1(page)).toHaveText(th('payRun.run.titleDraft'), { timeout: 30_000 })
  await expect(page.getByText(th('payRun.items.empty'))).toBeVisible()
  const runUrl = new URL(page.url()).pathname
  const runId = runUrl.split('/').at(-1)!
  const drafted = s9<RunFacts>('run', runId)
  expect(drafted.status).toBe('DRAFT')
  expect(drafted.payer).toBe(payer)
  expect(drafted.preparedBy).toBe(scene.actor)
  expect(drafted.fileTemplateCode).toBe(fileTemplate)
  for (const [i, f] of ready.entries()) expect(f.dueDate! > drafted.payDate, `${pairs[i]} is due after the run day ${drafted.payDate}`).toBe(true)

  // The scene's invoices added by hand, each by its supplier's number, each paid early
  await page.getByRole('button', { name: th('payRun.items.add') }).click()
  const sheetPanel = page.getByRole('dialog', { name: th('payRun.sheet.title') })
  for (const d of docs) {
    const box = sheetPanel.getByRole('checkbox', { name: new RegExp(literally(th('payRun.items.supplierNo', { no: d.invoiceNo }))) })
    await expect(box).toHaveCount(1)
    await expect(box).toHaveAccessibleName(new RegExp(literally(th('payRun.items.early'))))
    await box.check()
  }
  await expect(sheetPanel.getByRole('status')).toHaveText(th('payRun.sheet.chosen', { count: docs.length, amount: baht(payable) }))
  await sheetPanel.getByRole('button', { name: th('payRun.sheet.submit', { count: docs.length }) }).click()
  await expect(page.getByText(th('payRun.sheet.added')).first()).toBeVisible({ timeout: 30_000 })

  // One item per supplier with its tax withheld and its transfer; no flag
  await page.reload()
  await expect(page.getByText(th('payRun.run.suppliersValue', { count: suppliers.length, documents: docs.length }))).toBeVisible()
  for (const amount of [payable, wht, transfer]) await expect(page.getByText(baht(amount), { exact: true }).first()).toBeVisible()
  const filled = s9<RunFacts>('run', runId)
  expect([filled.totalPayableSatang, filled.totalWhtSatang, filled.totalTransferSatang]).toEqual([payable, wht, transfer].map(String))
  expect([filled.itemCount, filled.documentCount]).toEqual([suppliers.length, docs.length])
  expect(filled.flagsKey ?? '', 'no flag on the run').toBe('')
  for (const d of docs) {
    const item = filled.items.find((i) => i.supplier === d.supplier)
    expect(item, `an item of ${d.supplier}`).toBeDefined()
    expect([item!.payableSatang, item!.whtSatang, item!.transferSatang], d.supplier).toEqual([d.payableSatang, d.whtSatang, d.transferSatang].map(String))
    expect(item!.flags, d.supplier).toEqual([])
    expect(item!.documents.map((x) => x.supplierInvoiceNo)).toEqual([d.invoiceNo])
    if (d.whtIncomeType) expect(item!.whtLines).toEqual([{ incomeType: d.whtIncomeType, rateBp: d.whtBp, baseSatang: sheetSatang(d.whtBase, 'whtBase').toString(), whtSatang: d.whtSatang.toString() }])
  }

  // Sent: the DOA routes it by the transfer to the rule and the approver of the row
  await page.getByRole('button', { name: th('payRun.draft.submit'), exact: true }).click()
  await expect(page.getByText(new RegExp(literally(th('payRun.draft.submitted', { number: '@' })).replace('@', 'PAY-'))).first()).toBeVisible({ timeout: 30_000 })
  await page.reload()
  const titled = new RegExp(`^${literally(th('payRun.run.title', { number: '@' })).replace('@', '(\\S+)')}$`)
  await expect(h1(page)).toHaveText(titled)
  const number = titled.exec((await h1(page).textContent())!.trim())![1]!
  await expect(page.getByText(th('payRun.run.waitingApprover'))).toBeVisible()
  const sent = s9<RunFacts>('run', runId)
  expect(sent.number).toBe(number)
  expect(sent.status).toBe('PENDING_APPROVAL')
  expect(sent.routes).toHaveLength(1)
  expect(sent.routes[0]!.ruleCode).toBe(rule)
  expect(sent.routes[0]!.amountSatang).toBe(transfer.toString())
  expect(sent.routes[0]!.tasks.map((t) => [t.assignee, t.status])).toEqual([[approver, 'OPEN']])
  const taskId = sent.routes[0]!.tasks[0]!.id

  // The approver: the card in LINE opens the task in LIFF with approve ready; the PIN, then approved
  const delivered = day<Delivered[]>('deliver', approver, runId)
  expect(delivered.filter((d) => d.outcome.status === 'SENT' && d.outcome.channel === 'LINE'), 'the card of the task went to LINE').toHaveLength(1)
  const card = await cardTo(approver, number)
  const approve = expectCardButtons(card, { taskId, number, inChat: !stepUp })
  const phone = await phoneOf(browser, approver)
  const liff = await phone.newPage()
  await liff.goto(liffPathOf(approve.uri!))
  const summary = liff.getByRole('region', { name: th('payRun.task.heading'), exact: true })
  await expect(summary).toBeVisible({ timeout: 30_000 })
  await expect(summary).toContainText(number)
  await expect(summary).toContainText(`${baht(transfer)} ${th('payRun.task.unit')}`)
  await expect(summary).toContainText(payer)
  await expect(liff.getByText(th('payRun.task.noFlags'))).toBeVisible()
  const confirm = liff.getByRole('group', { name: th('payRun.task.decide.confirmText', { label: number, amount: baht(transfer) }) })
  await expect(confirm).toBeVisible()
  await confirm.getByLabel(th('tasks.decide.pin')).fill(E2E_PIN)
  await confirm.getByRole('button', { name: th('tasks.decide.confirm') }).click()
  await expect(liff.getByRole('status').filter({ hasText: 'อนุมัติแล้วโดย' })).toBeVisible({ timeout: 30_000 })
  await phone.close()
  const approved = s9<RunFacts>('run', runId)
  expect(approved.status).toBe('APPROVED')
  expect(approved.decided).toEqual({ channel: 'LIFF', decision: 'APPROVE', stepUp })

  // The neutral bank file: made, downloaded, read back; then marked sent to the bank
  await page.reload()
  await page.getByRole('tab', { name: th('payRun.run.tab.files'), exact: true }).click()
  await page.getByRole('button', { name: th('payRun.files.generate') }).click()
  await expect(page.getByText(th('payRun.files.generatedNow')).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(th('payRun.run.neutral')).first()).toBeVisible()
  await expect(page.getByText(th('payRun.files.total', { amount: baht(transfer) })).first()).toBeVisible()
  await expect(page.getByText(th('payRun.files.items', { count: fileRows })).first()).toBeVisible()
  await expect(page.getByRole('button', { name: th('payRun.files.markSent') })).toBeDisabled()
  const fileName = `${fileTemplate}_NOT-A-BANK-FORMAT_${number}_v1.csv`
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: th('payRun.files.download', { name: fileName }) }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe(fileName)
  const text = readFileSync((await file.path())!, 'utf8')
  const read = readNeutralFile(text)
  for (const part of [read.header, read.details, read.trailer]) expect(part).toEqual({ count: fileRows, totalSatang: transfer })
  const company = money.companyAccounts.get(payer)!
  expect(text.replace(/^﻿/, '').startsWith(`H,${fileTemplate},NOT-A-BANK-FORMAT,${number},1,${approved.payDate},${company.bankCode},${company.accountNo},${fileRows},${typed(transfer)}\r\n`)).toBe(true)
  for (const d of docs) {
    const account = money.supplierAccounts.get(d.supplier)!
    expect(text, `${d.supplier}'s row: its account and its transfer`).toMatch(new RegExp(`\\r\\nD,\\d+,${account.bankCode},${account.accountNo},.*,${literally(typed(d.transferSatang))},${d.supplier},${literally(number)}-\\d{3}\\r\\n`))
  }
  await page.goto(`${runUrl}?tab=files`)
  await page.getByRole('button', { name: th('payRun.files.markSent') }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: th('payRun.files.markSentConfirm') }).click()
  await expect(page.getByText(th('payRun.files.marked')).first()).toBeVisible({ timeout: 30_000 })

  // The pay day (in the future on most days the scene runs): the results, one supplier's transfer failed
  s9('payday', runId)
  const mailboxes = new Map<string, Set<string>>()
  for (const s of suppliers) mailboxes.set(s, new Set((await messagesTo(sheet.suppliers.get(s)!.email)).map((m) => m.ID)))
  await page.reload()
  await page.getByRole('tab', { name: th('payRun.run.tab.results'), exact: true }).click()
  for (const f of failed) {
    const outcome = page.getByRole('radiogroup', { name: new RegExp(`^${literally(th('payRun.results.outcomeLabel', { supplier: `${f.supplier} · ` }))}`) })
    await outcome.getByRole('radio', { name: th('payRun.results.outcome.FAILED') }).click()
    await page.getByRole('listitem').filter({ has: outcome }).getByLabel(th('payRun.results.failureReason')).fill(f.reasonTh)
  }
  await page.getByRole('button', { name: th('payRun.results.record') }).click()
  const sure = page.getByRole('alertdialog')
  await expect(sure).toContainText(th('payRun.results.confirmText', { paid: suppliers.length - failed.length, failed: failed.length }))
  await sure.getByRole('button', { name: th('payRun.results.confirm') }).click()
  await expect(page.getByText(th('payRun.results.completed')).first()).toBeVisible({ timeout: 30_000 })

  // The job that sends supplier e-mails, for this run's advices only
  const sentAdvices = s9<Array<{ supplier: string; outcome: string }>>('advices', runId)
  expect(sentAdvices.map((a) => [a.supplier, a.outcome]).sort()).toEqual(adviceTo.map((s) => [s, 'SENT']).sort())

  const done = s9<RunFacts>('run', runId)
  expect(done.status).toBe('COMPLETED')
  for (const item of done.items) {
    const failure = failed.find((f) => f.supplier === item.supplier)
    if (failure) {
      expect([item.status, item.failureReason, item.paidOn], item.supplier).toEqual(['FAILED', failure.reasonTh, null])
      expect(item.documents.map((x) => [x.status, x.invoiceStatus]), `${item.supplier}'s invoice is ready for payment again`).toEqual([['RELEASED', 'READY_FOR_PAYMENT']])
      expect(item.certificate).toBeNull()
      expect(item.advices).toEqual([])
    } else {
      expect([item.status, item.paidOn], item.supplier).toEqual(['PAID', today])
      expect(item.documents.map((x) => [x.status, x.invoiceStatus]), `${item.supplier}'s invoice is paid`).toEqual([['PAID', 'PAID']])
      expect(item.advices.map((a) => a.status), `${item.supplier}'s advice`).toEqual(['SENT'])
      const c = certificates.find((x) => x.supplier === item.supplier)
      expect(item.certificate === null ? null : { ...item.certificate }, `${item.supplier}'s 50 ทวิ`).toEqual(
        c ? { number: item.certificate?.number, form: c.form, totalBaseSatang: sheetSatang(c.base, 'base').toString(), totalTaxSatang: sheetSatang(c.tax, 'tax').toString(), hasFile: true } : null,
      )
    }
  }
  const paidItems = suppliers.length - failed.length
  for (const [type, times] of [
    ['payment_run.drafted', 1],
    ['payment_run.documents_added', 1],
    ['invoice.payment_held', docs.length],
    ['payment_run.submitted', 1],
    ['approval_task.assigned', 1],
    ['approval_task.decided', 1],
    ['payment_run.approved', 1],
    ['payment_run.file_generated', 1],
    ['file.downloaded', 1],
    ['payment_run.sent_to_bank', 1],
    ['payment_run_item.paid', paidItems],
    ['payment_run_item.failed', failed.length],
    ['invoice.paid', paid.length],
    ['invoice.payment_released', docs.length - paid.length],
    ['wht_certificate.issued', certificates.length],
    ['withholding_tax.recorded', certificates.length],
    ['payment_run.completed', 1],
    ['supplier_notice.sent', adviceTo.length],
  ] as const) {
    expect(count(done.events, type), `${times} × ${type}`).toBe(times)
  }

  // The e-mails: each paid supplier one advice of this run, its transfer, the account's last four digits only, the
  // invoice paid, and the 50 ทวิ attached when tax was withheld; the failed supplier none
  for (const s of suppliers) {
    const email = sheet.suppliers.get(s)!.email
    const fresh = (await messagesTo(email)).filter((m) => !mailboxes.get(s)!.has(m.ID) && m.Subject.includes(`รอบ ${number}`) && m.Subject.includes('Payment advice'))
    if (failedSet.has(s)) {
      expect(fresh, `${s} gets no advice`).toHaveLength(0)
      continue
    }
    expect(fresh, `${s} gets one advice`).toHaveLength(1)
    const advice = fresh[0]!
    const d = docs.find((x) => x.supplier === s)!
    const account = money.supplierAccounts.get(s)!
    expect(advice.Text).toContain(`โอนเงิน ${baht(d.transferSatang)} บาท`)
    expect(advice.Text).toContain(`เลขที่ลงท้าย ${account.accountNo.slice(-4)}`)
    expect(advice.Text).not.toContain(account.accountNo)
    expect(advice.Text).toContain(d.invoiceNo)
    const c = certificates.find((x) => x.supplier === s)
    const certificate = done.items.find((i) => i.supplier === s)!.certificate
    if (c && certificate) {
      const type = money.whtTypes.get(d.whtIncomeType!)!
      expect(advice.Attachments.map((a) => [a.FileName, a.ContentType])).toEqual([[`50twi-${certificate.number.replace(/\//g, '-')}.pdf`, 'application/pdf']])
      expect(advice.Text).toContain(`หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) เลขที่ ${certificate.number}`)
      expect(advice.Text).toContain(`ภาษีหัก ณ ที่จ่าย ${type.nameTh} ${type.rateBp / 100}% จากฐาน ${baht(sheetSatang(c.base, 'base'))} บาท เป็นเงิน ${baht(sheetSatang(c.tax, 'tax'))} บาท`)
    } else {
      expect(advice.Attachments, `${s}: nothing withheld, no 50 ทวิ`).toEqual([])
    }
  }

  // The run's page: done, each paid supplier's advice sent
  await page.reload()
  await expect(page.getByText(th('payRun.status.COMPLETED'), { exact: true }).first()).toBeVisible()
  await page.getByRole('tab', { name: th('payRun.run.tab.results'), exact: true }).click()
  await expect(page.getByText(th('payRun.results.advice.SENT'), { exact: true })).toHaveCount(adviceTo.length)

  // The tax page lists each 50 ทวิ of the run with its form, the base paid and the tax withheld
  await page.goto('/finance/wht')
  await expect(h1(page)).toHaveText(th('apTax.wht.title'))
  for (const c of certificates) {
    const certificate = done.items.find((i) => i.supplier === c.supplier)!.certificate!
    const row = page.getByRole('table', { name: th('apTax.wht.list') }).getByRole('row').filter({ hasText: certificate.number })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(th(`apTax.wht.forms.${c.form}`))
    await expect(row).toContainText(baht(sheetSatang(c.base, 'base')))
    await expect(row).toContainText(baht(sheetSatang(c.tax, 'tax')))
  }
})
