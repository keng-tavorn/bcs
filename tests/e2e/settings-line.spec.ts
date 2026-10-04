import { expect, test } from './fixtures'
import { checkScreen, signInAs } from './insight-support'
import { bellOf, issueCodeOnPage, liffIdToken, linkerOf, linkInLine, newLineUserId, setLineActive, signedInAdmin, unlinkerOf } from './settings-line-scene'

// S5-04 web part · FR-LINE-001 AC1 AC3 (§9.2 step 1): a member signed in to the workspace asks for a one-time code on
// /settings/line and gets it as the LIFF link itself, as a QR drawn on the server and with its time left — on a phone the
// link comes first, on a wide screen the QR; opening it in LINE links (here the LIFF page's request to /api/liff/link
// with an ID token of the fake LINE server of the run) and the page shows the link by itself; the owner gets the
// security notice (ADR-049 item 10), and the page it opens links to ลืมรหัสผ่าน. Unlinking from the web asks first, and
// stays offered while the organization's LINE cannot be linked (switched off here by the administrator, and on again
// before the test ends; Playwright runs one test at a time). The code never appears in an address of BCS. Screens at the
// project's width with axe (§9.9).

test('[FR-LINE-001/AC1] a member gets a one-time code as a QR, the link and its time left, links in LINE, and the page shows the link', async ({ page, request }, testInfo) => {
  const member = linkerOf(testInfo)
  await signInAs(page, member.code, member.totp)
  await page.goto('/settings/line')
  await expect(page.getByRole('heading', { level: 1, name: 'บัญชี LINE' })).toBeVisible()
  await expect(page.getByText('ยังไม่ได้ผูกบัญชี LINE', { exact: true })).toBeVisible()
  await expect(page.getByText('ตอนนี้คุณได้รับงานและการแจ้งเตือนทางอีเมล')).toBeVisible()
  await checkScreen(page, testInfo, 'settings-line')

  const { url, code } = await issueCodeOnPage(page)
  expect(url).toBe(`https://liff.line.me/2000000002-e2eLiffApp/link?code=${encodeURIComponent(code)}`)
  const qr = page.getByRole('img', { name: 'คิวอาร์โค้ดสำหรับผูกบัญชี LINE ใช้ได้ครั้งเดียว' })
  const open = page.getByRole('link', { name: 'เปิดลิงก์ใน LINE' })
  await expect(qr).toBeVisible()
  await expect(open).toHaveAttribute('href', url)
  await expect(page.getByText('เปิดรหัสนี้ในแอป LINE ด้วยวิธีใดวิธีหนึ่ง', { exact: true })).toBeVisible()
  // A phone cannot scan its own screen: there the link comes before the QR; on a wide screen the QR comes first
  const [qrTop, openTop] = [(await qr.boundingBox())!.y, (await open.boundingBox())!.y]
  if (testInfo.project.name === 'mobile') expect(openTop).toBeLessThan(qrTop)
  else expect(qrTop).toBeLessThan(openTop)
  await expect(page.getByText(/^เหลือเวลา (10:00|9:[0-5]\d) \(ถึง \d{1,2} .+ \d{4} \d{2}:\d{2} น\.\) และใช้ได้ครั้งเดียว$/)).toBeVisible()
  await expect(page.getByText(/^อย่าส่งคิวอาร์โค้ดหรือลิงก์นี้ให้ผู้อื่น/)).toBeVisible()
  // The code lives in the page only: the address of BCS never carries it
  expect(page.url()).toMatch(/\/settings\/line$/)
  await checkScreen(page, testInfo, 'settings-line-code')

  // In LINE: the LIFF page sends the code with the ID token after the person confirms; this page notices by itself
  await linkInLine(page, request, code)
  await expect(page.getByText('ผูกบัญชี LINE แล้ว', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/^ผูกเมื่อ \d{1,2} .+ \d{4} \d{2}:\d{2} น\.$/)).toBeVisible()
  await expect(page.getByText('LINE ส่งงานและการแจ้งเตือนถึงคุณได้')).toBeVisible()
  await expect(page.getByRole('img', { name: 'คิวอาร์โค้ดสำหรับผูกบัญชี LINE ใช้ได้ครั้งเดียว' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'ยกเลิกการผูกบัญชี LINE' })).toBeVisible()

  // ADR-049 item 10: the account owner is told of the link (e-mail; the bell has it too)
  const bell = bellOf(page)
  await bell.locator('summary').click()
  await expect(bell.getByRole('button', { name: /มีการผูกบัญชี LINE กับบัญชี BCS ของคุณ/ })).toBeVisible()
  await bell.locator('summary').click()
  await checkScreen(page, testInfo, 'settings-line-linked')

  // The code works once: opened again by another LINE account, it links nothing
  const again = await page.request.post('/api/liff/link', { data: { code, idToken: await liffIdToken(request, newLineUserId()) } })
  expect({ status: again.status(), body: await again.json() }).toEqual({ status: 409, body: { ok: false, code: 'TOKEN_USED' } })
})

test('[FR-LINE-001/AC3] a linked member unlinks from the web after confirming it, offered even while LINE cannot be linked; the page shows LINE as not linked', async ({ page, request, browser, clientIp }, testInfo) => {
  const member = unlinkerOf(testInfo)
  await signInAs(page, member.code, member.totp)
  await page.goto('/settings/line')
  const { code } = await issueCodeOnPage(page)
  await linkInLine(page, request, code)
  await expect(page.getByText('ผูกบัญชี LINE แล้ว', { exact: true })).toBeVisible({ timeout: 20_000 })
  const unlink = page.getByRole('region', { name: 'ยกเลิกการผูก' })
  // A link the member did not make (the LINE_LINKED e-mail opens this page): what to do, and the way to ลืมรหัสผ่าน
  await expect(unlink.getByText(/^ถ้าคุณไม่ได้ผูกบัญชี LINE นี้เอง ให้ยกเลิกการผูกก่อน/)).toBeVisible()
  await expect(unlink.getByRole('link', { name: 'ไปหน้าลืมรหัสผ่าน' })).toHaveAttribute('href', '/forgot-password')

  // The organization's LINE cannot be linked for a while (the administrator switched it off): the member stays linked,
  // can still unlink from the web, is told that linking again waits for LINE, and the page claims nothing about how
  // LINE delivers
  const admin = await signedInAdmin(browser, testInfo, clientIp)
  try {
    await setLineActive(admin, false)
    await page.reload()
    await expect(page.getByText('ผูกบัญชี LINE แล้ว', { exact: true })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'ตอนนี้ผูกบัญชี LINE ใหม่ไม่ได้ เพราะองค์กรปิดใช้ LINE อยู่หรือยังตั้งค่าไม่ครบ บัญชี LINE ของคุณยังผูกอยู่' })).toBeVisible()
    await expect(page.getByText('LINE ส่งงานและการแจ้งเตือนถึงคุณได้')).toHaveCount(0)
    await expect(unlink.getByText(/และจะผูกใหม่ได้เมื่อองค์กรเปิดใช้ LINE ได้ครบแล้วเท่านั้น$/)).toBeVisible()
    await expect(unlink.getByRole('button', { name: 'ยกเลิกการผูกบัญชี LINE' })).toBeEnabled()
    await checkScreen(page, testInfo, 'settings-line-linked-off')
  } finally {
    await setLineActive(admin, true)
    await admin.context().close()
  }
  await page.reload()
  await expect(page.getByText('LINE ส่งงานและการแจ้งเตือนถึงคุณได้')).toBeVisible()

  // It cannot be undone without a new code, so it asks first
  await unlink.getByRole('button', { name: 'ยกเลิกการผูกบัญชี LINE' }).click()
  await unlink.getByRole('button', { name: 'ยืนยันยกเลิกการผูก' }).click()
  await expect(unlink.getByText('ติ๊กช่องยืนยันก่อนยกเลิกการผูก')).toBeVisible()
  await checkScreen(page, testInfo, 'settings-line-unlink-confirm')
  // Changed their mind: nothing happens
  await unlink.getByRole('button', { name: 'ไม่ยกเลิก' }).click()
  await expect(page.getByText('ผูกบัญชี LINE แล้ว', { exact: true })).toBeVisible()

  await unlink.getByRole('button', { name: 'ยกเลิกการผูกบัญชี LINE' }).click()
  await unlink.getByLabel('ยืนยันยกเลิกการผูก ปุ่มในการ์ด LINE ที่ได้รับแล้วจะใช้ไม่ได้').check()
  await unlink.getByRole('button', { name: 'ยืนยันยกเลิกการผูก' }).click()
  const done = page.getByRole('status').filter({ hasText: 'ยกเลิกการผูกบัญชี LINE แล้ว ระบบจะส่งงานและการแจ้งเตือนทางอีเมล' })
  await expect(done).toBeVisible()
  // ...and if the member did not make that link, the way on to a new password stays on the page
  await expect(done.getByRole('link', { name: 'ไปหน้าลืมรหัสผ่าน' })).toHaveAttribute('href', '/forgot-password')
  await expect(page.getByText('ยังไม่ได้ผูกบัญชี LINE', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ผูกบัญชี LINE', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'ยกเลิกการผูก' })).toHaveCount(0)
  await checkScreen(page, testInfo, 'settings-line-unlinked')

  // After a reload the page still says so (the unlink was saved, not only shown)
  await page.reload()
  await expect(page.getByText('ยังไม่ได้ผูกบัญชี LINE', { exact: true })).toBeVisible()
})
