import { devices, type Page } from '@playwright/test'
import { E2E_BASE_URL, E2E_PIN } from '../../support/e2e-env'
import { actionsOf, cardTo, lineUserOf, tapPostback } from '../demo/support'
import { day, p1Sheet, signInAs } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { p2Expected, p2SceneOf, p2Sheet, s7 } from './support'

// Scene 1 of the day of phase 2 (S7-17 · S7 core · FR-SUP-101 to FR-SUP-104 · BR-SUP ข้อ 11 · BR-SUP ข้อ 16 · ADR-190):
// the actor (PROCUREMENT) invites the new supplier of expectJson.invite on the web; its contact opens the link of the
// e-mail on a phone (375 px), types the six-digit code, acknowledges the privacy notice and fills in the six steps — the
// bank account ending expectJson.bank.last4, the company certificate of expectJson.documents, the VAT registration and the
// bank book — and sends it; the actor verifies the documents; the next person (others[0]) checks the registries and
// sends it for approval (with a proof when the registries cannot confirm it · BR-SUP-03); the approver of SA-01
// (expectJson.approver) approves it from the card in the LINE chat: the supplier exists with a code. Its bank account
// became a request from the portal (expectJson.bankRule · ADR-190): FINANCE (others[2]) claims it, calls the number the
// inviter gave and sends it for approval; the CFO (expectJson.bankApprover) approves it with the PIN on the web. The
// application's number, the supplier's code and the request's number are read from the screens (numbersFromScreen).
// With the AI off (the seed's SIMEC keeps module AI off for this scene · EG-1) the form is filled by hand.

const PDF = (what: string) => Buffer.from(`%PDF-1.7\n% ${what} of scene 1 of the day of phase 2 (synthetic)\n%%EOF\n`)
const ACCOUNT_NO = (last4: string) => `123456${last4}`

async function phoneOf(browser: import('@playwright/test').Browser): Promise<Page> {
  const context = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 375, height: 812 }, baseURL: E2E_BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
  return context.newPage()
}
async function deskOf(browser: import('@playwright/test').Browser): Promise<Page> {
  const context = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: E2E_BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
  return context.newPage()
}

test('@p2demo [FR-SUP-101/AC1] [FR-SUP-101/AC3] [FR-SUP-104/AC5] scene 1: invited on the web, applies on a phone, verified, approved from the LINE card; its bank account approved by the CFO with the PIN', async ({ browser }, testInfo) => {
  test.setTimeout(600_000)
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 1)
  const invite = p2Expected<{ nameTh: string; taxId: string; branchCode: string; email: string; contactName: string }>(scene, 'invite')
  const docs = p2Expected<Record<string, { issuedOn: string }>>(scene, 'documents')
  const bank = p2Expected<{ bankCode: string; last4: string }>(scene, 'bank')
  const approver = p2Expected<string>(scene, 'approver')
  const bankApprover = p2Expected<string>(scene, 'bankApprover')
  const [router, , finance] = scene.others
  // the approver's phone is linked before anything is sent: the card's in-chat button needs the LINE token issued when
  // the task is assigned to a linked member (BR-TOK-01)
  day('prepare', `${approver}:${lineUserOf(approver)}`)

  // the invitation, on the web
  const desk = await deskOf(browser)
  await signInAs(desk, p1, scene.actor)
  await desk.goto('/suppliers/invite')
  await expect(desk.getByRole('heading', { level: 1 })).toHaveText('เชิญผู้ขาย')
  await desk.getByLabel('ชื่อผู้ขาย').fill(invite.nameTh)
  await desk.getByLabel('เลขผู้เสียภาษี').fill(invite.taxId)
  await desk.getByLabel('สาขา').fill(invite.branchCode)
  await desk.getByLabel('เบอร์โทรของผู้ขายที่จัดซื้อรู้จัก').fill('032-000-2010')
  await desk.getByLabel('ชื่อผู้ติดต่อ').fill(invite.contactName)
  await desk.getByLabel('อีเมลผู้ติดต่อ').fill(invite.email)
  await desk.getByRole('button', { name: 'ส่งคำเชิญทางอีเมล' }).click()
  // a name or e-mail resembling a registered supplier asks for a reason inline (BR-SUP ข้อ 09) before the invitation goes
  const warned = desk.getByRole('heading', { name: 'ข้อมูลคล้ายผู้ขายที่มีอยู่ บอกเหตุผลก่อนเชิญ' })
  const sent = desk.getByText('ส่งคำเชิญแล้ว')
  await expect(warned.or(sent)).toBeVisible()
  if (await warned.isVisible()) {
    for (const reason of await desk.getByRole('textbox', { name: /คล้ายผู้ขายที่มีอยู่|ซ้ำ/ }).all()) await reason.fill('คนละบริษัท จดทะเบียนคนละเลข ตรวจกับกรมพัฒน์แล้ว')
    await desk.getByRole('button', { name: 'ส่งคำเชิญทางอีเมล' }).click()
  }
  await expect(sent).toBeVisible()
  const invited = s7<{ applicationId: string; contactId: string; url: string; status: string }>('invitation', invite.email)
  expect(invited.status).toBe('INVITED')

  // the supplier's phone: the link, the code, the privacy notice
  const phone = await phoneOf(browser)
  await phone.goto(invited.url.replace(/^https?:\/\/[^/]+/, E2E_BASE_URL))
  await phone.getByRole('button', { name: 'ส่งรหัสยืนยันให้ฉัน' }).click()
  await phone.getByLabel('รหัสยืนยัน 6 หลัก').fill(s7<{ code: string }>('code', invited.contactId).code)
  await phone.getByRole('button', { name: 'เข้าระบบ' }).click()
  await expect(phone.getByRole('heading', { level: 1 })).toHaveText('ประกาศความเป็นส่วนตัว')
  await phone.getByRole('button', { name: 'รับทราบ' }).click()
  const next = () => phone.getByRole('button', { name: 'บันทึกแล้วไปขั้นถัดไป' }).click()
  // 1 company · 2 tax · 3 contacts · 4 bank · 5 documents · 6 check and send
  await expect(phone.getByText(`ขั้นที่ 1 จาก ${p2Expected<number>(scene, 'steps')}`)).toBeVisible()
  await phone.getByLabel('ที่อยู่ตามทะเบียน').fill('99 หมู่ 4 ต.เจดีย์หัก อ.เมือง จ.ราชบุรี 70000')
  await phone.getByLabel('เบอร์โทรศัพท์').fill('032-310-555')
  await next()
  await expect(phone.getByText('ขั้นที่ 2 จาก 6')).toBeVisible()
  await phone.getByLabel('จดทะเบียนภาษีมูลค่าเพิ่ม (VAT)').check()
  await next()
  await expect(phone.getByText('ขั้นที่ 3 จาก 6')).toBeVisible()
  await next()
  await expect(phone.getByText('ขั้นที่ 4 จาก 6')).toBeVisible()
  await phone.getByLabel('ธนาคาร', { exact: true }).selectOption(bank.bankCode)
  await phone.getByLabel('เลขที่บัญชี', { exact: true }).fill(ACCOUNT_NO(bank.last4))
  await phone.getByLabel('ชื่อบัญชี', { exact: true }).fill(invite.nameTh)
  await next()
  await expect(phone.getByText('ขั้นที่ 5 จาก 6')).toBeVisible()
  const send = async (name: string, issuedOn: string, expiresOn: string | null) => {
    const item = phone.getByRole('listitem').filter({ has: phone.getByRole('heading', { name, exact: true }) })
    await item.getByLabel('ไฟล์').setInputFiles({ name: `${name}.pdf`, mimeType: 'application/pdf', buffer: PDF(name) })
    await item.getByLabel('วันที่ออก').fill(issuedOn)
    const expiry = item.getByLabel(/^วันหมดอายุ/)
    if (expiresOn && (await expiry.count()) > 0) await expiry.fill(expiresOn)
    await item.getByRole('button', { name: `ส่ง ${name}` }).click()
    await expect(phone.getByText('ขั้นที่ 5 จาก 6')).toBeVisible()
    await expect(phone.getByRole('listitem').filter({ has: phone.getByRole('heading', { name, exact: true }) })).not.toContainText('ยังไม่ได้ส่ง')
  }
  await send('หนังสือรับรองบริษัท', docs.COMPANY_CERT!.issuedOn, null)
  await send('ภ.พ.20', '2019-03-01', '2029-02-28')
  await send('หน้าสมุดบัญชีธนาคาร', docs.COMPANY_CERT!.issuedOn, null)
  await phone.getByRole('link', { name: 'ตรวจและส่ง' }).last().click()
  await expect(phone.getByText('ขั้นที่ 6 จาก 6')).toBeVisible()
  await expect(phone.getByText(`•••• ${bank.last4}`)).toBeVisible()
  await phone.getByRole('button', { name: /^ส่งใบสมัครให้ / }).click()
  const sentNotice = phone.getByRole('status').filter({ hasText: /ส่งใบสมัครเลขที่ SUP-/ })
  await expect(sentNotice).toBeVisible()
  const number = /SUP-\d{4}-\d{5}/.exec((await sentNotice.textContent()) ?? '')![0]
  await phone.context().close()

  // the files' central scan (job file-scan: the e2e app has no Inngest), then the actor verifies each document
  expect(s7<{ scanned: number }>('scan', invited.applicationId).scanned).toBe(3)
  await desk.goto(`/suppliers/applications/${invited.applicationId}`)
  await expect(desk.getByRole('heading', { level: 1 })).toContainText(number)
  for (let i = 0; i < 3; i++) {
    await desk.getByRole('button', { name: /^ยืนยัน/ }).first().click()
    await expect(desk.getByText('ยืนยันแล้ว').nth(i)).toBeVisible()
  }
  await desk.context().close()

  // the next person checks the registries and sends it for approval (a proof when they cannot confirm it · BR-SUP-03)
  const routing = await deskOf(browser)
  await signInAs(routing, p1, router!)
  await routing.goto(`/suppliers/applications/${invited.applicationId}`)
  await routing.getByRole('button', { name: 'ตรวจทะเบียนแล้วส่งเข้าเส้นทางอนุมัติ' }).click()
  const unconfirmed = routing.getByText(/ทะเบียนยืนยันผู้ขายรายนี้ไม่ได้/)
  const pending = routing.getByText('รออนุมัติ').first()
  await expect(unconfirmed.or(pending)).toBeVisible({ timeout: 30_000 })
  if (await unconfirmed.isVisible()) {
    await routing.locator('input[type="file"]').first().setInputFiles({ name: 'หนังสือรับรองที่ตรวจแล้ว.pdf', mimeType: 'application/pdf', buffer: PDF('proof') })
    await expect(routing.getByText(/แนบแล้ว: /)).toBeVisible()
    await routing.getByRole('button', { name: 'ตรวจทะเบียนแล้วส่งเข้าเส้นทางอนุมัติ' }).click()
  }
  await expect(pending).toBeVisible({ timeout: 30_000 })
  await routing.context().close()

  // the approver of SA-01 approves in the LINE chat, from the card
  day('deliver', approver, invited.applicationId)
  const card = await cardTo(approver, number)
  const approve = actionsOf(card).find((a) => a.type === 'postback' && /a=approve/.test((a as { data?: string }).data ?? ''))
  expect(approve, 'the card approves in the chat (OQ-189)').toBeDefined()
  const tap = tapPostback(testInfo, approver, (approve as { data: string }).data)
  expect(tap.status, tap.printed).toBe(200)
  await expect.poll(() => s7<{ status: string; channel: string | null }>('application', invited.applicationId), { timeout: 30_000 }).toMatchObject({ status: 'APPROVED', channel: 'LINE_CHAT' })
  const made = s7<{ supplierCode: string; bankChange: { id: string; status: string; source: string } | null }>('application', invited.applicationId)
  expect(made.supplierCode).toMatch(/^SP\d{4}$/)
  expect(made.bankChange).toMatchObject({ status: 'DRAFT', source: 'PORTAL' })

  // FINANCE claims the request from the portal, calls the inviter's number and sends it for approval
  const fin = await deskOf(browser)
  await signInAs(fin, p1, finance!)
  await fin.goto(`/finance/bank-accounts/changes/${made.bankChange!.id}`)
  await fin.getByRole('button', { name: 'รับเรื่องเป็นผู้ดำเนินการ' }).click()
  await expect(fin.getByRole('button', { name: 'รับเรื่องเป็นผู้ดำเนินการ' })).toHaveCount(0, { timeout: 30_000 })
  await expect(fin.getByText(/032-000-2010/).first()).toBeVisible()
  await fin.getByLabel('บันทึกการโทร').fill('โทรเบอร์ที่จัดซื้อผู้เชิญให้ไว้ ผู้ขายยืนยันบัญชีรับเงินนี้')
  const confirmCall = fin.getByRole('checkbox', { name: /ฉันโทรเบอร์/ })
  if ((await confirmCall.count()) > 0) await confirmCall.check()
  await fin.getByRole('button', { name: 'บันทึกการโทร' }).click()
  await expect(fin.getByText('บันทึกการโทรแล้ว')).toBeVisible()
  // the bank book page the supplier sent with its application, attached as the request's proof (it is not carried over
  // by itself: S7-29); one still waiting for the central scan is scanned now (no job in e2e), as submit refuses it
  const proofs = fin.getByRole('region', { name: 'หลักฐาน' })
  await proofs.locator('input[type="file"]').setInputFiles({ name: 'หน้าสมุดบัญชีธนาคาร.pdf', mimeType: 'application/pdf', buffer: PDF('bank book') })
  await expect(proofs.getByText('หน้าสมุดบัญชีธนาคาร.pdf').first()).toBeVisible({ timeout: 30_000 })
  s7<{ scanned: number }>('scan-proofs', made.bankChange!.id)
  await fin.reload()
  await fin.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
  const sentChange = fin.getByText(/ส่งขออนุมัติแล้ว เลขคำขอ BAC-/)
  await expect(sentChange).toBeVisible({ timeout: 30_000 })
  const changeNo = /BAC-\d{4}-\d{5}/.exec((await sentChange.textContent()) ?? '')![0]
  await fin.context().close()

  // the CFO approves it with the PIN (BR-DOA-25: a bank account always asks for the PIN)
  const cfo = await deskOf(browser)
  await signInAs(cfo, p1, bankApprover)
  await cfo.goto(`/finance/bank-accounts/changes/${made.bankChange!.id}`)
  await expect(cfo.locator('main')).toContainText(changeNo)
  const bar = cfo.getByRole('region', { name: 'ตัดสินคำขอนี้' })
  await expect(cfo.locator('main')).not.toContainText(ACCOUNT_NO(bank.last4))
  await bar.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
  await bar.getByLabel('PIN 6 หลัก').fill(E2E_PIN)
  await bar.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(cfo.getByText('อนุมัติแล้ว').first()).toBeVisible({ timeout: 30_000 })
  await cfo.context().close()
})
