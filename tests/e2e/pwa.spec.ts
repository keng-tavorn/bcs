import { expect, test } from './fixtures'

// FR-PLT-005 (S1-11): manifest, icons and the service worker on the production build. Installing from a real phone
// over the staging URL is checked in D-08.

const pngSize = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) })

test('[FR-PLT-005/AC1] the manifest installs BCS Workspace, standalone, with 192 and 512 px icons', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest')
  expect(res.ok()).toBe(true)
  const manifest = (await res.json()) as { name: string; short_name: string; start_url: string; display: string; icons: Array<{ src: string; sizes: string; purpose?: string }> }
  expect(manifest).toMatchObject({ name: 'BCS Workspace', short_name: 'BCS', start_url: '/?source=pwa', display: 'standalone' })
  expect(manifest.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true)
  for (const icon of manifest.icons) {
    const image = await request.get(icon.src)
    expect(image.headers()['content-type']).toContain('image/png')
    const { width, height } = pngSize(Buffer.from(await image.body()))
    expect(`${width}x${height}`).toBe(icon.sizes)
  }
})

test('[FR-PLT-005/AC3] on a first visit the service worker takes over without reloading, so typing is kept', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill('req_con@demo.bcs.local')
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  // A reload would have happened right after the controller changed; give it time to show
  await page.waitForTimeout(1000)
  await expect(page.getByLabel('อีเมลบริษัท')).toHaveValue('req_con@demo.bcs.local')
})

test('[FR-PLT-005/AC2] offline shows the Thai offline page; business pages are never cached', async ({ page, context }) => {
  await page.goto('/login')
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)

  // Visit a business page online first, then go offline and open it again
  await page.getByLabel('อีเมลบริษัท').fill('req_con@demo.bcs.local')
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')

  await context.setOffline(true)
  try {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ไม่มีการเชื่อมต่ออินเทอร์เน็ต')
    await expect(page.locator('html')).toHaveAttribute('lang', 'th')
    const cached = await page.evaluate(async () => {
      const paths: string[] = []
      for (const key of await caches.keys()) {
        const cache = await caches.open(key)
        for (const request of await cache.keys()) paths.push(new URL(request.url).pathname)
      }
      return paths.sort()
    })
    expect(cached).toEqual(['/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/manifest.webmanifest', '/offline'])
  } finally {
    await context.setOffline(false)
  }
})

test('the install page explains adding BCS to the home screen on iPhone', async ({ page }) => {
  await page.goto('/install')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ติดตั้ง BCS บนมือถือ')
  await expect(page.getByRole('heading', { level: 2, name: 'iPhone และ iPad (Safari)' })).toBeVisible()
})
