import type { BrowserContext, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import {
  anotherPhone,
  checkScreen,
  liffScene,
  mockLineUserOf,
  newLineUserId,
  openAsLineUser,
  pushesTo,
  richMenuOf,
  sceneTag,
  sessionCookie,
  totpOf,
  type SceneMember,
} from './liff-support'
import { E2E_BASE_URL } from '../support/e2e-env'

// S5-06 · /liff/link (FR-LINE-001, §9.2, ADR-049) at 375 px in the mobile project, each screen also checked at 1440 px.
// LIFF_MOCK stands in for the LINE app (the mock cookie names the LINE user; the fake LINE server of the run issues and
// verifies its ID token, keeps the rich menus and the messages). The codes come from the same service as the QR of
// /settings/line (liff-scene.ts).

test.describe('[FR-LINE-001/AC1] a code from the workspace, opened in LINE, links on the confirm tap and switches the menu', () => {
  test('shows whose account the code links, links only on the tap, welcomes in the chat and switches to the LINKED menu', async ({ page, context }, testInfo) => {
    const lineUserId = newLineUserId()
    const { member, code, linkedMenuId } = liffScene<{ member: SceneMember; code: string; linkedMenuId: string }>('code', sceneTag('qr'))
    await openAsLineUser(context, lineUserId)
    const linkPosts: string[] = []
    page.on('request', (request) => {
      if (request.url().endsWith('/api/liff/link')) linkPosts.push(request.method())
    })

    await page.goto(`/liff/link?code=${encodeURIComponent(code)}`)
    await expect(page.getByRole('heading', { level: 1, name: 'ผูกบัญชี LINE' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'ตรวจว่าเป็นบัญชีของคุณ' })).toBeVisible()
    await expect(page.getByText(member.organizationName)).toBeVisible()
    await expect(page.getByText(member.nameTh)).toBeVisible()
    await expect(page.getByText(member.nameEn)).toBeVisible()
    const confirm = page.getByRole('button', { name: 'ผูก LINE นี้กับบัญชีนี้' })
    await expect(confirm).toBeVisible()
    // Nothing is linked by opening the page: no request, still the default menu
    await page.waitForLoadState('networkidle')
    expect(linkPosts).toEqual([])
    expect(await richMenuOf(lineUserId)).toBeNull()
    // The confirm button sits in the bar at the bottom of the screen
    const bar = page.getByRole('region', { name: 'ยืนยันการผูกบัญชี' })
    const box = (await bar.boundingBox())!
    expect(box.y + box.height).toBeGreaterThan(page.viewportSize()!.height - 2)
    await checkScreen(page, testInfo, 'liff-link-preview')

    await confirm.click()
    await expect(page.getByText('ผูกบัญชีแล้ว', { exact: true })).toBeVisible()
    expect(linkPosts).toEqual(['POST'])
    await expect.poll(() => richMenuOf(lineUserId)).toBe(linkedMenuId)
    expect((await pushesTo(lineUserId)).length).toBeGreaterThan(0)
    await expect(page.getByRole('link', { name: 'ไปที่งานรออนุมัติ' })).toHaveAttribute('href', '/liff/tasks')
    await checkScreen(page, testInfo, 'liff-link-done')

    // The member now opens LIFF through LINE alone: /liff signs in with the ID token and goes to their tasks
    await page.goto('/liff')
    await expect(page).toHaveURL(/\/liff\/tasks$/)
    expect(await sessionCookie(context)).toMatch(/^liff_/)
    // The same QR again, through LINE's deep link (?liff.state=): the code is spent, and the member is told they need
    // no new one — their account is linked, to this very LINE account
    await page.goto(`/liff?liff.state=${encodeURIComponent(`/link?code=${code}`)}`)
    await expect(page).toHaveURL(/\/liff\/link\?code=/)
    await expect(page.getByText('รหัสผูกบัญชีนี้ใช้ไม่ได้แล้ว และไม่ต้องขอรหัสใหม่', { exact: false })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'LINE นี้ผูกกับบัญชี BCS แล้ว' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'ผูก LINE นี้กับบัญชีนี้' })).toHaveCount(0)
    await checkScreen(page, testInfo, 'liff-link-code-not-needed')
  })

  test('an expired code and a used code say so in words and link nothing', async ({ page, context }, testInfo) => {
    const lineUserId = newLineUserId()
    await openAsLineUser(context, lineUserId)
    const expired = liffScene<{ code: string }>('expired', sceneTag('old'))
    // The refusal is announced at once (role=alert), apart from Next's own route announcer
    const refusal = page.getByRole('alert').filter({ hasText: 'ผูกบัญชีไม่ได้' })
    await page.goto(`/liff/link?code=${encodeURIComponent(expired.code)}`)
    await expect(refusal).toContainText('รหัสผูกบัญชีนี้หมดอายุแล้ว (ใช้ได้ 10 นาที)')
    await expect(page.getByRole('link', { name: 'เปิดตั้งค่า LINE บนเว็บ' })).toHaveAttribute('href', '/settings/line')
    await expect(page.getByRole('button', { name: 'ผูก LINE นี้กับบัญชีนี้' })).toHaveCount(0)
    await checkScreen(page, testInfo, 'liff-link-expired')

    const used = liffScene<{ code: string }>('used', sceneTag('spent'), newLineUserId())
    await page.goto(`/liff/link?code=${encodeURIComponent(used.code)}`)
    await expect(refusal).toContainText('รหัสผูกบัญชีนี้ถูกใช้ไปแล้ว')
    await expect(page.getByRole('button', { name: 'ผูก LINE นี้กับบัญชีนี้' })).toHaveCount(0)
    await checkScreen(page, testInfo, 'liff-link-used')
    expect(await richMenuOf(lineUserId)).toBeNull()
  })

  test('with LIFF_MOCK on this machine, a code opened outside LINE says so, points to the web, and a developer goes on as a mock LINE user', async ({ page, context }, testInfo) => {
    const { code } = liffScene<{ code: string }>('code', sceneTag('dev'))
    // An ordinary browser: no mock LINE user yet
    await page.goto(`/liff/link?code=${encodeURIComponent(code)}`)
    await expect(page.getByText('เปิดลิงก์นี้ในแอป LINE เพื่อผูกบัญชี', { exact: false })).toBeVisible()
    await expect(page.getByRole('link', { name: 'เปิดตั้งค่า LINE บนเว็บ' })).toHaveAttribute('href', '/settings/line')
    await expect(page.getByRole('button', { name: 'ผูก LINE นี้กับบัญชีนี้' })).toHaveCount(0)
    await checkScreen(page, testInfo, 'liff-link-code-outside-line')
    await page.getByRole('button', { name: 'เปิดแบบผู้ใช้ LINE จำลอง' }).click()
    await expect(page.getByRole('button', { name: 'ผูก LINE นี้กับบัญชีนี้' })).toBeVisible()
    expect(await mockLineUserOf(context)).toMatch(/^U[0-9a-f]{32}$/)
  })
})

test.describe('[FR-LINE-001/AC2] starting from LINE without a code: e-mail, password and 2FA inside LIFF, then the link', () => {
  test('a LINE account that is not linked signs in to BCS in LIFF and links the signed-in member on the confirm tap', async ({ page, context }, testInfo) => {
    const lineUserId = newLineUserId()
    const { member, linkedMenuId } = liffScene<{ member: SceneMember; linkedMenuId: string }>('two-factor', sceneTag('mfa'))
    await openAsLineUser(context, lineUserId)
    await page.goto('/liff/link')
    await expect(page.getByRole('heading', { level: 2, name: 'เข้าสู่ระบบ BCS เพื่อผูกบัญชี' })).toBeVisible()
    await checkScreen(page, testInfo, 'liff-link-sign-in')

    await page.getByLabel('อีเมลบริษัท').fill(member.email)
    await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'ยืนยันตัวตนขั้นที่สอง' })).toBeVisible()
    // The second step, its switch to a backup code included, is tapped as easily as the rest (44 px)
    await checkScreen(page, testInfo, 'liff-link-sign-in-second')
    await page.getByLabel('รหัส 6 หลักจากแอป').fill(totpOf(member.employeeCode))
    await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()

    // Signed in on the web: whose account this LINE is about to be linked to, and the confirm tap
    await expect(page.getByRole('heading', { level: 2, name: 'ผูก LINE นี้กับบัญชีของคุณ' })).toBeVisible()
    await expect(page.getByText(member.nameTh)).toBeVisible()
    expect(await richMenuOf(lineUserId)).toBeNull()
    await checkScreen(page, testInfo, 'liff-link-confirm-member')
    await page.getByRole('button', { name: 'ผูก LINE นี้กับบัญชีของฉัน' }).click()
    await expect(page.getByText('ผูกบัญชีแล้ว', { exact: true })).toBeVisible()
    await expect.poll(() => richMenuOf(lineUserId)).toBe(linkedMenuId)
    expect((await pushesTo(lineUserId)).length).toBeGreaterThan(0)
  })
})

test.describe('[FR-LINE-001/AC3] unlinking from the LINE side, in LIFF', () => {
  test('a linked member unlinks after a second confirmation, and the menu goes back to the default one', async ({ page, context }, testInfo) => {
    const lineUserId = newLineUserId()
    const { member, linkedMenuId } = liffScene<{ member: SceneMember; linkedMenuId: string }>('linked', sceneTag('unlink'), lineUserId)
    expect(await richMenuOf(lineUserId)).toBe(linkedMenuId)
    await openAsLineUser(context, lineUserId)
    await page.goto('/liff/link')
    await expect(page.getByRole('heading', { level: 2, name: 'LINE นี้ผูกกับบัญชี BCS แล้ว' })).toBeVisible()
    await expect(page.getByText(member.nameTh)).toBeVisible()
    await checkScreen(page, testInfo, 'liff-link-linked')

    await page.getByRole('button', { name: 'ยกเลิกการผูก LINE นี้' }).click()
    await expect(page.getByText(`ยกเลิกการผูก LINE นี้กับบัญชีของ ${member.nameTh} ใช่ไหม`)).toBeVisible()
    await page.getByRole('button', { name: 'ยืนยันยกเลิกการผูก' }).click()
    await expect(page.getByText('ยกเลิกการผูกแล้ว', { exact: false })).toBeVisible()
    await expect.poll(() => richMenuOf(lineUserId)).toBeNull()
    await checkScreen(page, testInfo, 'liff-link-unlinked')
  })

  test('[FR-LINE-001/AC2] signed in with a password in another LINE app, the member is told the link is elsewhere, and can move it here', async ({ page, context, browser }, testInfo) => {
    const oldLine = newLineUserId()
    const { member, linkedMenuId } = liffScene<{ member: SceneMember; linkedMenuId: string }>('linked', sceneTag('move'), oldLine)
    // The old phone is signed in to BCS through its LINE app (a LIFF session)
    const oldPhone = await anotherPhone(browser)
    const old = await oldPhoneSignedIn(oldPhone, oldLine, member)
    // A new phone: its LINE account is not linked to anyone
    const newLine = newLineUserId()
    await openAsLineUser(context, newLine)
    await page.goto('/liff/link')
    await page.getByLabel('อีเมลบริษัท').fill(member.email)
    await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()

    // Never "this LINE is linked": the server checked this page's own ID token
    await expect(page.getByRole('heading', { level: 2, name: 'บัญชีของคุณผูกกับ LINE อื่นอยู่' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'LINE นี้ผูกกับบัญชี BCS แล้ว' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'ยกเลิกการผูก LINE นี้' })).toHaveCount(0)
    await checkScreen(page, testInfo, 'liff-link-other-line')

    await page.getByRole('button', { name: 'ยกเลิกการผูก LINE เดิม' }).click()
    await expect(page.getByText(`ยกเลิกการผูก LINE เดิมของบัญชี ${member.nameTh} ใช่ไหม`)).toBeVisible()
    await page.getByRole('button', { name: 'ยืนยันยกเลิกการผูก LINE เดิม' }).click()
    await expect(page.getByText('ยกเลิกการผูก LINE เดิมแล้ว', { exact: false })).toBeVisible()
    // The old phone's LINE lost its link and its menu; this one is not linked until the person confirms
    await expect.poll(() => richMenuOf(oldLine)).toBeNull()
    expect(await richMenuOf(newLine)).toBeNull()
    await checkScreen(page, testInfo, 'liff-link-other-unlinked')

    await page.getByRole('button', { name: 'ผูก LINE นี้กับบัญชีของฉัน' }).click()
    await expect(page.getByText('ผูกบัญชีแล้ว', { exact: true })).toBeVisible()
    await expect.poll(() => richMenuOf(newLine)).toBe(linkedMenuId)
    // The new phone kept its own password sign-in
    expect(await sessionCookie(context)).not.toMatch(/^liff_/)

    // The old phone is signed out for good: its session ended with the link it stood on, and its LINE account is not
    // linked to anyone now — the member's name and administrators are nowhere, and linking asks for a sign-in again
    await expectSignedOutOldPhone(old, member)
    await oldPhone.close()
  })

  test('unlinked on the web and linked again from another phone: the old phone’s LIFF session opens nothing any more', async ({ browser }) => {
    const oldLine = newLineUserId()
    const tag = sceneTag('web-move')
    const { member } = liffScene<{ member: SceneMember }>('linked', tag, oldLine)
    const oldPhone = await anotherPhone(browser)
    const old = await oldPhoneSignedIn(oldPhone, oldLine, member)
    // On the web: /settings/line ends the link, and the QR code of a new phone links another LINE account. The old phone
    // made no request in between, so nothing ended its session on the way
    liffScene('relink', tag, newLineUserId())
    await expectSignedOutOldPhone(old, member)
    await oldPhone.close()
  })
})

interface OldPhone {
  readonly page: Page
  /** The session cookie the old phone held while it was signed in, as the browser sends it */
  readonly cookie: string
}

/** The old phone opens /liff/help through its LINE app and is signed in as the member (a LIFF session) */
async function oldPhoneSignedIn(phone: BrowserContext, lineUserId: string, member: SceneMember): Promise<OldPhone> {
  await openAsLineUser(phone, lineUserId)
  const page = await phone.newPage()
  await page.goto('/liff/help')
  await expect(page.getByText(`ผู้ดูแลระบบของ ${member.organizationName}`, { exact: false })).toBeVisible()
  const session = (await phone.cookies(E2E_BASE_URL)).find((c) => c.name.endsWith('bcs.session_token'))
  expect(session?.value).toMatch(/^liff_/)
  return { page, cookie: `${session!.name}=${session!.value}` }
}

/** The old phone, after its link ended: nothing of the member's on any LIFF page, and its old session opens nothing */
async function expectSignedOutOldPhone(old: OldPhone, member: SceneMember): Promise<void> {
  const { page } = old
  await page.reload()
  await expect(page.getByRole('heading', { level: 2, name: 'เริ่มใช้ BCS ใน LINE' })).toBeVisible()
  await expect(page.getByText(`ผู้ดูแลระบบของ ${member.organizationName}`, { exact: false })).toHaveCount(0)
  await page.goto('/liff/link')
  await expect(page.getByRole('heading', { level: 2, name: 'เข้าสู่ระบบ BCS เพื่อผูกบัญชี' })).toBeVisible()
  await expect(page.getByText(member.nameTh)).toHaveCount(0)
  // The cookie the old phone held, sent again as it was (outside the browser), is no session: it was ended, not hidden
  const replayed = await fetch(`${E2E_BASE_URL}/liff/help`, { headers: { cookie: old.cookie } })
  const html = await replayed.text()
  expect(html).not.toContain(`ผู้ดูแลระบบของ ${member.organizationName}`)
  expect(html).not.toContain(member.nameTh)
}
