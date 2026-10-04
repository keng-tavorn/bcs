import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Page, TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { anotherPhone, BUDGET_DOCUMENT_LINES, checkScreen, expectFirstLoadsWithinBudget, liffBudgetScene, newLineUserId, openAsLineUser, sceneTag } from './liff-support'

// S5-06 · /liff/gr/[poId], receiving with the camera in the LINE app (§9.4, FR-LINE-003 AC3, FR-P2P-006, demo scene 8),
// at 375 px in the mobile project (liff-* specs run on the phone only), every screen also checked at 1440 px
// (checkScreen). LIFF_MOCK stands in for the LINE app: the mock cookie names the LINE user, the fake LINE server of the
// run issues the ID token, and everything after it — the LIFF session, the receive command, the presigned upload to
// the run's storage — is the real path. Each test makes its own sent PO and fresh people through the services
// (tests/e2e/receiving-scene.ts), links them to LINE accounts of their own (tests/e2e/liff-gr-scene.ts), and never
// touches another spec's records.

type ReceivingScene = { poId: string; number: string; requestNumber: string; receiver?: string; approverReceiver?: string; requester?: string }
type RecordedReceipt = {
  poStatus: string
  receipt: {
    number: string
    channel: string | null
    photos: Array<{ fileName: string; mimeType: string; sizeBytes: number; kind: string | null }>
    variances: Array<{
      type: string
      disposition: string
      status: string
      quantity: string
      route: { ruleCode: string; documentType: string | null; tasks: Array<{ status: string; approver: string | null }> } | null
    }>
  } | null
}

/**
 * A sent PO of a fresh requester of the construction department, and a fresh RECEIVER (or the separation-of-duties
 * case; or 10 bags of cement, for receiving more than ordered)
 */
function receivingScene(mode: 'demo' | 'sod' | 'variance'): ReceivingScene {
  const run = `l${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
  const r = spawnSync('pnpm exec tsx tests/e2e/receiving-scene.ts', { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), SCENE_MODE: mode, SCENE_RUN: run } })
  if (r.status !== 0) throw new Error(`receiving scene ${mode} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as ReceivingScene
}

/** Runs tests/e2e/liff-gr-scene.ts against the e2e database (link codes stay inside it: only its errors are shown) */
function liffGrScene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/liff-gr-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`LIFF receiving scene ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** A camera-sized photo made by the browser itself: a real JPEG of 3000 × 2000 px */
async function cameraPhoto(page: Page): Promise<Buffer> {
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

/**
 * The photo as a phone camera writes it: an EXIF block (APP1) right after the start of the JPEG, with a GPS directory
 * holding the latitude reference — a minimal but valid TIFF structure, enough to tell whether the metadata survives
 */
function withGpsExif(jpeg: Buffer): Buffer {
  const tiff = Buffer.alloc(44)
  tiff.write('II', 0, 'latin1')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  // IFD0: one entry, GPSInfo (0x8825, LONG) pointing at the GPS directory at offset 26
  tiff.writeUInt16LE(1, 8)
  tiff.writeUInt16LE(0x8825, 10)
  tiff.writeUInt16LE(4, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt32LE(26, 18)
  tiff.writeUInt32LE(0, 22)
  // GPS directory: GPSLatitudeRef (0x0001, ASCII, 2) = "N"
  tiff.writeUInt16LE(1, 26)
  tiff.writeUInt16LE(0x0001, 28)
  tiff.writeUInt16LE(2, 30)
  tiff.writeUInt32LE(2, 32)
  tiff.write('N\0', 36, 'latin1')
  tiff.writeUInt32LE(0, 40)
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const header = Buffer.alloc(4)
  header.writeUInt16BE(0xffe1, 0)
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)])
}

/** The size of a JPEG and whether it carries an EXIF block, read from its markers */
function jpegInfo(bytes: Buffer): { width: number; height: number; exif: boolean } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG')
  let exif = false
  for (let i = 2; i + 4 <= bytes.length; ) {
    if (bytes[i] !== 0xff) throw new Error(`no marker at ${i}`)
    const marker = bytes[i + 1]!
    const length = bytes.readUInt16BE(i + 2)
    if (marker === 0xe1 && bytes.toString('latin1', i + 4, i + 10) === 'Exif\0\0') exif = true
    // SOF0 to SOF3: precision, height, width
    if (marker >= 0xc0 && marker <= 0xc3) return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5), exif }
    i += 2 + length
  }
  throw new Error('no frame header')
}

/** Presigned addresses of the run's storage (the PUT of an upload, the GET of a photo) */
const PRESIGNED = /X-Amz-Signature=/

/**
 * Taps "เปิดรูป <name>": the photo opens in the page, right under its button, through a short-lived address — returned
 * here, so the test can read the stored file
 */
async function openPhoto(page: Page, name: string): Promise<string> {
  let opened = ''
  await page.route(PRESIGNED, async (route) => {
    if (route.request().method() === 'GET') opened ||= route.request().url()
    await route.continue()
  })
  await page.getByRole('button', { name: `เปิดรูป ${name}` }).click()
  await expect(page.getByRole('img', { name: `รูป ${name}` })).toBeVisible()
  await page.unroute(PRESIGNED)
  expect(opened).toMatch(/X-Amz-Expires=\d+/)
  return opened
}

/**
 * The first screen as the receiver sees it, the bar stuck to the bottom (checkScreen's full-page pictures draw a sticky
 * bar where the first screen ended)
 */
async function firstScreen(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath(`${name}-screen.png`) })
}

/** The bar of a LIFF page sits at the bottom of the screen (§9.4 "แถบปุ่มตัดสินติดล่างจอ") */
async function expectAtBottom(page: Page, name: string) {
  const box = (await page.getByRole('region', { name }).boundingBox())!
  expect(box.y + box.height).toBeGreaterThan(page.viewportSize()!.height - 2)
}

// Every test first builds its sent PO through the services in a child process (several seconds): three times the time
test.beforeEach(() => {
  test.slow()
})

test('[FR-LINE-003/AC1] [FR-LINE-003/AC3] [FR-P2P-006/AC1] [FR-P2P-006/AC2] demo scene 8 in LINE: the receiver opens the receiving link, takes 60% of the plywood and all the PPE with a photo from the camera — the receipt waits while the photo is sent, a stalled photo can be stopped, no photo is taken during the check; the photo is attached to the GR and the PO is partly received', async ({ page, context }, testInfo) => {
  const s = receivingScene('demo')
  const lineUserId = newLineUserId()
  liffGrScene('link', s.receiver!, lineUserId)
  await openAsLineUser(context, lineUserId)

  // The receiving link of LINE (https://liff.line.me/<LIFF ID>/gr/<poId>) arrives as /liff?liff.state=/gr/<poId>: the
  // gate signs the receiver in with LINE and the page opens
  await page.goto(`/liff?liff.state=${encodeURIComponent(`/gr/${s.poId}`)}`)
  await expect(page).toHaveURL(new RegExp(`/liff/gr/${s.poId}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`ตรวจรับ ${s.number}`)
  const main = page.getByRole('main')
  await expect(main.getByText('ส่งให้ผู้ขายแล้ว รอของ', { exact: true })).toBeVisible()
  await expect(main).toContainText(`${s.requestNumber} ขอโดย ผู้ขอ ทดสอบตรวจรับ · ฝ่ายก่อสร้าง`)
  await expect(page.getByText('ขั้น 1 จาก 2')).toBeVisible()
  // 16 px text (§9.4); the bar with the step's button at the bottom of the screen
  expect(await main.locator('p').first().evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
  await expectAtBottom(page, 'บันทึกการตรวจรับ')
  await checkScreen(page, testInfo, 'liff-gr-enter')
  await firstScreen(page, testInfo, 'liff-gr-enter')

  // Nothing typed yet: the bar says what is needed
  const bar = page.getByRole('region', { name: 'บันทึกการตรวจรับ' })
  const toReview = page.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' })
  await toReview.click()
  await expect(bar.getByText('ใส่จำนวนที่มาส่งอย่างน้อย 1 รายการ')).toBeVisible()

  // 6 of the 10 sheets of plywood, all 10 PPE sets, none of the nails; the delivery note; a photo from the camera
  await page.getByLabel('ไม้อัด 10 มม.: รับรอบนี้ (แผ่น)').fill('6')
  await page.getByLabel('ชุด PPE: รับรอบนี้ (ชุด)').fill('10')
  await page.getByLabel('เลขที่ใบส่งของ').fill('DN-2569-0815')
  const camera = page.getByLabel('ถ่ายรูป', { exact: true })
  await expect(camera).toHaveAttribute('type', 'file')
  await expect(camera).toHaveAttribute('accept', 'image/*')
  await expect(camera).toHaveAttribute('capture', 'environment')
  const original = withGpsExif(await cameraPhoto(page))
  expect(jpegInfo(original)).toEqual({ width: 3000, height: 2000, exif: true })

  // No signal gets the photo through: the receipt waits for it, and the bar offers to stop it. Stopped, nothing is
  // attached and the receipt can go on (a send also gives up by itself after LIFF_PHOTO_SEND_LIMIT_MS:
  // tests/unit/liff-photo-upload.test.ts)
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
  await camera.setInputFiles({ name: 'no-signal.jpg', mimeType: 'image/jpeg', buffer: original })
  await expect(page.getByText('กำลังส่งรูป no-signal.jpg', { exact: true })).toBeVisible()
  const stop = bar.getByRole('button', { name: 'หยุดส่งรูปนี้' })
  await expect(stop).toBeVisible()
  await expect(toReview).toBeDisabled()
  await checkScreen(page, testInfo, 'liff-gr-photo-stop')
  await firstScreen(page, testInfo, 'liff-gr-photo-stop')
  await stop.click()
  await expect(page.getByText('หยุดส่งรูปแล้ว รูปนี้ไม่ได้แนบ ถ่ายใหม่ได้เมื่อสัญญาณดีขึ้น')).toBeVisible()
  await expect(stop).toHaveCount(0)
  await expect(bar.getByText('กำลังส่งรูป รอให้เสร็จก่อนจึงตรวจสอบหรือบันทึกได้')).toHaveCount(0)
  await expect(toReview).toBeEnabled()
  await expect(camera).toBeEnabled()
  await expect(page.getByRole('list', { name: 'รูปถ่ายของที่มาส่ง' })).toHaveCount(0)
  unstall()
  await page.unroute(PRESIGNED)

  // A slow site network: the photo's bytes are held on their way to storage. Until it is recorded the receipt cannot be
  // checked (nor posted), and the bar says why — the receipt never leaves without the photo
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(PRESIGNED, async (route) => {
    if (route.request().method() === 'PUT') await held
    await route.continue()
  })
  await camera.setInputFiles({ name: 'site-delivery.jpg', mimeType: 'image/jpeg', buffer: original })
  await expect(page.getByText('กำลังส่งรูป site-delivery.jpg', { exact: true })).toBeVisible()
  await expect(bar.getByText('กำลังส่งรูป รอให้เสร็จก่อนจึงตรวจสอบหรือบันทึกได้')).toBeVisible()
  await expect(toReview).toBeDisabled()
  await expect(page.getByLabel('ถ่ายรูป', { exact: true })).toBeDisabled()
  await firstScreen(page, testInfo, 'liff-gr-photo-sending')
  release()
  await expect(page.getByText('รูป site-delivery.jpg', { exact: true })).toBeVisible()
  await page.unroute(PRESIGNED)
  await expect(bar.getByText('กำลังส่งรูป รอให้เสร็จก่อนจึงตรวจสอบหรือบันทึกได้')).toHaveCount(0)
  await expect(toReview).toBeEnabled()
  await expect(page.getByLabel('ถ่ายรูปเพิ่ม', { exact: true })).toHaveAttribute('capture', 'environment')
  await checkScreen(page, testInfo, 'liff-gr-photo')

  // The check takes its time on the site's network: meanwhile no photo is taken or taken out, so nothing the receiver
  // does then is lost when step 2 takes the place of step 1
  let releaseCheck: () => void = () => undefined
  const checkHeld = new Promise<void>((resolve) => {
    releaseCheck = resolve
  })
  const PAGE = `**/liff/gr/${s.poId}`
  await page.route(PAGE, async (route) => {
    const request = route.request()
    // The check is a server action posted to the page, its body the receipt's lines
    if (request.method() === 'POST' && (request.postData() ?? '').includes('"lines"')) await checkHeld
    await route.continue()
  })
  await toReview.click()
  await expect(bar.getByRole('button', { name: 'กำลังตรวจสอบ' })).toBeDisabled()
  await expect(page.getByLabel('ถ่ายรูปเพิ่ม', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'เอารูป site-delivery.jpg ออก' })).toBeDisabled()
  releaseCheck()

  // Before anything is written: what will happen, and the confirmation in the bar
  await expect(page.getByRole('heading', { level: 2, name: 'ตรวจสอบก่อนบันทึก' })).toBeVisible()
  // Only now, the held check having gone on: removing the route earlier would let Playwright resume it under the handler
  await page.unroute(PAGE)
  await expect(page.getByText('ขั้น 2 จาก 2')).toBeVisible()
  await expect(page.getByText('หลังบันทึก ใบสั่งซื้อจะเป็น "รับบางส่วน" ยังค้างรับ 2 รายการ')).toBeVisible()
  await expect(page.getByText('มาส่ง 6 แผ่น · รับเข้า 6 แผ่น · ยังค้าง 4 แผ่น')).toBeVisible()
  await expect(page.getByText('มาส่ง 10 ชุด · รับเข้า 10 ชุด · ยังค้าง 0 ชุด')).toBeVisible()
  await expect(page.getByText('ใบส่งของเลขที่ DN-2569-0815')).toBeVisible()
  await expect(page.getByText('รูปถ่าย 1 รูป')).toBeVisible()
  await expectAtBottom(page, 'บันทึกการตรวจรับ')
  await checkScreen(page, testInfo, 'liff-gr-review')
  await firstScreen(page, testInfo, 'liff-gr-review')
  // Going back keeps the photo with its small picture — made from the file in the phone, and still there to draw — and
  // the check comes again
  await page.getByRole('button', { name: 'กลับไปแก้จำนวน' }).click()
  await expect(page.getByText('รูป site-delivery.jpg', { exact: true })).toBeVisible()
  const thumbnail = page.getByRole('list', { name: 'รูปถ่ายของที่มาส่ง' }).locator('span[aria-hidden="true"]').first()
  const drawable = await thumbnail.evaluate(async (el) => {
    const url = /^url\("(blob:[^"]+)"\)$/.exec(getComputedStyle(el).backgroundImage)?.[1]
    return url ? fetch(url).then((r) => r.ok, () => false) : false
  })
  expect(drawable).toBe(true)
  await toReview.click()
  await page.getByRole('button', { name: 'ยืนยันบันทึกการตรวจรับ' }).click()

  // Recorded: the confirmation uses the button's words, and the PO is partly received
  await expect(page.getByText(/^บันทึกการตรวจรับแล้ว GR-\d{4}-\d{5}$/)).toBeVisible()
  await expect(page.getByText('ใบสั่งซื้อเป็น "รับบางส่วน"')).toBeVisible()
  await expect(main.getByText('รับบางส่วน', { exact: true })).toBeVisible()
  const receipts = page.getByRole('list', { name: 'ใบตรวจรับของใบสั่งซื้อนี้' })
  await expect(receipts).toContainText('ใบส่งของเลขที่ DN-2569-0815')
  await expect(receipts).toContainText('ไม้อัด 10 มม. มาส่ง 6 แผ่น รับเข้า 6 แผ่น')
  await expect(receipts).toContainText('ชุด PPE มาส่ง 10 ชุด รับเข้า 10 ชุด')
  await checkScreen(page, testInfo, 'liff-gr-done')
  await firstScreen(page, testInfo, 'liff-gr-done')

  // The photo is attached to the GR: it opens in the page through a short-lived address, and what is stored is the photo
  // as the phone prepared it — at most 2,000 px on its longest side, without the camera's EXIF block and its GPS position
  const url = await openPhoto(page, 'site-delivery.jpg')
  await expect(page.getByRole('button', { name: 'ซ่อนรูป site-delivery.jpg' })).toHaveAttribute('aria-expanded', 'true')
  await checkScreen(page, testInfo, 'liff-gr-photo-open')
  await page.getByRole('img', { name: 'รูป site-delivery.jpg' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('liff-gr-photo-open-screen.png') })
  const stored = Buffer.from(await (await page.request.get(url)).body())
  expect(jpegInfo(stored)).toEqual({ width: 2000, height: 1333, exif: false })
  const recorded = liffGrScene<RecordedReceipt>('receipt', s.poId)
  expect(recorded.poStatus).toBe('PARTIALLY_RECEIVED')
  expect(recorded.receipt).toMatchObject({ channel: 'LIFF', photos: [{ fileName: 'site-delivery.jpg', mimeType: 'image/jpeg', kind: 'PHOTO', sizeBytes: stored.length }], variances: [] })
  await expect(page.getByText(recorded.receipt!.number, { exact: true })).toBeVisible()
  // Still on the receiving page: the next delivery can be recorded at once
  await expect(page).toHaveURL(new RegExp(`/liff/gr/${s.poId}$`))
  await page.getByRole('button', { name: 'ซ่อนรูป site-delivery.jpg' }).click()
  await expect(page.getByRole('img', { name: 'รูป site-delivery.jpg' })).toHaveCount(0)
})

test('[FR-P2P-006/AC1] [FR-LINE-003/AC3] in LINE, damaged goods need a photo first (BR-GR-05) and the receiver’s choice (BR-GR-03): 1 of 10 sheets refused as damaged goes back for a replacement, recorded with both photos — a dropped signal before step 2 loses nothing', async ({ page, context }, testInfo) => {
  const s = receivingScene('demo')
  const lineUserId = newLineUserId()
  liffGrScene('link', s.receiver!, lineUserId)
  await openAsLineUser(context, lineUserId)
  await page.goto(`/liff/gr/${s.poId}`)
  const bar = page.getByRole('region', { name: 'บันทึกการตรวจรับ' })
  const toReview = page.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' })
  await expect(toReview).toBeVisible()

  // The signal drops on site: step 2's part — loaded only when needed, first while the receiver types — cannot be
  // fetched (its script file is cut off, whichever it is: the one holding step 2's words)
  let offline = true
  const reviewChunks = new Set<string>()
  const CHUNKS = /\/_next\/static\/chunks\/[^/?]+\.js/
  await page.route(CHUNKS, async (route) => {
    const url = route.request().url()
    if (offline && !reviewChunks.has(url) && (await (await route.fetch()).text()).includes('"choiceAmountLabel"')) reviewChunks.add(url)
    if (offline && reviewChunks.has(url)) return route.abort('internetdisconnected')
    return route.continue()
  })

  // All 10 sheets came; 1 is refused because it is damaged
  await page.getByLabel('ไม้อัด 10 มม.: รับรอบนี้ (แผ่น)').fill('10')
  await page.getByRole('button', { name: 'มีของที่ไม่รับใน ไม้อัด 10 มม.' }).click()
  await page.getByLabel('ไม้อัด 10 มม.: จำนวนที่ไม่รับ (แผ่น)').fill('1')
  await expect(page.getByRole('radio', { name: 'ของเสียหาย (ต้องถ่ายรูป)' })).toBeChecked()
  await page.getByLabel('ไม้อัด 10 มม.: หมายเหตุของรายการนี้').fill('แผ่นบนสุดแตกที่มุม')

  // No photo yet: the rule is said at the camera, which gets the focus, and the bar says where to look
  await toReview.click()
  const camera = page.getByLabel('ถ่ายรูป', { exact: true })
  await expect(page.getByText('ถ่ายรูปของที่เสียหายอย่างน้อย 1 รูปก่อน')).toBeVisible()
  await expect(bar.getByText('ยังไปต่อไม่ได้ แก้ช่องที่มีข้อความแจ้งด้านบนก่อน')).toBeVisible()
  await expect(camera).toBeFocused()
  await expect(camera).toHaveAttribute('aria-invalid', 'true')
  await checkScreen(page, testInfo, 'liff-gr-damaged-photo-needed')

  // Two captures named as an iPhone names them: the second gets a name of its own
  await camera.setInputFiles({ name: 'image.jpg', mimeType: 'image/jpeg', buffer: await cameraPhoto(page) })
  await expect(page.getByText('รูป image.jpg', { exact: true })).toBeVisible()
  await expect(page.getByText('ถ่ายรูปของที่เสียหายอย่างน้อย 1 รูปก่อน')).toHaveCount(0)
  await page.getByLabel('ถ่ายรูปเพิ่ม', { exact: true }).setInputFiles({ name: 'image.jpg', mimeType: 'image/jpeg', buffer: await cameraPhoto(page) })
  await expect(page.getByText('รูป image-2.jpg', { exact: true })).toBeVisible()
  await toReview.click()

  // Step 2 cannot be shown without a signal: the page says so instead of failing, nothing can be posted unseen, and
  // trying again once the signal is back opens it with everything that was entered
  await expect(page.getByRole('heading', { level: 2, name: 'ตรวจสอบก่อนบันทึก' })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'เปิดขั้นตรวจสอบไม่ได้ เพราะการเชื่อมต่อขัดข้อง' })).toBeVisible()
  expect(reviewChunks.size).toBe(1)
  await expect(page.getByRole('button', { name: 'ยืนยันบันทึกการตรวจรับ' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'กลับไปแก้จำนวน' })).toBeEnabled()
  await checkScreen(page, testInfo, 'liff-gr-review-offline')
  offline = false
  await page.getByRole('button', { name: 'ลองเปิดขั้นตรวจสอบอีกครั้ง' }).click()

  // Step 2: what happens to the damaged sheet is the receiver's choice, asked before anything is written
  await expect(page.getByText('มาส่ง 10 แผ่น · รับเข้า 9 แผ่น · ยังค้าง 1 แผ่น')).toBeVisible()
  await expect(page.getByText('รูปถ่าย 2 รูป')).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'เปิดขั้นตรวจสอบไม่ได้' })).toHaveCount(0)
  await page.unroute(CHUNKS)
  const choice = page.getByRole('group', { name: 'ของเสียหาย 1 แผ่น จะทำอย่างไร' })
  const replace = choice.getByRole('radio', { name: 'ให้ผู้ขายเปลี่ยนให้ ไม่ต้องอนุมัติ' })
  // Keeping them is offered with the approver the DOA's GR_VARIANCE rule names, before anything is posted
  await expect(choice).toContainText('ผู้อนุมัติ ดำรง ก่อสร้างไทย ผู้จัดการฝ่าย ฝ่ายก่อสร้าง ตาม DOA ข้อ GRV-01')
  await page.getByRole('button', { name: 'ยืนยันบันทึกการตรวจรับ' }).click()
  await expect(choice.getByText('เลือกว่าจะทำอย่างไรก่อนบันทึก')).toBeVisible()
  // The focus lands on the first option, read with why it moved there
  await expect(replace).toBeFocused()
  await expect(replace).toHaveAccessibleDescription('เลือกว่าจะทำอย่างไรก่อนบันทึก')
  await replace.check()
  await expect(choice.getByText('เลือกว่าจะทำอย่างไรก่อนบันทึก')).toHaveCount(0)
  await checkScreen(page, testInfo, 'liff-gr-damaged-review')
  await page.getByRole('button', { name: 'ยืนยันบันทึกการตรวจรับ' }).click()

  // Recorded: the damaged sheet is a variance that needs no approval; the supplier replaces it, so the PO still waits
  await expect(page.getByText(/^บันทึกการตรวจรับแล้ว GR-\d{4}-\d{5}$/)).toBeVisible()
  await expect(page.getByText('ใบสั่งซื้อเป็น "รับบางส่วน"')).toBeVisible()
  const receipts = page.getByRole('list', { name: 'ใบตรวจรับของใบสั่งซื้อนี้' })
  await expect(receipts).toContainText('ของเสียหาย: ไม้อัด 10 มม. 1 แผ่น · ให้ผู้ขายเปลี่ยนให้ · บันทึกแล้ว ไม่ต้องอนุมัติ')
  await expect(receipts.getByRole('button', { name: 'เปิดรูป image.jpg', exact: true })).toBeVisible()
  await expect(receipts.getByRole('button', { name: 'เปิดรูป image-2.jpg', exact: true })).toBeVisible()
  await checkScreen(page, testInfo, 'liff-gr-damaged-done')
  const recorded = liffGrScene<RecordedReceipt>('receipt', s.poId)
  expect(recorded).toMatchObject({ poStatus: 'PARTIALLY_RECEIVED', receipt: { channel: 'LIFF', variances: [{ type: 'DAMAGED', disposition: 'RETURN_REPLACE', status: 'RECORDED', quantity: '1' }] } })
  expect(recorded.receipt!.photos.map((p) => p.fileName).sort()).toEqual(['image-2.jpg', 'image.jpg'])
})

test('[FR-P2P-007/AC2] in LINE, keeping goods beyond the order names the approver of the DOA’s GR_VARIANCE rule before posting, then waits for that approver: the variance is pending with its task', async ({ page, context }, testInfo) => {
  const s = receivingScene('variance')
  const lineUserId = newLineUserId()
  liffGrScene('link', s.receiver!, lineUserId)
  await openAsLineUser(context, lineUserId)
  await page.goto(`/liff/gr/${s.poId}`)

  // 12 bags came against the 10 ordered, beyond the demo's tolerance of 0%
  await page.getByLabel('ปูนซีเมนต์ 50 กก.: รับรอบนี้ (ถุง)').fill('12')
  await page.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' }).click()
  const excess = page.getByRole('group', { name: 'ส่วนเกิน 2 ถุง เกินเกณฑ์ที่รับเกินได้ (0%) จะทำอย่างไร' })
  await expect(excess).toContainText('ผู้อนุมัติ ดำรง ก่อสร้างไทย ผู้จัดการฝ่าย ฝ่ายก่อสร้าง ตาม DOA ข้อ GRV-01')
  await expect(page.getByText('หลังบันทึก ใบสั่งซื้อจะเป็น "รับครบแล้ว"')).toBeVisible()
  await excess.getByRole('radio', { name: /^ขอเก็บส่วนเกินไว้ ต้องรออนุมัติ/ }).check()
  await checkScreen(page, testInfo, 'liff-gr-excess-review')
  await page.getByRole('button', { name: 'ยืนยันบันทึกการตรวจรับ' }).click()

  // Recorded; the excess waits for its approver, who was told
  await expect(page.getByText(/^บันทึกการตรวจรับแล้ว GR-\d{4}-\d{5}$/)).toBeVisible()
  await expect(page.getByText('มี 1 รายการรออนุมัติ ผู้อนุมัติได้รับแจ้งแล้ว')).toBeVisible()
  await expect(page.getByRole('list', { name: 'ใบตรวจรับของใบสั่งซื้อนี้' })).toContainText('รับเกิน: ปูนซีเมนต์ 50 กก. 2 ถุง · ขอเก็บส่วนเกินไว้ · รออนุมัติ')
  await checkScreen(page, testInfo, 'liff-gr-excess-done')
  // Posted on channel LIFF; the variance's route is the DOA's GR_VARIANCE rule GRV-01, its open task the DM of construction's
  const recorded = liffGrScene<RecordedReceipt>('receipt', s.poId)
  expect(recorded).toMatchObject({
    receipt: {
      channel: 'LIFF',
      variances: [{ type: 'OVER', disposition: 'ACCEPT_EXCESS', status: 'PENDING_APPROVAL', quantity: '2', route: { ruleCode: 'GRV-01', documentType: 'GR_VARIANCE', tasks: [{ status: 'OPEN', approver: 'dm_con' }] } }],
    },
  })
})

test('[FR-P2P-006/AC3] in LINE, separation of duties is said in plain words with no receiving form (GC-SOD-02); someone with no part in the PO is refused; the requester receives their own goods (GC-SOD-05)', async ({ page, context, browser }, testInfo) => {
  const s = receivingScene('sod')
  const approverLine = newLineUserId()
  liffGrScene('link', s.approverReceiver!, approverLine)
  await openAsLineUser(context, approverLine)
  await page.goto(`/liff/gr/${s.poId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`ตรวจรับ ${s.number}`)
  await expect(page.getByText('คุณตรวจรับใบสั่งซื้อนี้เองไม่ได้ เพราะคุณเป็นผู้อนุมัติคำขอซื้อหรือใบสั่งซื้อนี้ (รวมถึงอนุมัติแทนผู้อื่น)', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' })).toHaveCount(0)
  await expect(page.getByLabel('ถ่ายรูป', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 2, name: 'รายการในใบสั่งซื้อ' })).toBeVisible()
  await checkScreen(page, testInfo, 'liff-gr-sod')

  // A receiving link to a PO that is not there says so inside the LIFF frame, and where to look instead
  await page.goto(`/liff/gr/${randomUUID()}`)
  await expect(page.getByRole('alert').filter({ hasText: 'ไม่พบใบสั่งซื้อนี้' })).toContainText('ดูใบสั่งซื้อที่รอตรวจรับได้บนเว็บ BCS ที่เมนู ตรวจรับ')
  await checkScreen(page, testInfo, 'liff-gr-not-found')

  // Someone with no part in the PO — not its receiver, requester or approver — learns it is not theirs, and sees nothing of it
  const { code: outsiderCode } = liffGrScene<{ code: string }>('outsider', sceneTag('out'))
  const outsiderLine = newLineUserId()
  liffGrScene('link', outsiderCode, outsiderLine)
  const stranger = await anotherPhone(browser)
  await openAsLineUser(stranger, outsiderLine)
  const theirs = await stranger.newPage()
  await theirs.goto(`/liff/gr/${s.poId}`)
  await expect(theirs.getByRole('alert').filter({ hasText: 'หน้านี้ไม่ใช่ของคุณ' })).toBeVisible()
  await expect(theirs.getByRole('heading', { level: 1 })).toHaveText('ตรวจรับ')
  await expect(theirs.getByText(s.number)).toHaveCount(0)
  await expect(theirs.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' })).toHaveCount(0)
  await checkScreen(theirs, testInfo, 'liff-gr-forbidden')
  await stranger.close()

  // GC-SOD-05: under the demo DOA the requester receives their own goods, from their own phone
  const requesterLine = newLineUserId()
  liffGrScene('link', s.requester!, requesterLine)
  const phone = await anotherPhone(browser)
  await openAsLineUser(phone, requesterLine)
  const own = await phone.newPage()
  await own.goto(`/liff/gr/${s.poId}`)
  await own.getByLabel('ชุด PPE: รับรอบนี้ (ชุด)').fill('2')
  await own.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' }).click()
  await expect(own.getByText('หลังบันทึก ใบสั่งซื้อจะเป็น "รับครบแล้ว"')).toBeVisible()
  await own.getByRole('button', { name: 'ยืนยันบันทึกการตรวจรับ' }).click()
  await expect(own.getByText('ใบสั่งซื้อเป็น "รับครบแล้ว"')).toBeVisible()
  await expect(own.getByRole('main').getByText('รับครบแล้ว', { exact: true })).toBeVisible()
  await checkScreen(own, testInfo, 'liff-gr-requester-done')
  await phone.close()
  expect(liffGrScene<RecordedReceipt>('receipt', s.poId)).toMatchObject({ poStatus: 'RECEIVED', receipt: { channel: 'LIFF', photos: [] } })
})

test('[§9.4] the first JavaScript of /liff/gr/[poId] — the receiving form of a linked receiver, with the LINE SDK and the page data in its HTML — is at most 200 KB gzip, opened from LINE and again with the LIFF session', async ({ browser }, testInfo) => {
  // Two POs, each opened from LINE and again with the session, and a PO of 40 lines made through the services
  test.setTimeout(300_000)
  const s = receivingScene('demo')
  // A PO of realistic size as well: the same requester's urgent request of 40 lines, sent to the supplier
  // (tests/e2e/liff-budget-scene.ts); the receiver of the scene receives it too
  const big = liffBudgetScene<{ poId: string }>('sent-po', s.requestNumber, String(BUDGET_DOCUMENT_LINES), sceneTag('size'))
  const lineUserId = newLineUserId()
  liffGrScene('link', s.receiver!, lineUserId)
  // Opened from LINE, the gate signs in and then the page shows the form; with the session the form is in the HTML. The
  // review and the photo code wait for a tap either way
  const ready = (page: Page) => expect(page.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' })).toBeVisible()
  for (const screen of [
    { name: '/liff/gr/<poId>', path: `/liff/gr/${s.poId}` },
    { name: `/liff/gr/<poId>, a PO of ${BUDGET_DOCUMENT_LINES} lines`, path: `/liff/gr/${big.poId}` },
  ]) {
    await expectFirstLoadsWithinBudget(browser, testInfo, { ...screen, lineUserId, ready })
  }
})
