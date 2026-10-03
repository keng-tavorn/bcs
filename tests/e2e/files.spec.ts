import AxeBuilder from '@axe-core/playwright'
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

// FR-PLT-004 in a real browser against local S3 (RustFS): uploads go straight to the private bucket through presigned
// URLs (CORS), photos are prepared in the browser (AC3) and refusals are shown in Thai (AC1).

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill('req_con@demo.bcs.local')
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

/** Width and height from a JPEG's start-of-frame marker. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++
      continue
    }
    const marker = bytes[i + 1]!
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!
    if (marker >= 0xc0 && marker <= 0xc3) return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]! }
    i += 2 + length
  }
  throw new Error('no start-of-frame marker')
}

/** An EXIF APP1 segment holding a GPS latitude (13° 45' N), like a phone camera writes. */
function exifWithGps(): Buffer {
  const tiff = Buffer.alloc(80)
  tiff.write('II', 0, 'latin1')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(1, 8) // IFD0: one entry, the pointer to the GPS IFD
  tiff.writeUInt16LE(0x8825, 10)
  tiff.writeUInt16LE(4, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt32LE(26, 18)
  tiff.writeUInt32LE(0, 22)
  tiff.writeUInt16LE(2, 26) // GPS IFD: latitude reference and latitude
  tiff.writeUInt16LE(0x0001, 28)
  tiff.writeUInt16LE(2, 30)
  tiff.writeUInt32LE(2, 32)
  tiff.write('N\0', 36, 'latin1')
  tiff.writeUInt16LE(0x0002, 40)
  tiff.writeUInt16LE(5, 42)
  tiff.writeUInt32LE(3, 44)
  tiff.writeUInt32LE(56, 48)
  tiff.writeUInt32LE(0, 52)
  ;[13, 45, 0].forEach((value, k) => {
    tiff.writeUInt32LE(value, 56 + k * 8)
    tiff.writeUInt32LE(1, 60 + k * 8)
  })
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const header = Buffer.alloc(4)
  header.writeUInt16BE(0xffe1, 0)
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([header, payload])
}

const EXIF_MARK = Buffer.from('Exif\0\0', 'latin1')

test('[FR-PLT-004/AC3] camera photos are shrunk to 2,000 px and lose their GPS position before upload', async ({ page }) => {
  await signIn(page)
  await page.goto('/dev/upload')
  const plain = Buffer.from(
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 4000
      canvas.height = 3000
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#336655'
      ctx.fillRect(0, 0, 4000, 3000)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(200, 200, 1200, 900)
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.9))
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    }),
  )
  const photo = Buffer.concat([plain.subarray(0, 2), exifWithGps(), plain.subarray(2)])
  expect(photo.includes(EXIF_MARK)).toBe(true)
  expect(jpegSize(photo)).toEqual({ width: 4000, height: 3000 })

  await page.locator('input[type=file][accept="image/*"]').setInputFiles({ name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: photo })
  await expect(page.getByRole('status').filter({ hasText: 'แนบ IMG_0001.jpg แล้ว' })).toBeVisible()
  await page.getByRole('button', { name: 'เปิดไฟล์ IMG_0001.jpg' }).click()
  const href = await page.getByRole('link', { name: 'เปิดไฟล์ IMG_0001.jpg' }).getAttribute('href')
  const stored = Buffer.from(await (await page.request.get(href!)).body())
  const { width, height } = jpegSize(stored)
  expect(Math.max(width, height)).toBeLessThanOrEqual(2000)
  expect(width / height).toBeCloseTo(4 / 3, 2)
  expect(stored.includes(EXIF_MARK)).toBe(false)
})

test('[FR-PLT-004/AC1] other file types and renamed files are refused with a Thai message', async ({ page }) => {
  await signIn(page)
  await page.goto('/dev/upload')
  const anyFile = page.locator('input[type=file]').first()
  await anyFile.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
  await expect(page.getByRole('alert').filter({ hasText: 'ไฟล์ชนิดนี้แนบไม่ได้' })).toBeVisible()

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 64 }, (_, i) => i)])
  await anyFile.setInputFiles({ name: 'quote.pdf', mimeType: 'application/pdf', buffer: png })
  await expect(page.getByRole('alert').filter({ hasText: 'เนื้อไฟล์ไม่ตรงกับชนิดของไฟล์' })).toBeVisible()

  const pdf = Buffer.from('%PDF-1.7\n' + 'x'.repeat(100) + '\n%%EOF\n', 'latin1')
  await anyFile.setInputFiles({ name: 'ใบเสนอราคา.pdf', mimeType: 'application/pdf', buffer: pdf })
  await expect(page.getByRole('status').filter({ hasText: 'แนบ ใบเสนอราคา.pdf แล้ว' })).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])
})
