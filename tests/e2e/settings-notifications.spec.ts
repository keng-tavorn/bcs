import { expect, test } from './fixtures'
import { checkScreen, signInAs } from './insight-support'
import { digestMemberOf } from './settings-line-scene'

// FR-LINE-006 AC3 (/settings/notifications, NEW-31): a member switches their own daily summary off and on again; the page
// says that approval tasks and overdue work are always sent at once and cannot be switched off (BR-NOTI-04), and which
// notices go by LINE and which never do. The setting is saved (a reload shows it). A change whose answer never comes
// back is not called "not saved": the page says it does not know, and trying again makes the change once. Screens at
// the project's width with axe (§9.9).

test('[FR-LINE-006/AC3] a member switches their own daily summary off and on; approval tasks and overdue work stay immediate', async ({ page }, testInfo) => {
  const member = digestMemberOf(testInfo)
  await signInAs(page, member.code, member.totp)
  await page.goto('/settings/notifications')
  await expect(page.getByRole('heading', { level: 1, name: 'ตั้งค่าการแจ้งเตือน' })).toBeVisible()
  const digest = page.getByRole('switch', { name: 'ส่งสรุปรายวันให้ฉัน' })
  await expect(digest).toBeChecked()
  // The switch works once the page runs its script (src/ui/form/hydrated.ts): before that a tap would save nothing
  await expect(digest).toBeEnabled()

  // What cannot be switched off is said, not offered as a switch
  const always = page.getByRole('region', { name: 'แจ้งทันทีเสมอ ปิดไม่ได้' })
  await expect(always.getByRole('listitem')).toHaveCount(3)
  await expect(always.getByRole('listitem').filter({ hasText: 'งานที่รอคุณอนุมัติ' })).toContainText('ปิดไม่ได้')
  await expect(always.getByRole('listitem').filter({ hasText: 'การเตือนงานใกล้ครบกำหนดและงานเกินกำหนด' })).toContainText('ปิดไม่ได้')
  await expect(page.getByRole('switch')).toHaveCount(1)
  // Where they arrive: work notices by LINE when linked and LINE is on, security notices never by LINE (§10.1)
  const channel = page.getByRole('region', { name: 'ช่องทางที่ได้รับ' })
  await expect(channel).toContainText('เรื่องงาน เช่น งานรออนุมัติ การเตือนงาน ผลของคำขอ และสรุปรายวัน ส่งทาง LINE เมื่อคุณผูกบัญชี LINE และองค์กรเปิดใช้ LINE อยู่')
  await expect(channel).toContainText('ส่วนเรื่องความปลอดภัยของบัญชีส่งทางอีเมลเสมอ ไม่ส่งทาง LINE')
  await checkScreen(page, testInfo, 'settings-notifications')

  // The answer never comes back (the connection dropped): the switch goes back, and the page says it is not known
  // whether the change was saved — never that the old setting still applies
  const action = '**/settings/notifications'
  await page.route(action, (route) => (route.request().method() === 'POST' ? route.abort('connectionreset') : route.continue()))
  await page.getByText('ส่งสรุปรายวันให้ฉัน', { exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'ไม่ได้รับคำตอบจากระบบ จึงไม่แน่ใจว่าบันทึกแล้วหรือยัง ลองอีกครั้ง หรือโหลดหน้าใหม่เพื่อดูค่าที่ใช้อยู่' })).toBeVisible()
  await expect(page.getByText('ค่าเดิมยังใช้อยู่')).toHaveCount(0)
  await expect(digest).toBeChecked()
  await page.unroute(action)

  // Off (trying again): saved at once, said in words, kept after a reload
  await page.getByText('ส่งสรุปรายวันให้ฉัน', { exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'ปิดสรุปรายวันแล้ว งานรออนุมัติและงานเกินกำหนดยังแจ้งคุณทันทีเหมือนเดิม' })).toBeVisible()
  await expect(digest).not.toBeChecked()
  await checkScreen(page, testInfo, 'settings-notifications-off')
  await page.reload()
  await expect(page.getByRole('switch', { name: 'ส่งสรุปรายวันให้ฉัน' })).not.toBeChecked()

  // On again, with the keyboard
  await expect(page.getByRole('switch', { name: 'ส่งสรุปรายวันให้ฉัน' })).toBeEnabled()
  await page.getByRole('switch', { name: 'ส่งสรุปรายวันให้ฉัน' }).focus()
  await page.keyboard.press('Space')
  await expect(page.getByRole('status').filter({ hasText: 'เปิดรับสรุปรายวันแล้ว' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('switch', { name: 'ส่งสรุปรายวันให้ฉัน' })).toBeChecked()
})
