import { spawnSync } from 'node:child_process'
import { E2E_BASE_URL, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen } from './liff-support'

// S7-11 (FR-SUP-105 · scene 5 of Demo_Script_P2 on the supplier's side): on a phone, the contact opens the PO sent to its
// supplier, acknowledges it with the date it delivers, then moves the date with a reason; the requester and the receiver
// heard of the acknowledgement in their digest, and of the new date at once with the buyer who made the PO. Each page
// is checked with axe at 375 and 1440 px.

function portalScene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/portal-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`portal scene ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!) as T
}

/** The Thai day N days from today, as the date input takes it */
function dayFromToday(days: number): string {
  const d = new Date(Date.now() + 7 * 3_600_000 + days * 86_400_000)
  return d.toISOString().slice(0, 10)
}

test.describe('@portal the supplier acknowledges a PO', () => {
  test.describe.configure({ timeout: 180_000 })

  test('[FR-SUP-105/AC2] [FR-SUP-105/AC3] acknowledge with a date, move it with a reason; the requester, the receiver and the buyer are told', async ({ page, context }, testInfo) => {
    const made = portalScene<{ org: string; poId: string; number: string; sid: string; csrf: string; requester: string; receiver: string; buyer: string }>('po')
    await context.addCookies([
      { name: 'bcs_portal', value: made.sid, url: `${E2E_BASE_URL}/portal/${made.org}` },
      { name: 'bcs_portal_csrf', value: made.csrf, url: `${E2E_BASE_URL}/portal/${made.org}` },
    ])
    await page.goto(`/portal/${made.org}/pos`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ใบสั่งซื้อ')
    await checkScreen(page, testInfo, 'portal-pos')
    await page.getByRole('link', { name: made.number }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(made.number)
    await expect(page.getByText('ปูนซีเมนต์ถุง 50 กก.')).toBeVisible()
    await checkScreen(page, testInfo, 'portal-po')

    await page.getByLabel('วันส่งที่แจ้ง').fill(dayFromToday(5))
    await page.getByRole('button', { name: 'รับทราบใบสั่งซื้อนี้' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'รับทราบแล้ว' })).toBeVisible()
    await checkScreen(page, testInfo, 'portal-po-acked')

    await page.getByLabel('วันส่งที่แจ้ง').fill(dayFromToday(9))
    await page.getByLabel('เหตุผลที่เปลี่ยน').fill('โรงงานผลิตไม่ทันรอบแรก')
    await page.getByRole('button', { name: 'แจ้งวันส่งใหม่' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'แจ้งวันส่งใหม่แล้ว' })).toBeVisible()
    await expect(page.getByText(/เปลี่ยนวันส่งเมื่อ/)).toBeVisible()

    const told = portalScene<{ status: string; told: Array<{ templateKey: string; recipientMemberId: string; urgency: string }> }>('po-told', made.poId)
    expect(told.status).toBe('DELIVERY_UPDATED')
    const to = (template: string) => told.told.filter((n) => n.templateKey === template).map((n) => n.recipientMemberId)
    expect(to('po.acknowledged')).toEqual(expect.arrayContaining([made.requester, made.receiver]))
    expect(to('po.delivery_changed')).toEqual(expect.arrayContaining([made.requester, made.receiver, made.buyer]))
    expect(told.told.filter((n) => n.templateKey === 'po.delivery_changed').every((n) => n.urgency === 'IMMEDIATE')).toBe(true)
  })
})
