import { spawnSync } from 'node:child_process'
import AxeBuilder from '@axe-core/playwright'
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { E2E_BASE_URL, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'

// S17-13 /go/receive, BCS Go's receiving without a signal (FR-PLT-301 AC7 AC8 AC9, BR-APP-03 to BR-APP-10), on the
// production build with its service worker. Each test makes its own sent POs for a fresh receiver through the services
// (tests/e2e/receiving-scene.ts) with BCS Go switched on for the demo organization (tests/e2e/go-receive-scene.ts), and
// cuts the network with the browser's own offline mode. A lost answer is a request that reached the server and whose
// answer the page never got (route.fetch, then the request aborted); those tests block the service worker, since a
// route set on the page does not see what a worker answers. Every page state is checked with axe, for horizontal
// scrolling, and photographed at the project's width (375 px or 1440 px, §9.9 step 4). S17-14 adds finding a PO by its
// number in the browser (a QR from the app's scanner is matched by tests/unit/go-scan.test.ts and the server's
// resolve by tests/integration/go-receiving.test.ts; the camera itself is tried on a phone, docs/runbooks/bcs-go-demo.md).

type Scene = { poId: string; number: string; receiver: string }

function run(script: string, args: string[], extra: Record<string, string> = {}): string {
  const r = spawnSync(`pnpm exec tsx ${script} ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), ...extra } })
  if (r.status !== 0) throw new Error(`${script} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
  return r.stdout.trim().split('\n').at(-1)!
}

/** A sent PO (plywood, nails and PPE) for a fresh receiver, or for the receiver of an earlier scene */
function sentPo(testInfo: TestInfo, receiver?: string): Scene {
  const tag = `${testInfo.project.name.slice(0, 1)}${Date.now().toString(36)}`
  const out = JSON.parse(run('tests/e2e/receiving-scene.ts', [], { SCENE_MODE: 'demo', SCENE_RUN: tag, ...(receiver ? { SCENE_RECEIVER: receiver } : {}) })) as Scene
  return out
}

type Receipt = { number: string; offline: boolean; receivedBeforePosted: boolean; photos: number; channel: string; schemaVersion: number }
const receiptsOf = (poId: string) => (JSON.parse(run('tests/e2e/go-receive-scene.ts', ['receipts', poId])) as { receipts: Receipt[] }).receipts

test.beforeAll(() => {
  run('tests/e2e/go-receive-scene.ts', ['module', 'on'])
})
test.afterAll(() => {
  run('tests/e2e/go-receive-scene.ts', ['module', 'off'])
})

async function check(page: Page, testInfo: TestInfo, name: string) {
  await expect(page).toHaveTitle(/\S/)
  // A sheet or dialog that has just opened fades in: its colours are measured once it stands still
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

async function signIn(page: Page, code: string) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${code}@demo.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, code)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

/** A context without the service worker (a route on the page then sees every request), signed in as the receiver */
async function withoutWorker(browser: Browser, testInfo: TestInfo, clientIp: string, code: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...testInfo.project.use, baseURL: E2E_BASE_URL, serviceWorkers: 'block', extraHTTPHeaders: { 'x-forwarded-for': clientIp } })
  const page = await context.newPage()
  await signIn(page, code)
  return { context, page }
}

/** A camera-sized photo made by the browser itself (a real JPEG, so the page can shrink it before keeping it) */
async function photo(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 3000
    canvas.height = 2000
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#8a6d3b'
    ctx.fillRect(0, 0, 3000, 2000)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.9))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let text = ''
    for (const b of bytes) text += String.fromCharCode(b)
    return btoa(text)
  })
  return Buffer.from(base64, 'base64')
}

const count = (page: Page, label: string) => page.locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd')

/** Records a receipt of the first line on a prepared copy, with a photo when one is given */
async function record(page: Page, po: Scene, picture: Buffer | null) {
  await page.getByRole('button', { name: `บันทึกตรวจรับ ${po.number}` }).click()
  await expect(page.getByRole('heading', { name: `บันทึกตรวจรับ ${po.number}` })).toBeVisible()
  await page.getByLabel(/รับรอบนี้/).first().fill('1')
  await page.getByLabel('เลขที่ใบส่งของ').fill(`DN-${po.number}`)
  if (picture) {
    await page.locator('input[type=file]').setInputFiles({ name: 'site.jpg', mimeType: 'image/jpeg', buffer: picture })
    await expect(page.getByRole('button', { name: /^เอารูป .+ ออก$/ })).toBeVisible()
  }
  await page.getByRole('button', { name: 'บันทึกไว้ในเครื่อง' }).click()
  await expect(page.getByRole('heading', { name: 'รายการรอส่ง' })).toBeVisible()
}

/** The queue as the phone keeps it (IndexedDB bcs-go-receive) */
const storedQueue = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('bcs-go-receive')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('kv')) return resolve(0)
          const read = db.transaction('kv').objectStore('kv').get('queue')
          read.onsuccess = () => resolve(Array.isArray(read.result) ? read.result.length : 0)
          read.onerror = () => reject(read.error)
        }
      }),
  )

test('[FR-PLT-301/AC7] [FR-PLT-301/AC8] offline: the page opens from the phone, two receipts with photos are kept, and with a signal they become two GRs', async ({ page, context }, testInfo) => {
  test.setTimeout(240_000)
  const first = sentPo(testInfo)
  const second = sentPo(testInfo, first.receiver)
  await signIn(page, first.receiver)

  // Opened once with a signal: the page prepares the copies and the worker keeps its shell and static files
  await page.goto('/go/receive')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ตรวจรับหน้างาน')
  await expect(page.getByRole('button', { name: `บันทึกตรวจรับ ${first.number}` })).toBeVisible()
  await expect(page.getByRole('button', { name: `บันทึกตรวจรับ ${second.number}` })).toBeVisible()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const hit = await caches.match('/go/receive')
        const statics = []
        for (const key of await caches.keys()) if (key.startsWith('bcs-go-')) for (const r of await (await caches.open(key)).keys()) if (new URL(r.url).pathname.startsWith('/_next/static/')) statics.push(r.url)
        return Boolean(hit) && statics.length > 0
      }),
    )
    .toBe(true)
  await check(page, testInfo, 'go-receive-online')

  await context.setOffline(true)
  try {
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ตรวจรับหน้างาน')
    await expect(page.getByText('ไม่มีสัญญาณ บันทึกไว้ในเครื่องก่อน')).toBeVisible()
    const picture = await photo(page)
    await record(page, first, picture)
    await expect(page.getByText('บันทึกไว้ในเครื่องแล้ว จะส่งให้เองเมื่อมีสัญญาณ')).toBeVisible()
    await record(page, second, picture)
    await expect(count(page, 'รอส่ง')).toHaveText('2')
    await check(page, testInfo, 'go-receive-offline-queue')
    // Nothing went while there was no signal
    expect(receiptsOf(first.poId)).toEqual([])
  } finally {
    await context.setOffline(false)
  }

  // The signal is back: the photos go up and the receipts go, oldest first, and the phone keeps nothing of them
  await expect(page.getByText('ไม่มีรายการค้างในเครื่อง')).toBeVisible({ timeout: 60_000 })
  await expect(count(page, 'รอส่ง')).toHaveText('0')
  expect(await storedQueue(page)).toBe(0)
  for (const po of [first, second]) {
    expect(receiptsOf(po.poId)).toEqual([expect.objectContaining({ offline: true, receivedBeforePosted: true, photos: 1, channel: 'WEB', schemaVersion: 2 })])
  }
  await check(page, testInfo, 'go-receive-sent')
})

test('[FR-PLT-301/AC8] an answer lost after the server recorded the receipt: it goes again with the same key and stays one GR', async ({ browser, clientIp }, testInfo) => {
  test.setTimeout(180_000)
  const po = sentPo(testInfo)
  const { context, page } = await withoutWorker(browser, testInfo, clientIp, po.receiver)
  try {
    const keys: string[] = []
    await page.route('**/api/go/receiving/gr', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      keys.push(route.request().headers()['idempotency-key'] ?? '')
      if (keys.length > 1) return route.continue()
      // The server records the receipt; its answer never reaches the page
      await route.fetch()
      await route.abort('connectionfailed')
    })
    await page.goto('/go/receive')
    await expect(page.getByRole('button', { name: `บันทึกตรวจรับ ${po.number}` })).toBeVisible()
    await record(page, po, null)
    // The first send has no answer: the page waits and tries again with the same key
    await expect(page.getByText('ส่งไม่ได้ จะลองอีกครั้ง')).toBeVisible({ timeout: 30_000 })
    await expect(count(page, 'อาจบันทึกแล้ว')).toHaveText('1')
    expect(receiptsOf(po.poId)).toHaveLength(1)
    await check(page, testInfo, 'go-receive-retry')
    await expect(page.getByText('ไม่มีรายการค้างในเครื่อง')).toBeVisible({ timeout: 60_000 })
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
    expect(receiptsOf(po.poId)).toEqual([expect.objectContaining({ offline: true })])
  } finally {
    await context.close()
  }
})

test('[FR-PLT-301/AC9] signing out while a receipt may be recorded warns "อาจบันทึกแล้ว", then deletes it from the phone once confirmed', async ({ browser, clientIp }, testInfo) => {
  test.setTimeout(180_000)
  const po = sentPo(testInfo)
  const { context, page } = await withoutWorker(browser, testInfo, clientIp, po.receiver)
  try {
    // Every send of the receipt leaves without an answer: nobody knows whether the server recorded it
    await page.route('**/api/go/receiving/gr', (route) => (route.request().method() === 'POST' ? route.abort('connectionfailed') : route.continue()))
    await page.goto('/go/receive')
    await expect(page.getByRole('button', { name: `บันทึกตรวจรับ ${po.number}` })).toBeVisible()
    await record(page, po, null)
    await expect(count(page, 'อาจบันทึกแล้ว')).toHaveText('1')

    await page.getByRole('button', { name: 'ออกจากระบบ' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'ออกจากระบบและลบรายการในเครื่อง?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('อาจบันทึกแล้ว 1 รายการ ดูการตรวจรับล่าสุดของใบสั่งซื้อก่อนบันทึกใหม่')
    await check(page, testInfo, 'go-receive-sign-out')
    // Kept: nothing is deleted until the receiver confirms
    await dialog.getByRole('button', { name: 'ยังไม่ออก' }).click()
    expect(await storedQueue(page)).toBe(1)

    await page.getByRole('button', { name: 'ออกจากระบบ' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'ลบและออกจากระบบ' }).click()
    await expect(page).toHaveURL(/\/login$/)
    expect(await storedQueue(page)).toBe(0)
    expect(receiptsOf(po.poId)).toEqual([])
  } finally {
    await context.close()
  }
})

test('[FR-PLT-301/AC9] the menu’s sign-out on a phone that keeps a receipt opens the queue’s warning first', async ({ browser, clientIp, isMobile }, testInfo) => {
  test.setTimeout(180_000)
  const po = sentPo(testInfo)
  const { context, page } = await withoutWorker(browser, testInfo, clientIp, po.receiver)
  try {
    await page.route('**/api/go/receiving/gr', (route) => (route.request().method() === 'POST' ? route.abort('connectionfailed') : route.continue()))
    await page.goto('/go/receive')
    await expect(page.getByRole('button', { name: `บันทึกตรวจรับ ${po.number}` })).toBeVisible()
    await record(page, po, null)
    await expect(count(page, 'อาจบันทึกแล้ว')).toHaveText('1')

    // Elsewhere in the workspace, "ออกจากระบบ" of the menu (on a phone at the foot of the menu sheet)
    await page.goto('/receiving')
    if (isMobile) {
      await page.getByRole('button', { name: 'ยุบหรือขยายเมนู' }).click()
      await page.getByRole('dialog').getByRole('region', { name: 'บัญชีของฉัน' }).getByRole('button', { name: 'ออกจากระบบ' }).click()
    } else {
      const bar = page.locator('header').first()
      await bar.locator('summary[aria-label="บัญชีของฉัน"]').click()
      await bar.getByRole('button', { name: 'ออกจากระบบ' }).click()
    }
    // Not signed out yet: /go/receive asks first, by kind (BR-APP-09)
    await expect(page).toHaveURL(/\/go\/receive$/)
    const dialog = page.getByRole('alertdialog', { name: 'ออกจากระบบและลบรายการในเครื่อง?' })
    await expect(dialog).toContainText('อาจบันทึกแล้ว 1 รายการ')
    await check(page, testInfo, 'go-receive-menu-sign-out')
    await dialog.getByRole('button', { name: 'ลบและออกจากระบบ' }).click()
    await expect(page).toHaveURL(/\/login$/)
    expect(await storedQueue(page)).toBe(0)
  } finally {
    await context.close()
  }
})

test('[FR-PLT-301/AC6] in the PWA the receiver types the PO number: its receipt form opens; a number not among the copies is not found', async ({ page }, testInfo) => {
  test.setTimeout(150_000)
  const po = sentPo(testInfo)
  await signIn(page, po.receiver)
  await page.goto('/go/receive')
  await expect(page.getByRole('button', { name: `บันทึกตรวจรับ ${po.number}` })).toBeVisible()
  // A browser has no scanner of the app: the PO number instead (BR-APP-11)
  await expect(page.getByRole('button', { name: 'สแกน QR บนใบสั่งซื้อ' })).toHaveCount(0)
  await page.getByLabel('เลขใบสั่งซื้อ').fill('PO-0000-99999')
  await page.getByRole('button', { name: 'หาใบสั่งซื้อ' }).click()
  const none = page.getByRole('dialog', { name: 'ผลการค้นหา' })
  await expect(none).toContainText('ไม่พบ PO นี้ในรายการที่ตรวจรับได้')
  await check(page, testInfo, 'go-receive-find-none')
  await page.keyboard.press('Escape')
  await expect(none).toHaveCount(0)

  await page.getByLabel('เลขใบสั่งซื้อ').fill(` ${po.number.toLowerCase()} `)
  await page.getByRole('button', { name: 'หาใบสั่งซื้อ' }).click()
  const found = page.getByRole('dialog', { name: po.number })
  await expect(found).toContainText('3 รายการ')
  await check(page, testInfo, 'go-receive-find-found')
  await found.getByRole('button', { name: `บันทึกตรวจรับ ${po.number}` }).click()
  await expect(page.getByRole('heading', { name: `บันทึกตรวจรับ ${po.number}` })).toBeVisible()
  await check(page, testInfo, 'go-receive-find-form')
})
