import { randomBytes } from 'node:crypto'
import { devices, expect, type Browser, type Locator, type Page } from '@playwright/test'
import { INPUT_WORKBOOKS, loadInputWorkbook } from '../../../src/server/seed/workbook'
import { E2E_BASE_URL } from '../../support/e2e-env'
import { baht, literally, th } from '../demo/support'
import { satangOf, script, signInAs, type P1Scene, type P1Sheet } from './support'

// Shared steps of the money scenes of phase 1 (P1-08 · scenes 8 to 11: invoices of S8 and the payment run of S9). Not a
// test file (the p1demo project runs only *.spec.ts): the scenes import it. Every figure a step checks comes from the
// scene's row of sheet Demo_Script_P1 or the sheets it names; the database is read through ./scripts/s8.ts and s9.ts.

// ---------- what the scene scripts print ----------

export interface Balance {
  readonly available: string
  readonly reserved: string
  readonly committed: string
  readonly actual: string
}

export interface PoFacts {
  readonly ref: string
  readonly poCount: number
  readonly poId: string
  readonly poNumber: string | null
  readonly status: string
  readonly kind: string
  readonly paymentTermDays: number | null
  readonly supplier: string
  readonly invoices: number
  readonly lines: ReadonlyArray<{
    readonly id: string
    readonly lineNo: number
    readonly quantity: string
    readonly received: string
    readonly unitPriceSatang: string
    readonly netSatang: string
    readonly budgetLineId: string
    readonly budgetLineCode: string
    /** The budget line's account code */
    readonly accountCode: string | null
    readonly costCenter: string
    readonly department: string
    readonly categoryCode: string | null
    /** BR-AP-10's history for an invoice of the PO dated today: each code used, how often, the day it was last used */
    readonly codingHistory: ReadonlyArray<{ readonly accountCode: string; readonly count: number; readonly last: string }>
  }>
  readonly balances: Readonly<Record<string, Balance>>
}

export interface InvoiceFacts {
  readonly id: string
  readonly number: string | null
  readonly poId: string
  readonly poNumber: string | null
  readonly status: string
  readonly channel: string
  readonly prefill: string
  readonly matchResult: string | null
  readonly recordedBy: string | null
  readonly inboundEmailId: string | null
  readonly invoiceDate: string | null
  readonly dueDate: string | null
  readonly netSatang: string
  readonly statedVatSatang: string
  readonly grossSatang: string
  readonly payableSatang: string
  readonly expectedWhtSatang: string
  readonly lines: ReadonlyArray<{
    readonly lineNo: number
    readonly quantity: string
    readonly unitPriceSatang: string
    readonly netSatang: string
    readonly matchStatus: string
    readonly accountCode: string | null
    readonly costCenter: string | null
    readonly whtIncomeTypeCode: string | null
    readonly codingConfirmed: boolean
  }>
  readonly exceptions: ReadonlyArray<{ readonly type: string; readonly amountSatang: string; readonly assigneeRole: string; readonly status: string; readonly lineNo: number | null }>
  readonly routes: ReadonlyArray<{
    readonly ruleCode: string
    readonly amountBasis: string
    readonly amountSatang: string | null
    readonly status: string
    readonly tasks: ReadonlyArray<{ readonly assignee: string | null; readonly status: string; readonly decision: string | null; readonly channel: string | null }>
  }>
  readonly variance: { readonly doaRuleCode: string | null; readonly netSatang: string | null; readonly vatSatang: string | null } | null
  readonly readyExpectedWhtSatang: string | null
  readonly balances: Readonly<Record<string, Balance>>
  readonly events: readonly string[]
}

export const s8 = <T>(...args: string[]): T => script<T>('scripts/s8.ts', ...args)
export const s9 = <T>(...args: string[]): T => script<T>('scripts/s9.ts', ...args)

/** The newest event's seq: the events a scene writes come after it */
export const eventSeq = () => s8<{ seq: string }>('seq').seq

/** The PO the history made for a row of Request_History, with what each of its budget lines holds now */
export function poOfHistory(ref: string): PoFacts {
  const po = s8<PoFacts>('po', ref)
  expect(po.poCount, `${ref}: the history ordered its request on one PO`).toBe(1)
  expect(po.poNumber, `${ref}: the PO has its number`).not.toBeNull()
  return po
}

/** What the coding form proposes for a line (BR-AP-10): the account code, or null, and the source written beside it */
export interface Proposal {
  readonly accountCode: string | null
  readonly from: string
}

/**
 * BR-AP-10 from the database's facts, for each line of an invoice of the PO dated today: the code the supplier's history
 * of the line's category used most often (the latest when tied), else the budget line's, else nothing to propose
 */
export function proposalsFor(po: PoFacts): Proposal[] {
  return po.lines.map((l) => {
    const best = [...l.codingHistory].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))[0]
    if (best) return { accountCode: best.accountCode, from: th('apInvoice.coding.from.HISTORY', { count: best.count }) }
    if (l.accountCode) return { accountCode: l.accountCode, from: th('apInvoice.coding.from.BUDGET_LINE') }
    return { accountCode: null, from: th('apInvoice.coding.noSuggestion') }
  })
}

export function invoiceOf(supplier: string, invoiceNo: string, sinceSeq: string): InvoiceFacts {
  const invoice = s8<InvoiceFacts | null>('invoice', supplier, invoiceNo, sinceSeq)
  if (!invoice) throw new Error(`${supplier} has no invoice ${invoiceNo}`)
  return invoice
}

// ---------- more of the phase-1 workbook: withholding types, the suppliers' and the company's bank accounts ----------

export interface MoneySheet {
  /** WHT_Types by code */
  readonly whtTypes: ReadonlyMap<string, { readonly nameTh: string; readonly rateBp: number }>
  /** SupplierPayment by supplier: the account the supplier is paid into */
  readonly supplierAccounts: ReadonlyMap<string, { readonly bankCode: string; readonly accountNo: string }>
  /** CompanyBankAccounts by code */
  readonly companyAccounts: ReadonlyMap<string, { readonly bankCode: string; readonly accountNo: string }>
}

let money: Promise<MoneySheet> | null = null

export function moneySheet(): Promise<MoneySheet> {
  money ??= (async () => {
    const workbook = await loadInputWorkbook(INPUT_WORKBOOKS.p1)
    const need = (sheet: string, row: number, value: string | null | undefined, key: string): string => {
      if (!value) throw new Error(`${sheet} row ${row}: ${key} is empty`)
      return value
    }
    return {
      whtTypes: new Map(
        workbook.table('WHT_Types').map((r) => [need('WHT_Types', r.row, r.values.code, 'code'), { nameTh: need('WHT_Types', r.row, r.values.nameTh, 'nameTh'), rateBp: Number(need('WHT_Types', r.row, r.values.rateBp, 'rateBp')) }] as const),
      ),
      supplierAccounts: new Map(
        workbook
          .table('SupplierPayment')
          .map((r) => [need('SupplierPayment', r.row, r.values.supplierCode, 'supplierCode'), { bankCode: r.values.bankCode ?? '', accountNo: (r.values.accountNo ?? '').replace(/\D/g, '') }] as const),
      ),
      companyAccounts: new Map(
        workbook.table('CompanyBankAccounts').map((r) => [need('CompanyBankAccounts', r.row, r.values.code, 'code'), { bankCode: r.values.bankCode ?? '', accountNo: (r.values.accountNo ?? '').replace(/\D/g, '') }] as const),
      ),
    }
  })()
  return money
}

// ---------- days ----------

/** A day plus some days, YYYY-MM-DD */
export function dayAfter(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

/** RUN_DATE in expectJson: the day the scene runs */
export function expectRunDate(scene: P1Scene, key = 'invoiceDate') {
  expect(scene.expect[key], `Demo_Script_P1 row ${scene.row}: expectJson ${key} is the day of the run`).toBe('RUN_DATE')
}

// ---------- money ----------

/** An amount of the sheet ("1800.00") in satang */
export function sheetSatang(value: unknown, what: string): bigint {
  const s = typeof value === 'string' ? satangOf(value) : null
  if (s === null) throw new Error(`${what}: "${String(value)}" is not an amount in baht`)
  return s
}

/** What a budget line holds now minus what it held before, against the deltas of expectJson.budget */
export function expectBudgetMoved(before: Balance, after: Balance, moved: Readonly<Record<'committed' | 'actual' | 'available', string>>, line: string) {
  const delta = (key: keyof Balance) => BigInt(after[key]) - BigInt(before[key])
  const signed = (value: string) => (value.startsWith('-') ? -sheetSatang(value.slice(1), `budget ${line}`) : sheetSatang(value, `budget ${line}`))
  for (const key of ['committed', 'actual', 'available'] as const) expect(delta(key), `${line}: ${key} moved by ${moved[key]}`).toBe(signed(moved[key]))
}

/** Every event type the row expects is among those written (expectJson.events) */
export function expectEvents(written: readonly string[], expected: readonly string[], what: string) {
  for (const type of expected) expect(written, `${what}: event ${type}`).toContain(type)
}

// ---------- the web ----------

/** Another person's computer in the scene: a browser of its own at 1440 px with a client address of its own, signed in */
export async function deskAs(browser: Browser, sheet: P1Sheet, code: string): Promise<Page> {
  const [a, b] = randomBytes(2)
  const context = await browser.newContext({
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    baseURL: E2E_BASE_URL,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    extraHTTPHeaders: { 'x-forwarded-for': `198.18.${a!}.${(b! % 254) + 1}` },
  })
  const page = await context.newPage()
  await signInAs(page, sheet, code)
  return page
}

export const h1 = (page: Page) => page.getByRole('heading', { level: 1 })

/** The element of this layout: tables show from md up, a list of cards below it */
export const shown = (page: Page, text: string) => page.getByText(text, { exact: true }).filter({ visible: true }).first()

/** A fact of the document's header, the one with the page's title ("ยอดโอน" → its value) */
export function headerFigure(page: Page, label: string): Locator {
  return page
    .locator('header')
    .filter({ has: h1(page) })
    .locator('dt')
    .filter({ hasText: new RegExp(`^${literally(label)}$`) })
    .locator('xpath=following-sibling::dd[1]')
}

/** A figure of the invoice's amounts panel ("ยอดที่ต้องจ่าย" → its value) */
export function figure(page: Page, label: string): Locator {
  return page
    .getByRole('region', { name: th('apInvoice.amounts.title') })
    .locator('dt')
    .filter({ hasText: new RegExp(`^${literally(label)}$`) })
    .locator('xpath=following-sibling::dd[1]')
}

/** The invoice's amounts as FINANCE reads them: payable, expected tax withheld, expected transfer, and when it is due */
export async function expectAmounts(page: Page, a: { readonly payable: bigint; readonly wht: bigint; readonly transfer: bigint; readonly due: string; readonly dueText: string }) {
  await expect(figure(page, th('apInvoice.amounts.payable'))).toHaveText(baht(a.payable))
  await expect(figure(page, th('apInvoice.amounts.wht'))).toHaveText(baht(a.wht))
  await expect(figure(page, th('apInvoice.amounts.transfer'))).toHaveText(baht(a.transfer))
  await expect(page.getByRole('region', { name: th('apInvoice.amounts.title') })).toContainText(th('apInvoice.amounts.due', { date: a.dueText }))
}

/** /finance/invoices/new: the PO by its number, the supplier's file, then the draft's page */
export async function uploadDraft(page: Page, poNumber: string, file: { readonly name: string; readonly buffer: Buffer }): Promise<string> {
  await page.goto('/finance/invoices')
  await expect(h1(page)).toHaveText(th('apList.title'))
  await page.getByRole('link', { name: th('apList.actions.new') }).click()
  await expect(h1(page)).toHaveText(th('apList.new.title'))
  await page.getByRole('combobox', { name: th('apList.new.poLabel') }).click()
  await page.getByPlaceholder(th('apList.new.search')).fill(poNumber)
  await page.getByRole('option', { name: new RegExp(`^${literally(poNumber)} · `) }).click()
  await page.locator('input[type="file"]').setInputFiles({ name: file.name, mimeType: 'application/pdf', buffer: file.buffer })
  await page.getByRole('button', { name: th('apList.new.submitFile') }).click()
  await expect(page).toHaveURL(/\/finance\/invoices\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  await expect(h1(page)).toHaveText(th('apInvoice.titleDraft'))
  return new URL(page.url()).pathname
}

/**
 * The header of a draft typed from the paper invoice: its number, its date picked in the calendar, the VAT it states.
 * Saved, then the page read again so the next save carries the draft's new version.
 */
export async function saveHeader(page: Page, h: { readonly invoiceNo: string; readonly day: string; readonly dayText: string; readonly vat: bigint }) {
  const header = page.getByRole('form', { name: th('apInvoice.header.title') })
  await header.getByLabel(th('apInvoice.header.supplierInvoiceNo')).fill(h.invoiceNo)
  await header.getByLabel(th('apInvoice.header.invoiceDate')).click()
  await page.locator(`td[data-day="${h.day}"] button`).click()
  await expect(header.getByLabel(th('apInvoice.header.invoiceDate'))).toHaveText(h.dayText)
  await header.getByLabel(th('apInvoice.header.statedVat')).fill(`${h.vat / 100n}.${String(h.vat % 100n).padStart(2, '0')}`)
  await header.getByRole('button', { name: th('apInvoice.header.save') }).click()
  await expect(header.getByText(th('apInvoice.header.saved'))).toBeVisible({ timeout: 30_000 })
  await page.reload()
  await expect(page.getByRole('form', { name: th('apInvoice.header.title') }).getByLabel(th('apInvoice.header.supplierInvoiceNo'))).toHaveValue(h.invoiceNo)
}

/**
 * The coding of every line (FR-AP-108, BR-AP-10): the form proposes each line's account code (`proposals`, one per line
 * in order, from proposalsFor) with its source beside it, and the picker shows the proposal already — it must be the
 * code the row expects. Only a line with nothing to propose starts empty, and then the code is picked (the row's stepsTh
 * tells the presenter to pick it). When given, the income type withheld on each line is picked. Confirmed, then the page
 * read again so the submit carries the draft's new version.
 */
export async function confirmCoding(page: Page, c: { readonly accountCode: string; readonly proposals: readonly Proposal[]; readonly incomeType?: { readonly label: RegExp } }) {
  const coding = page.getByRole('region', { name: th('apInvoice.coding.title') })
  const lines = coding.getByRole('list', { name: th('apInvoice.coding.title') }).getByRole('listitem')
  await expect(lines, 'the draft has a line to code for each line of the PO').toHaveCount(c.proposals.length)
  for (const [i, proposal] of c.proposals.entries()) {
    const no = i + 1
    const line = lines.nth(i)
    const picker = line.getByRole('combobox', { name: th('apInvoice.coding.accountCode', { no }), exact: true })
    if (proposal.accountCode === null) {
      await expect(line).toContainText(th('apInvoice.coding.noSuggestion'))
      await expect(picker, `line ${no}: nothing to propose, the picker is empty`).toHaveText(th('apInvoice.coding.pickCode'))
      await picker.click()
      await page.getByRole('option', { name: new RegExp(`^${literally(c.accountCode)} `) }).click()
    } else {
      expect(proposal.accountCode, `line ${no}: BR-AP-10 proposes ${proposal.accountCode} (${proposal.from}), the row codes ${c.accountCode}`).toBe(c.accountCode)
      await expect(line).toContainText(`${th('apInvoice.coding.suggested', { code: proposal.accountCode })} · ${proposal.from}`)
    }
    await expect(picker, `line ${no} is coded ${c.accountCode}`).toHaveText(new RegExp(`^${literally(c.accountCode)} `))
    if (c.incomeType) {
      const type = line.getByRole('combobox', { name: th('apInvoice.coding.incomeType', { no }), exact: true })
      await type.click()
      await page.getByRole('option', { name: c.incomeType.label }).click()
      await expect(type).toHaveText(c.incomeType.label)
    }
  }
  await coding.getByRole('button', { name: th('apInvoice.coding.confirm') }).click()
  await expect(coding.getByText(th('apInvoice.coding.done'))).toBeVisible({ timeout: 30_000 })
  await page.reload()
  const confirmed = page.getByRole('region', { name: th('apInvoice.coding.title') }).getByText(th('apInvoice.coding.confirmed'), { exact: true })
  await expect(confirmed).toHaveCount(c.proposals.length)
}

/**
 * "ส่งจับคู่": the invoice gets its number and the match says where it goes — the page shows it under its number with
 * the status of the match (the line of the result is gone with the draft's panel once the page refreshes); returns the
 * number
 */
export async function submitDraft(page: Page, status: 'READY_FOR_PAYMENT' | 'EXCEPTION'): Promise<string> {
  await page.getByRole('button', { name: th('apInvoice.draft.submit') }).click()
  const titled = new RegExp(`^${literally(th('apInvoice.title', { number: '@' })).replace('@', '(\\S+)')}$`)
  await expect(h1(page)).toHaveText(titled, { timeout: 30_000 })
  await expect(shown(page, th(`apInvoice.status.${status}`))).toBeVisible()
  return titled.exec((await h1(page).textContent())!.trim())![1]!
}
