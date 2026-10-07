import { spawnSync } from 'node:child_process'
import AxeBuilder from '@axe-core/playwright'
import type { Page, TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect } from './fixtures'

// Shared steps of the finance e2e specs (unit g): the scene script, signing in, and the checks of every page state —
// axe, no sideways scrolling, and pictures at the project's width (375 px or 1440 px, §9.9 step 4).

/** Runs tests/e2e/finance-scene.ts against the e2e database and returns what it printed last */
export function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/finance-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`finance scene ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** A test that first runs a scene (approvals, consolidation, e-mails through the services) needs more than 30 s */
export const SCENE_TEST_TIMEOUT_MS = 180_000

/** A tag no other run or project shares */
export const tagOf = (testInfo: TestInfo) => `${testInfo.project.name.slice(0, 1)}${Date.now().toString(36)}`

export async function signIn(page: Page, code: string, withTotp: boolean) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${code}@demo.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  if (withTotp) {
    await expect(page).toHaveURL(/\/login\/2fa$/)
    await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, code)))
    await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  }
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

async function expectNoBlockingAxe(page: Page) {
  // Next streams the <title> after the first HTML: let it arrive before axe reads the page (a page without one still fails)
  await page.waitForFunction(() => document.title !== '', undefined, { timeout: 5_000 }).catch(() => undefined)
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
}

/**
 * axe, no sideways scrolling, and two pictures: the whole page with the action bar back in its place (a full-page
 * capture would draw the phone's sticky bar where the first screen ended, over the content) and, on the phone, the first
 * screen as FINANCE sees it, with the bar stuck to the bottom. A page that has just refreshed after an action (an
 * invoice recorded, a file made) streams its title in after its content: the check waits for it, as a reader would.
 */
export async function check(page: Page, testInfo: TestInfo, name: string) {
  await expect(page).toHaveTitle(/\S/)
  await expectNoBlockingAxe(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}: no sideways scrolling`).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, style: '.sticky { position: static !important; }' })
  if (testInfo.project.name === 'mobile') await page.screenshot({ path: testInfo.outputPath(`${name}-screen.png`) })
}

/** The heading of the page */
export const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
