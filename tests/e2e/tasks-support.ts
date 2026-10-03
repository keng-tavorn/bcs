import AxeBuilder from '@axe-core/playwright'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type Locator, type Page, type TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect } from './fixtures'

// Shared steps of the S2-12 e2e specs (tasks*.spec.ts, request-view*.spec.ts): signing in as a seeded member, axe,
// screenshots at the project's width (§9.9 step 4), and the fixture script that adds activity through the services.

/**
 * The people of each Playwright project: desktop and mobile never touch the same records in the shared database.
 * seedRequester made the two requests of seed-activity.ts that wait for the approver; requester makes the requests of
 * tasks-fixtures.ts, from a department whose budget line has room for them; follower follows the requester's waiting
 * request; proposer (an ORG_ADMIN) proposes the policy changes and may open DOA versions; doaVersionNo is the edition
 * of DOA-DEMO the project sends to the CEO (other specs use 11–13 and 21–23).
 */
export function castOf(testInfo: TestInfo) {
  return testInfo.project.name === 'mobile'
    ? {
        approver: 'vp_sup',
        approverName: 'วิไล สนับสนุน',
        approverRole: 'รองประธานสายงาน สายสนับสนุน',
        seedRequester: 'fin_officer',
        seedRequesterName: 'ฟ้าใส บัญชี',
        seedRequesterTotp: true,
        seedBudgetDepartment: 'FIN',
        requester: 'req_it',
        requesterName: 'ไอยรา ระบบงาน',
        proposer: 'admin2',
        proposerName: 'สมศักดิ์ ดูแลร่วม',
        appointee: 'req_con2',
        appointeeName: 'วิศวะ หน้างาน',
        appointDepartment: 'IT',
        appointDepartmentName: 'ฝ่ายไอที',
        stranger: 'asst_con',
        follower: 'req_con',
        doaVersionNo: 62,
      }
    : {
        approver: 'vp_ops',
        approverName: 'วีระ ปฏิบัติการ',
        approverRole: 'รองประธานสายงาน สายปฏิบัติการ',
        seedRequester: 'req_con',
        seedRequesterName: 'สมชาย ใจดี',
        seedRequesterTotp: false,
        seedBudgetDepartment: 'CON',
        requester: 'req_con',
        requesterName: 'สมชาย ใจดี',
        proposer: 'admin',
        proposerName: 'แอดมิน ดูแลระบบ',
        appointee: 'asst_con',
        appointeeName: 'สมหญิง รักงาน',
        appointDepartment: 'CON',
        appointDepartmentName: 'ฝ่ายก่อสร้าง',
        stranger: 'req_it',
        follower: 'req_con2',
        doaVersionNo: 61,
      }
}

export async function expectNoBlockingAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
}

export async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

/** Signs in with the seeded password, and with the TOTP derived from SEED_TOTP_KEY when the member needs 2FA */
export async function signIn(page: Page, code: string, withTotp: boolean) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${code}@demo.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  if (withTotp) {
    await expect(page).toHaveURL(/\/login\/2fa$/)
    await page.getByLabel('รหัส 6 หลักจากแอป').fill(totpOf(code))
    await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  }
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

export const totpOf = (code: string) => totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, code))

/** Runs tests/e2e/tasks-fixtures.ts against the e2e database and returns what it created */
export function fixture<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/tasks-fixtures.ts ${args.join(' ')}`, { shell: true, env: { ...process.env, ...e2eEnv() }, encoding: 'utf8' })
  const line = (r.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('FIXTURE '))
  if (r.status !== 0 || !line) throw new Error(`fixture ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(line.slice('FIXTURE '.length)) as T
}

/**
 * A fixture created once per project and run, so a worker that restarts after a failed test reuses it instead of
 * spending more budget: kept in the output folder under the id of the Playwright runner (the workers' parent process).
 */
export function fixtureOnce<T>(testInfo: TestInfo, name: string, ...args: string[]): T {
  const file = path.join(testInfo.project.outputDir, `.fixture-${name}-${testInfo.project.name}-${process.ppid}.json`)
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as T
  const made = fixture<T>(...args)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(made))
  return made
}

/** The row of a list that contains this text */
export const rowWith = (list: Locator, text: string | RegExp) => list.getByRole('listitem').filter({ hasText: text })

/**
 * Presses "เปิดไฟล์ <name>" and returns the short-lived address the page was sent to (FR-PLT-004 AC2). The navigation
 * is answered "204 No Content", so the browser stays on the page and the test reads the file from that address itself.
 */
export async function openAttachment(page: Page, name: string): Promise<string> {
  let opened = ''
  const presigned = /X-Amz-Signature=/
  await page.route(presigned, async (route) => {
    opened = route.request().url()
    await route.fulfill({ status: 204 })
  })
  await page.getByRole('button', { name: `เปิดไฟล์ ${name}` }).click()
  await expect.poll(() => opened).toMatch(/X-Amz-Expires=\d+/)
  await page.unroute(presigned)
  return opened
}
