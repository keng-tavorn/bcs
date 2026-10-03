import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import AxeBuilder from '@axe-core/playwright'
import ExcelJS from 'exceljs'
import { type Page, type TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect } from './fixtures'

// Shared steps of unit i's e2e specs (board*.spec.ts, audit*.spec.ts, kpi*.spec.ts, reports*.spec.ts; S4-10, S4-11,
// S5-12, demo scene 9): the scene that builds their data through the services (tests/e2e/insight-scene.ts), signing in,
// axe, the phone-width check, screenshots at the project's width (§9.9 step 4), and reading an exported file the way
// the browser downloads it.

export interface Person {
  readonly id?: string
  readonly code: string
  readonly name: string
  readonly email?: string
}

export interface BoardScene {
  readonly run: string
  readonly requester: Person & { readonly email: string }
  readonly department: { readonly id: string; readonly name: string }
  readonly overdue: { readonly id: string; readonly number: string; readonly title: string; readonly approver: Person; readonly approverDepartment: { readonly id: string; readonly nameTh: string } }
  readonly waiting: { readonly id: string; readonly number: string; readonly title: string; readonly approver: Person }
}

export interface DecisionsScene {
  readonly run: string
  readonly requester: Person & { readonly email: string }
  readonly requests: ReadonlyArray<{ readonly id: string; readonly number: string; readonly title: string; readonly taskId: string; readonly channel: 'LINE_CHAT' | 'LIFF' | 'WEB'; readonly approver: Person }>
  readonly doa: { readonly versionId: string; readonly code: string; readonly versionNo: number; readonly ruleCode: string }
  readonly kpi: {
    readonly from: string
    readonly to: string
    readonly all: { readonly numerator: number; readonly denominator: number }
    readonly pr: { readonly numerator: number; readonly denominator: number }
  }
}

/**
 * Every notice a test causes (the reminders it sends, "your file is ready" after an export) is read by its recipient
 * when the test ends, so no other spec's bell changes. Call once per spec file.
 */
export function settleNoticesAfterEachTest(t: { beforeEach: (fn: () => void) => void; afterEach: (fn: () => void) => void }) {
  let startedAt = ''
  t.beforeEach(() => {
    startedAt = new Date().toISOString()
  })
  t.afterEach(() => {
    if (startedAt) scene('settle', startedAt)
  })
}

/** Runs tests/e2e/insight-scene.ts against the e2e database and returns the JSON of its last line */
export function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/insight-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`insight scene ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** Signs in with the seeded password, and with the TOTP derived from SEED_TOTP_KEY when the member needs 2FA */
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

/** A seeded member of the demo organization by code; members with a role or a DOA position sign in with TOTP */
export const signInAs = (page: Page, code: string, withTotp = true) => signIn(page, `${code}@demo.bcs.local`, withTotp ? code : null)

export async function expectNoBlockingAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
}

/** The page is never wider than the screen (§9.9: no table that scrolls sideways on a phone) */
export async function expectNoSideways(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
}

export async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

/** Axe, no sideways scroll and a full-page screenshot: the §9.9 checks of one screen */
export async function checkScreen(page: Page, testInfo: TestInfo, name: string) {
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, name)
}

/**
 * Presses an export button and returns the file the browser was sent to download (FR-PLT-004: a short-lived address the
 * server gives after its checks). The navigation is answered "204 No Content" so the page stays, and the test reads
 * the file from that address itself.
 */
export async function exportedFile(page: Page, buttonName: string): Promise<Uint8Array> {
  let opened = ''
  const presigned = /X-Amz-Signature=/
  await page.route(presigned, async (route) => {
    opened = route.request().url()
    await route.fulfill({ status: 204 })
  })
  await page.getByRole('button', { name: buttonName, exact: true }).click()
  await expect.poll(() => opened, { timeout: 15_000 }).toMatch(/X-Amz-Expires=\d+/)
  await page.unroute(presigned)
  return new Uint8Array(await (await fetch(opened)).arrayBuffer())
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** The checksum the page shows after an export */
export async function shownChecksum(page: Page): Promise<string> {
  const text = await page.getByText(/^ค่าตรวจสอบไฟล์ \(SHA-256\): [0-9a-f]{64}$/).innerText()
  return text.slice(-64)
}

/** The rows of the first sheet of an Excel file, every cell as text */
export async function sheetRows(bytes: Uint8Array, columns: number): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  const rows: string[][] = []
  workbook.worksheets[0]!.eachRow({ includeEmpty: true }, (row) => rows.push(Array.from({ length: columns }, (_, i) => String(row.getCell(i + 1).value ?? ''))))
  return rows
}

/** RFC 4180 rows of a UTF-8 CSV file with a byte order mark */
export function csvRows(bytes: Uint8Array): string[][] {
  const text = new TextDecoder().decode(bytes).replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows.filter((r) => r.length > 1 || r[0] !== '')
}

/** numerator ÷ denominator in percent with one decimal, half up, as the screens show it */
export function percent(numerator: number, denominator: number): string {
  const tenths = Math.floor((numerator * 1000 * 2 + denominator) / (2 * denominator))
  return `${Math.floor(tenths / 10)}.${tenths % 10}`
}
