import { spawnSync } from 'node:child_process'
import AxeBuilder from '@axe-core/playwright'
import type { Browser, Locator, Page, TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { E2E_BASE_URL, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { settled } from './settled'

// S4-07 receiving on the web and on a phone (FR-P2P-006, FR-P2P-007, FR-P2P-010 AC2; demo scene 8). Each test makes its
// own sent PO through the services (tests/e2e/receiving-scene.ts) for a fresh requester of the construction department.
// The receiver of each project is its own, so TOTP codes never repeat: receiver_con on the phone (the demo's receiver),
// a fresh RECEIVER on the desktop. Every page state is checked with axe, for horizontal scrolling, and photographed at
// the project's width (375 px or 1440 px, §9.9 step 4).

type Scene = { poId: string; number: string; requestNumber: string; receiver?: string; approverReceiver?: string; requester?: string; grNumber?: string }

function scene(mode: 'demo' | 'sod' | 'variance' | 'closeShort', testInfo: TestInfo, extra: Record<string, string> = {}): Scene {
  const run = `${testInfo.project.name.slice(0, 1)}${Date.now().toString(36)}`
  const r = spawnSync('pnpm exec tsx tests/e2e/receiving-scene.ts', { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), SCENE_MODE: mode, SCENE_RUN: run, ...extra } })
  if (r.status !== 0) throw new Error(`receiving scene ${mode} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Scene
}

async function expectNoBlockingAxe(page: Page) {
  // Next streams the <title> after the first HTML: let it arrive before axe reads the page (a page without one still fails)
  await page.waitForFunction(() => document.title !== '', undefined, { timeout: 5_000 }).catch(() => undefined)
  await settled(page)
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
}

/** The page is never wider than the screen (§9.9: no horizontal scroll on phones) */
async function expectNoHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

/**
 * axe, no sideways scrolling, and two pictures: the whole page with the action bar back in its place (a full-page
 * capture would draw the phone's sticky bar where the first screen ended, over the content) and, on the phone, the
 * first screen as the receiver sees it, with the bar stuck to the bottom. A page that has just refreshed after an
 * action streams its title in after its content: the check waits for it, as a reader would.
 */
async function check(page: Page, testInfo: TestInfo, name: string) {
  await expect(page).toHaveTitle(/\S/)
  await expectNoBlockingAxe(page)
  await expectNoHorizontalScroll(page)
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, style: '.sticky { position: static !important; }' })
  if (testInfo.project.name === 'mobile') await page.screenshot({ path: testInfo.outputPath(`${name}-screen.png`) })
}

async function signIn(page: Page, code: string, withTotp: boolean) {
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

async function asMember(browser: Browser, testInfo: TestInfo, clientIp: string, code: string, withTotp: boolean): Promise<Page> {
  const context = await browser.newContext({ ...testInfo.project.use, baseURL: E2E_BASE_URL, extraHTTPHeaders: { 'x-forwarded-for': clientIp } })
  const page = await context.newPage()
  await signIn(page, code, withTotp)
  return page
}

/** A camera-sized photo made by the browser itself (a real JPEG, so the page can shrink it before upload) */
async function photo(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 3000
    canvas.height = 2000
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#8a6d3b'
    ctx.fillRect(0, 0, 3000, 2000)
    ctx.fillStyle = '#f5f7f8'
    ctx.fillRect(300, 300, 1600, 1000)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.9))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let text = ''
    for (const b of bytes) text += String.fromCharCode(b)
    return btoa(text)
  })
  return Buffer.from(base64, 'base64')
}

/** Presigned addresses of the run's storage (the PUT of an upload, the GET of a photo) */
const PRESIGNED = /X-Amz-Signature=/

/** Presses "เปิดรูป <name>" and returns the short-lived address it led to (answered 204, so the page stays) */
async function openPhoto(page: Page, name: string): Promise<string> {
  let opened = ''
  await page.route(PRESIGNED, async (route) => {
    opened = route.request().url()
    await route.fulfill({ status: 204 })
  })
  await page.getByRole('button', { name: `เปิดรูป ${name}` }).click()
  await expect.poll(() => opened).toMatch(/X-Amz-Expires=\d+/)
  await page.unroute(PRESIGNED)
  return opened
}

/**
 * The widths between a phone and a wide screen, where the form's column is narrow next to what stands beside a button:
 * from 640 px the bar's buttons go side by side, and from 1024 px the aside takes 24rem of the page
 */
const BETWEEN = [640, 768, 1024] as const

/**
 * Each button keeps its words on one line inside its 44 px box — nothing beside it squeezes it (§9.4, §9.9) — at the
 * project's width and, on the desktop project, at each width between, photographed there (the whole page, the bar in
 * its place); the page is never wider than the screen
 */
async function expectButtonsWhole(page: Page, testInfo: TestInfo, buttons: readonly Locator[], name: string) {
  const whole = async (width: number) => {
    for (const button of buttons) {
      await expect(button).toBeVisible()
      const box = await button.evaluate((el) => {
        const words = document.createRange()
        words.selectNodeContents(el)
        const style = getComputedStyle(el)
        const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5
        return {
          label: el.textContent,
          inside: el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth,
          oneLine: words.getBoundingClientRect().height < line * 1.5,
          height: el.getBoundingClientRect().height,
        }
      })
      expect({ width, ...box }).toEqual({ width, label: box.label, inside: true, oneLine: true, height: expect.any(Number) })
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
    await expectNoHorizontalScroll(page)
  }
  await whole(page.viewportSize()!.width)
  if (testInfo.project.name === 'mobile') return
  const wide = page.viewportSize()!
  for (const width of BETWEEN) {
    await page.setViewportSize({ width, height: wide.height })
    await whole(width)
    await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`), fullPage: true, style: '.sticky { position: static !important; }' })
  }
  await page.setViewportSize(wide)
}

/** What the bar says while a photo of the receipt is still being uploaded */
const UPLOAD_WAIT = 'กำลังอัปโหลดรูป รอให้เสร็จก่อนจึงตรวจสอบหรือบันทึกได้ หรือหยุดอัปโหลดที่ช่องรูปถ่ายด้านบน'

const receiverOf = (testInfo: TestInfo): Record<string, string> => (testInfo.project.name === 'mobile' ? { SCENE_RECEIVER: 'receiver_con' } : {})

// Every test first builds its own sent PO through the services in a child process (several seconds) and signs in with
// TOTP before the screens begin: three times the default time
test.beforeEach(() => {
  test.slow()
})

/**
 * /receiving at the page holding the POs sent most recently: the list runs oldest first, a page at a time, so a PO this
 * spec just sent is on the last page — a page past the end shows the last one, and with one page it is the list itself
 */
async function receivingListWithNewest(page: Page) {
  await page.goto('/receiving?page=999')
  await expect(page.getByRole('heading', { level: 1, name: 'ตรวจรับ' })).toBeVisible()
}

test('[FR-P2P-006/AC1] [FR-P2P-006/AC2] @demo scene 8 — on site with a phone the receiver takes 60% of the plywood and all the PPE with a photo — the receipt waits while the photo is uploaded, a stalled upload can be stopped, no photo is chosen during the check; the PO becomes partly received', async ({ page }, testInfo) => {
  const s = scene('demo', testInfo, receiverOf(testInfo))
  await signIn(page, s.receiver!, true)

  // What waits for goods: this PO, with nothing received yet and no amounts (a RECEIVER sees quantities)
  await receivingListWithNewest(page)
  const row = page.getByRole('list', { name: 'ใบสั่งซื้อรอตรวจรับ' }).getByRole('listitem').filter({ hasText: s.number })
  await expect(row).toContainText('ส่งผู้ขายแล้ว')
  await expect(row).toContainText('ค้างรับ 3 จาก 3 รายการ')
  await expect(row).toContainText(`${s.requestNumber} ขอโดย ผู้ขอ ทดสอบตรวจรับ · ฝ่ายก่อสร้าง`)
  await check(page, testInfo, 'receiving-list')

  // "เปิดลิงก์ตรวจรับ": the notification that the PO went to the supplier opens its receiving page
  const bell = page.locator('details:has(> summary[aria-label^="แจ้งเตือน"])').filter({ visible: true })
  await bell.locator('summary').click()
  await bell.getByRole('button', { name: new RegExp(`ใบสั่งซื้อ ${s.number} ส่งถึงผู้ขายแล้ว`) }).first().click()
  await expect(page).toHaveURL(new RegExp(`/receiving/${s.poId}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`ตรวจรับ ${s.number}`)
  await expect(page.getByText('ขั้น 1 จาก 2')).toBeVisible()
  await check(page, testInfo, 'receiving-enter')

  // Nothing typed yet: the form says what it needs
  await page.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' }).click()
  await expect(page.getByText('ใส่จำนวนที่มาส่งอย่างน้อย 1 รายการ')).toBeVisible()

  // 6 of the 10 sheets of plywood, all 10 PPE sets, none of the nails; the delivery note and a photo from the camera
  await page.getByLabel('ไม้อัด 10 มม.: รับรอบนี้ (แผ่น)').fill('6')
  await page.getByLabel('ชุด PPE: รับรอบนี้ (ชุด)').fill('10')
  await page.getByLabel('เลขที่ใบส่งของ').fill('DN-2569-0815')
  const camera = page.getByLabel('ถ่ายหรือเลือกรูป')
  await expect(camera).toHaveAttribute('accept', 'image/*')
  await expect(camera).toHaveAttribute('capture', 'environment')
  // the rule under the camera button says what is taken: pictures only (the server takes nothing else as a photo)
  await expect(page.getByText('แนบได้เฉพาะรูป JPG PNG หรือ HEIC ไม่เกิน 20 MB')).toBeVisible()
  const picture = await photo(page)
  const toReview = page.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' })
  const wait = page.getByText(UPLOAD_WAIT)

  // No signal gets the photo through: the receipt waits for it and the bar says why, above its button; the upload can be
  // stopped. Stopped, nothing is attached and the receipt can go on (an upload also gives up by itself after
  // FILE_UPLOAD_LIMIT_MS: tests/unit/file-upload.test.ts). The same as the LIFF receiving page (tests/e2e/liff-gr.spec.ts)
  let unstall: () => void = () => undefined
  const stalled = new Promise<void>((resolve) => {
    unstall = resolve
  })
  await page.route(PRESIGNED, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    await stalled
    // The page has given up on this request by now
    await route.abort('timedout').catch(() => undefined)
  })
  await camera.setInputFiles({ name: 'no-signal.jpg', mimeType: 'image/jpeg', buffer: picture })
  await expect(page.getByText('กำลังอัปโหลด no-signal.jpg', { exact: true })).toBeVisible()
  await expect(wait).toBeVisible()
  await expect(toReview).toBeDisabled()
  await expect(camera).toBeDisabled()
  const stop = page.getByRole('button', { name: 'หยุดอัปโหลดไฟล์นี้' })
  await expectButtonsWhole(page, testInfo, [toReview, stop], 'receiving-photo-wait')
  await check(page, testInfo, 'receiving-photo-wait')
  await stop.click()
  await expect(page.getByText('หยุดอัปโหลดแล้ว ไฟล์นี้ไม่ได้แนบ ลองใหม่ได้เมื่อสัญญาณดีขึ้น')).toBeVisible()
  await expect(stop).toHaveCount(0)
  await expect(wait).toHaveCount(0)
  await expect(toReview).toBeEnabled()
  await expect(camera).toBeEnabled()
  await expect(page.getByRole('list', { name: 'รูปถ่ายของที่มาส่ง' })).toHaveCount(0)
  unstall()
  await page.unroute(PRESIGNED)

  // A slow site network: the photo's bytes are held on their way to storage. Until the photo is recorded the receipt
  // cannot be checked, and the bar says why — the receipt never leaves without the photo the receiver chose
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  // The PUT goes out only once the browser has prepared the photo and the server has given its address. On the CI runner
  // preparing it took over 5 s once (NEW-91: Chromium encodes a canvas in idle time), so the bytes are let go once they
  // are on their way, not after a guess at how long that takes
  let sending: () => void = () => undefined
  const onTheWay = new Promise<void>((resolve) => {
    sending = resolve
  })
  await page.route(PRESIGNED, async (route) => {
    if (route.request().method() === 'PUT') {
      sending()
      await held
    }
    await route.continue()
  })
  await camera.setInputFiles({ name: 'site-delivery.jpg', mimeType: 'image/jpeg', buffer: picture })
  await expect(page.getByText('กำลังอัปโหลด site-delivery.jpg', { exact: true })).toBeVisible()
  await expect(wait).toBeVisible()
  await expect(toReview).toBeDisabled()
  await onTheWay
  release()
  await expect(page.getByText('รูป site-delivery.jpg', { exact: true })).toBeVisible()
  await page.unroute(PRESIGNED)
  await expect(wait).toHaveCount(0)
  await expect(toReview).toBeEnabled()

  // The check takes its time on the site's network: meanwhile no photo is chosen or taken out, so nothing the receiver
  // does then is lost when step 2 takes the place of step 1
  let releaseCheck: () => void = () => undefined
  const checkHeld = new Promise<void>((resolve) => {
    releaseCheck = resolve
  })
  const PAGE = `**/receiving/${s.poId}`
  await page.route(PAGE, async (route) => {
    const request = route.request()
    // The check is a server action posted to the page, its body the receipt's lines
    if (request.method() === 'POST' && (request.postData() ?? '').includes('"lines"')) await checkHeld
    await route.continue()
  })
  await toReview.click()
  await expect(page.getByRole('button', { name: 'กำลังตรวจสอบ' })).toBeDisabled()
  await expect(camera).toBeDisabled()
  await expect(page.getByRole('button', { name: 'เอารูป site-delivery.jpg ออก' })).toBeDisabled()
  releaseCheck()

  // Before anything is written: what will happen
  await expect(page.getByRole('heading', { name: 'ตรวจสอบก่อนบันทึก' })).toBeVisible()
  // Only now, the held check having gone on: removing the route earlier would let Playwright resume it under the handler
  await page.unroute(PAGE)
  await expect(page.getByText('ขั้น 2 จาก 2')).toBeVisible()
  await expect(page.getByText('หลังบันทึก ใบสั่งซื้อจะเป็น "รับบางส่วน" ยังค้างรับ 2 รายการ')).toBeVisible()
  await expect(page.getByText('มาส่ง 6 แผ่น · รับเข้า 6 แผ่น · ยังค้าง 4 แผ่น')).toBeVisible()
  await expect(page.getByText('มาส่ง 10 ชุด · รับเข้า 10 ชุด · ยังค้าง 0 ชุด')).toBeVisible()
  await expect(page.getByText('ใบส่งของเลขที่ DN-2569-0815')).toBeVisible()
  await expect(page.getByText('รูปถ่าย 1 รูป')).toBeVisible()
  await check(page, testInfo, 'receiving-review')
  // The confirmation and the way back share the bar: side by side where both fit whole, on two rows where they do not
  const confirm = page.getByRole('button', { name: 'ยืนยันบันทึกการตรวจรับ' })
  await expectButtonsWhole(page, testInfo, [confirm, page.getByRole('button', { name: 'กลับไปแก้จำนวน' })], 'receiving-review')
  await confirm.click()

  // Recorded: the confirmation uses the button's words, and the PO is partly received
  await expect(page.getByText(/^บันทึกการตรวจรับแล้ว GR-\d{4}-\d{5}$/)).toBeVisible()
  await expect(page.getByText('ใบสั่งซื้อเป็น "รับบางส่วน"')).toBeVisible()
  await expect(page.getByRole('main').getByText('รับบางส่วน', { exact: true })).toBeVisible()
  const receipts = page.getByRole('list', { name: 'ใบตรวจรับของใบสั่งซื้อนี้' })
  await expect(receipts).toContainText('ใบส่งของเลขที่ DN-2569-0815')
  await expect(receipts).toContainText('ไม้อัด 10 มม. มาส่ง 6 แผ่น รับเข้า 6 แผ่น')
  await expect(receipts).toContainText('ชุด PPE มาส่ง 10 ชุด รับเข้า 10 ชุด')
  expect(await openPhoto(page, 'site-delivery.jpg')).toMatch(/X-Amz-Expires=\d+/)
  await check(page, testInfo, 'receiving-done')

  // The list follows: the PO is partly received, two lines still to come
  await receivingListWithNewest(page)
  const after = page.getByRole('list', { name: 'ใบสั่งซื้อรอตรวจรับ' }).getByRole('listitem').filter({ hasText: s.number })
  await expect(after).toContainText('รับบางส่วน')
  await expect(after).toContainText('ค้างรับ 2 จาก 3 รายการ')
})

test('[FR-P2P-006/AC3] a receiver who approved the request (acting for the DM) is refused in plain words (GC-SOD-02); the requester receives own goods (GC-SOD-05)', async ({ page, browser, clientIp }, testInfo) => {
  const s = scene('sod', testInfo)
  await signIn(page, s.approverReceiver!, true)
  await receivingListWithNewest(page)
  const blocked = page.getByRole('list', { name: 'ใบที่คุณตรวจรับเองไม่ได้' }).getByRole('listitem').filter({ hasText: s.number })
  await expect(blocked).toContainText('ตรวจรับเองไม่ได้ เพราะคุณอนุมัติเอกสารของใบนี้')
  await expect(page.getByRole('list', { name: 'ใบสั่งซื้อรอตรวจรับ' }).getByRole('listitem').filter({ hasText: s.number })).toHaveCount(0)
  await check(page, testInfo, 'receiving-sod-list')

  await blocked.getByRole('link', { name: `ดู ${s.number}` }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`ตรวจรับ ${s.number}`)
  await expect(page.getByText('คุณตรวจรับใบสั่งซื้อนี้เองไม่ได้ เพราะคุณเป็นผู้อนุมัติคำขอซื้อหรือใบสั่งซื้อนี้ (รวมถึงอนุมัติแทนผู้อื่น)')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'รายการในใบสั่งซื้อ' })).toBeVisible()
  await check(page, testInfo, 'receiving-sod')

  // GC-SOD-05: the requester may receive their own goods under the demo DOA
  const own = await asMember(browser, testInfo, clientIp, s.requester!, false)
  await own.goto('/receiving')
  await own.getByRole('link', { name: `ตรวจรับ ${s.number}` }).click()
  await own.getByLabel('ชุด PPE: รับรอบนี้ (ชุด)').fill('2')
  await own.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' }).click()
  await expect(own.getByText('หลังบันทึก ใบสั่งซื้อจะเป็น "รับครบแล้ว"')).toBeVisible()
  await own.getByRole('button', { name: 'ยืนยันบันทึกการตรวจรับ' }).click()
  await expect(own.getByText('ใบสั่งซื้อเป็น "รับครบแล้ว"')).toBeVisible()
  await expect(own.getByText('รับของครบทุกรายการแล้ว ไม่มีอะไรต้องตรวจรับเพิ่ม')).toBeVisible()
  await check(own, testInfo, 'receiving-requester-done')
  await own.context().close()
})

test('[FR-P2P-007/AC1] [FR-P2P-007/AC2] more than ordered: the review names the GR_VARIANCE approver before posting, and keeping the excess waits for approval', async ({ page }, testInfo) => {
  const s = scene('variance', testInfo, receiverOf(testInfo))
  await signIn(page, s.receiver!, true)
  await page.goto(`/receiving/${s.poId}`)
  await page.getByLabel('ปูนซีเมนต์ 50 กก.: รับรอบนี้ (ถุง)').fill('12')
  await page.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' }).click()

  const excess = page.getByRole('group', { name: 'ส่วนเกิน 2 ถุง เกินเกณฑ์ที่รับเกินได้ (0%) จะทำอย่างไร' })
  await expect(excess).toBeVisible()
  await expect(excess).toContainText('ผู้อนุมัติ ดำรง ก่อสร้างไทย ผู้จัดการฝ่าย ฝ่ายก่อสร้าง ตาม DOA ข้อ GRV-01')
  await expect(page.getByText('หลังบันทึก ใบสั่งซื้อจะเป็น "รับครบแล้ว"')).toBeVisible()
  await check(page, testInfo, 'receiving-variance-review')

  // The choice is the receiver's: nothing is posted until it is made
  await page.getByRole('button', { name: 'ยืนยันบันทึกการตรวจรับ' }).click()
  await expect(excess.getByText('เลือกว่าจะทำอย่างไรก่อนบันทึก')).toBeVisible()
  await excess.getByRole('radio', { name: /ขอเก็บส่วนเกินไว้ ต้องรออนุมัติ/ }).check()
  await page.getByRole('button', { name: 'ยืนยันบันทึกการตรวจรับ' }).click()
  await expect(page.getByText(/^บันทึกการตรวจรับแล้ว GR-\d{4}-\d{5}$/)).toBeVisible()
  await expect(page.getByText('มี 1 รายการรออนุมัติ ผู้อนุมัติได้รับแจ้งแล้ว')).toBeVisible()
  const receipts = page.getByRole('list', { name: 'ใบตรวจรับของใบสั่งซื้อนี้' })
  await expect(receipts).toContainText('รับเกิน: ปูนซีเมนต์ 50 กก. 2 ถุง · ขอเก็บส่วนเกินไว้ · รออนุมัติ')
  await check(page, testInfo, 'receiving-variance-done')
})

test('[FR-P2P-010/AC2] PROCUREMENT asks to close a partly received PO short: what goes back, who approves, a reason and a tick', async ({ page }, testInfo) => {
  const s = scene('closeShort', testInfo)
  await signIn(page, testInfo.project.name === 'mobile' ? 'dm_proc' : 'proc_officer', true)
  await page.goto(`/receiving/${s.poId}`)
  await expect(page.getByText('คุณดูใบสั่งซื้อนี้ได้ แต่การบันทึกตรวจรับเป็นงานของผู้ตรวจรับของฝ่ายที่ขอ')).toBeVisible()
  await expect(page.getByRole('list', { name: 'ใบตรวจรับของใบสั่งซื้อนี้' })).toContainText(s.grNumber!)

  await page.getByText('ปิดใบสั่งซื้อทั้งที่รับไม่ครบ', { exact: true }).click()
  await expect(page.getByText('ปูนซีเมนต์ 50 กก. 4 ถุง')).toBeVisible()
  await expect(page.getByText('600.00 บาท')).toBeVisible()
  await expect(page.getByText('ผู้อนุมัติ ดำรง ก่อสร้างไทย ผู้จัดการฝ่าย ฝ่ายก่อสร้าง ตาม DOA ข้อ GRV-01')).toBeVisible()
  await page.getByRole('button', { name: 'ส่งขอปิดใบสั่งซื้อ' }).click()
  await expect(page.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')).toBeVisible()
  await expect(page.getByText('ติ๊กยืนยันก่อน เพราะย้อนกลับไม่ได้')).toBeVisible()
  await check(page, testInfo, 'receiving-close-short')

  await page.getByLabel('เหตุผลที่ปิดทั้งที่รับไม่ครบ').fill('ผู้ขายแจ้งว่าปูนรุ่นนี้หมด ไม่มีส่งเพิ่ม')
  await page.getByLabel('เข้าใจว่าเมื่ออนุมัติแล้ว จะรับของที่ค้างตามใบสั่งซื้อนี้ไม่ได้อีก').check()
  await page.getByRole('button', { name: 'ส่งขอปิดใบสั่งซื้อ' }).click()
  await expect(page.getByText('ส่งขอปิดใบสั่งซื้อแล้ว รออนุมัติ 1 รายการ')).toBeVisible()
  await expect(page.getByText('มีคำขอปิดใบสั่งซื้อนี้ทั้งที่รับไม่ครบ และรออนุมัติอยู่ ผู้อนุมัติได้รับแจ้งแล้ว')).toBeVisible()
  const requests = page.getByRole('main').getByRole('listitem').filter({ hasText: 'รับไม่ครบ: ปูนซีเมนต์ 50 กก. 4 ถุง · ปิดใบสั่งซื้อทั้งที่รับไม่ครบ · รออนุมัติ' })
  await expect(requests).toContainText('มูลค่า')
  await expect(requests).toContainText('600.00 บาท')
  // Asking is not closing (FR-P2P-010 AC2): the PO stays partly received until the approver decides
  await expect(page.getByRole('main').getByText('รับบางส่วน', { exact: true })).toBeVisible()
  await check(page, testInfo, 'receiving-close-short-done')
})
