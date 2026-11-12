import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Page, TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '@/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { expectNoBlockingAxe } from './liff-support'

// S11-10 (FR-RSK-204 AC1 · BR-RSK-14 · docs/sub-specs/S11.md "หน้าจอ"): PROCUREMENT of a test organization opens /risk,
// finds the supplier whose assessment is due soon, opens its risk file (the assessment with its answers, the override,
// the reassessment, the timeline), sees the same file as the tab "ความเสี่ยง" of /suppliers/[id] and the badges in
// /suppliers, and opens a new assessment for a supplier never assessed. Every page is checked with axe at 1440 and 375 px,
// without a sideways scroll on the phone (§9.9).

type Scene = { tag: string; assessedId: string; assessedCode: string; freshId: string; freshCode: string }

function scene(...args: string[]): Scene {
  const r = spawnSync(`pnpm exec tsx tests/e2e/risk-file-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`risk file scene ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!) as Scene
}

async function signIn(page: Page, local: string) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${local}@p2.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, local)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

/** axe and a picture at 1440 px, then at 375 px (§9.9 step 4), no sideways scroll on the phone */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath(`${name}-1440.png`), fullPage: true })
  const wide = page.viewportSize()
  await page.setViewportSize({ width: 375, height: 812 })
  await expectNoBlockingAxe(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: no sideways scroll at 375 px`).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`${name}-375.png`), fullPage: true })
  if (wide) await page.setViewportSize(wide)
}

test.describe('@s11 the supplier risk file', () => {
  test.describe.configure({ timeout: 240_000 })

  test('[FR-RSK-204/AC1] /risk, the risk file, the tab on the supplier page and a new assessment from the file', async ({ page }, testInfo) => {
    const s = scene('setup', randomBytes(3).toString('hex'))
    await signIn(page, `proc_officer.${s.tag}`)

    // the overview: the supplier due soon, its override running out, its reassessment
    await page.goto('/risk')
    await expect(page.getByRole('heading', { name: 'ความเสี่ยงคู่ค้า', level: 1 })).toBeVisible()
    const row = page.getByRole('link', { name: new RegExp(s.assessedCode) }).first()
    await expect(row).toBeVisible()
    await shot(page, testInfo, 's11-10-risk')
    await page.goto('/risk?tab=overrides')
    await expect(page.getByText('ใกล้หมดอายุ')).toBeVisible()
    await page.goto('/risk?tab=reviews')
    await expect(page.getByRole('link', { name: new RegExp(`${s.assessedCode}.*ครบรอบ`) })).toBeVisible()

    // the risk file
    await page.goto(`/risk/suppliers/${s.assessedId}`)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('แฟ้มความเสี่ยง')
    await expect(page.getByRole('list', { name: 'ใบประเมิน' }).getByRole('listitem').first()).toBeVisible()
    await expect(page.getByRole('list', { name: 'การอนุมัติข้าม' })).toContainText('RO-E2E')
    await expect(page.getByRole('list', { name: 'การประเมินซ้ำ' })).toContainText('ครบรอบ')
    await expect(page.getByRole('list', { name: 'ไทม์ไลน์' })).toContainText('ใบประเมินเสร็จ')
    await expect(page.getByRole('button', { name: 'ส่งออก Excel' })).toBeVisible()
    await shot(page, testInfo, 's11-10-risk-file')

    // the same file as the supplier page's tab, and the badges of the list
    await page.goto(`/suppliers/${s.assessedId}?tab=risk`)
    await expect(page.getByRole('tab', { name: 'ความเสี่ยง' })).toHaveAttribute('data-state', 'active')
    await expect(page.getByRole('list', { name: 'การอนุมัติข้าม' })).toContainText('RO-E2E')
    await shot(page, testInfo, 's11-10-supplier-risk-tab')
    await page.goto(`/suppliers?q=${s.assessedCode}`)
    await expect(page.getByText('ใกล้ครบรอบ').first()).toBeVisible()

    // a new assessment from the file of a supplier never assessed
    await page.goto(`/risk/suppliers/${s.freshId}`)
    await page.getByRole('button', { name: 'เปิดแบบประเมิน' }).click()
    const dialog = page.getByRole('dialog', { name: 'เปิดแบบประเมินใหม่' })
    await dialog.getByRole('radio').first().check()
    await dialog.getByLabel('มาตรฐานที่งานต้องการ').fill('ISO 27001')
    await shot(page, testInfo, 's11-10-open-dialog')
    await dialog.getByRole('button', { name: 'เปิดแบบประเมิน' }).click()
    await expect(page).toHaveURL(/\/risk\/assessments\/[0-9a-f-]{36}$/)
  })
})
