import { spawnSync } from 'node:child_process'
import AxeBuilder from '@axe-core/playwright'
import ExcelJS from 'exceljs'
import { type Locator, type Page, type TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect } from './fixtures'

// Shared steps of the budget screens' e2e specs (budgets*.spec.ts, S3-04 S3-07 S3-08): the scene that builds their
// data through the services (tests/e2e/budgets-scene.ts), signing in, axe, the phone-width check and screenshots at the
// project's width (§9.9 step 4).

export interface Figures {
  readonly planned: string
  readonly available: string
  readonly reserved: string
  readonly committed: string
  readonly actual: string
}

export interface Person {
  readonly code: string
  readonly email: string
  readonly name?: string
}

export interface DashboardScene {
  readonly viewer: Person
  readonly budgetAdmin: Person
  readonly requester: Person
  readonly line: { readonly id: string; readonly code: string; readonly name: string }
  readonly fiscalYear: { readonly code: string; readonly endsOn: string }
  readonly reserved: { readonly id: string; readonly number: string }
  readonly ordered: { readonly id: string; readonly number: string }
  readonly po: { readonly id: string; readonly number: string }
  readonly invoiceNo: string
  readonly figures: { readonly line: Figures; readonly fin: Figures; readonly total: Figures }
}

export interface AdminScene {
  readonly run: string
  readonly budgetAdmin: Person
  readonly member: Person & { readonly name: string }
  readonly line: { readonly id: string; readonly code: string; readonly name: string }
  readonly fiscalYear: { readonly code: string; readonly endsOn: string }
  readonly today: string
}

/** Runs tests/e2e/budgets-scene.ts against the e2e database and returns the JSON of its last line */
export function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/budgets-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`budgets scene ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** Signs in with the seeded password, and with the TOTP derived from SEED_TOTP_KEY and `totpCode` when one is given */
export async function signIn(page: Page, email: string, totpCode: string | null) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(email)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  if (totpCode) {
    await expect(page).toHaveURL(/\/login\/2fa$/)
    await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, totpCode)))
    await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  }
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

export async function expectNoBlockingAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
}

/** The page is never wider than the screen (§9.9: no table that scrolls sideways on a phone) */
export async function expectNoSideways(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
}

/**
 * Every row of the list ends with its amount at the row's right edge (§9.9 rule 6: money right-aligned), at the
 * project's width: the amount's own text is measured, so an amount pushed into the left column of a phone's two-column
 * row, or wrapped under its label, is caught.
 */
export async function expectAmountsAtTheRight(list: Locator) {
  await expect(list).toBeVisible()
  const misplaced = await list.evaluate((ul) =>
    Array.from(ul.children).flatMap((li) => {
      const money = li.querySelector('.money')
      if (!money) return [`no amount in "${li.textContent ?? ''}"`]
      const walker = document.createTreeWalker(money, NodeFilter.SHOW_TEXT)
      let amount: Node | null = walker.nextNode()
      while (amount && !/\d\.\d\d$/.test((amount.textContent ?? '').trim())) amount = walker.nextNode()
      if (!amount) return [`no amount in "${money.textContent ?? ''}"`]
      const range = document.createRange()
      range.selectNodeContents(amount)
      const edge = li.getBoundingClientRect().right - parseFloat(getComputedStyle(li).paddingRight)
      const gap = edge - range.getBoundingClientRect().right
      return Math.abs(gap) > 1.5 ? [`${(amount.textContent ?? '').trim()} ends ${Math.round(gap)} px before the row's right edge`] : []
    }),
  )
  expect(misplaced).toEqual([])
}

export async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

/** "40,000.00" as a pattern that matches the start of a cell's text */
export const startsWithAmount = (amount: string) => new RegExp(`^${amount.replace(/[.,]/g, (c) => `\\${c}`)}`)

/** YYYY-MM-DD of today plus `days`, in Thai time, as the date inputs take it */
export function thaiDay(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86_400_000))
}

/** The rows of the first sheet of an Excel file, every cell as text */
export async function sheetRows(bytes: Buffer, sheetName?: string): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(bytes).buffer as ArrayBuffer)
  const sheet = sheetName ? workbook.getWorksheet(sheetName)! : workbook.worksheets[0]!
  const rows: string[][] = []
  sheet.eachRow({ includeEmpty: true }, (row) => {
    rows.push(((row.values as unknown[]) ?? []).slice(1).map((v) => (v === null || v === undefined ? '' : String(v))))
  })
  return rows
}
