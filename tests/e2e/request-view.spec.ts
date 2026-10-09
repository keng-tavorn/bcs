import { type Page, type TestInfo } from '@playwright/test'
import { castOf, expectNoBlockingAxe, fixtureOnce, rowWith, shot, signIn } from './tasks-support'
import { expectLinesFitLaptops } from './document-lines'
import { expect, test } from './fixtures'

// S2-12 requester side: "my requests" and one request — where it is now and for how long, the route the DOA engine
// chose and why, "approved under" the DOA rule, the timeline as stamps, and the requester's actions (FR-INT-008 AC1–AC3,
// FR-DOA-003 AC2, FR-DOA-005 AC2, FR-PLT-003 AC3, FR-INT-009). tasks-fixtures.ts creates, for this project's requester,
// one request approved, one returned with a reason and one still waiting that a colleague follows (once per run).

type Created = { requestId: string; number: string; taskId: string }
type Requests = { approved: Created; returned: Created; pending: Created }

function requests(testInfo: TestInfo): Requests {
  const cast = castOf(testInfo)
  return fixtureOnce<Requests>(testInfo, 'requests', 'requests', cast.requester, cast.approver, cast.follower)
}

const timeline = (page: Page) => page.getByRole('list', { name: 'ไทม์ไลน์ของคำขอ' })
const mine = (page: Page) => page.getByRole('list', { name: 'คำขอของฉัน' })
/** The page's own heading block (the workspace shell has a header of its own) */
const heading = (page: Page) => page.locator('#content header')
/** "ตอนนี้: …" — where the request is now, in one line */
const nowLine = (page: Page) => heading(page).locator('p', { hasText: 'ตอนนี้:' })
const DOA_REF = 'DOA-DEMO ฉบับ 1 ข้อ PR-02'

test('[FR-INT-008/AC3] "my requests" filters by status and finds a request by its document number', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  const r = requests(testInfo)
  await signIn(page, cast.requester, false)
  await page.goto('/requests')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('คำขอของฉัน')
  for (const c of [r.approved, r.returned, r.pending]) await expect(rowWith(mine(page), c.number)).toHaveCount(1)
  await expect(rowWith(mine(page), r.pending.number)).toContainText(`รอ ${cast.approverName}`)
  await expect(rowWith(mine(page), r.approved.number)).toContainText('อนุมัติแล้ว')
  await expect(rowWith(mine(page), r.returned.number)).toContainText('รอคุณแก้ไขแล้วส่งอีกครั้ง')
  await expect(rowWith(mine(page), r.pending.number)).toContainText('23,000.00')
  // Phones have no column header: the amount says what it is under it
  if (testInfo.project.name === 'mobile') await expect(rowWith(mine(page), r.pending.number).getByText('ยอดรวม VAT (บาท)', { exact: true })).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'requests')

  // By status: only returned requests
  await page.getByLabel('สถานะ').selectOption({ label: 'ตีกลับให้แก้ไข' })
  await page.getByRole('button', { name: 'แสดงคำขอที่ตรงกัน' }).click()
  await expect(page).toHaveURL(/status=RETURNED/)
  await expect(rowWith(mine(page), r.returned.number)).toHaveCount(1)
  await expect(rowWith(mine(page), r.approved.number)).toHaveCount(0)
  await expect(rowWith(mine(page), r.pending.number)).toHaveCount(0)

  // By part of the document number, in every status
  await page.getByLabel('สถานะ').selectOption({ label: 'ทุกสถานะ' })
  await page.getByLabel('เลขที่เอกสารหรือชื่อคำขอ').fill(r.pending.number.slice(-5))
  await page.getByRole('button', { name: 'แสดงคำขอที่ตรงกัน' }).click()
  await expect(mine(page).getByRole('listitem')).toHaveCount(1)
  await expect(rowWith(mine(page), r.pending.number)).toHaveCount(1)
  await expect(page.getByRole('status').filter({ hasText: /^พบ 1 จาก \d+ คำขอ$/ })).toBeVisible()
  await shot(page, testInfo, 'requests-filtered')

  // Nothing found says what to do next
  await page.getByLabel('เลขที่เอกสารหรือชื่อคำขอ').fill('PR-2569-99999')
  await page.getByRole('button', { name: 'แสดงคำขอที่ตรงกัน' }).click()
  await expect(page.getByText('ไม่พบคำขอที่ตรงกับเงื่อนไข')).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'requests-none')
  await page.getByRole('link', { name: 'ล้างตัวกรอง' }).first().click()
  await expect(rowWith(mine(page), r.approved.number)).toHaveCount(1)
})

test('[FR-INT-008/AC1] [FR-DOA-003/AC2] a waiting request shows who it waits for, for how long, the steps left and the route the DOA chose and why', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  const r = requests(testInfo)
  await signIn(page, cast.requester, false)
  await page.goto(`/requests/${r.pending.requestId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('วัสดุสิ้นเปลือง (รออนุมัติ)')
  await expect(heading(page)).toContainText('รออนุมัติ')
  await expect(heading(page)).toContainText(`รอ ${cast.approverName} (${cast.approverRole}) อนุมัติ`)
  await expect(heading(page)).toContainText(/ค้างมา/)
  await expect(heading(page)).toContainText(/ครบกำหนด|เกินกำหนด/)

  // The current step stands out with name, position and the business hours waited; the steps left follow
  const current = timeline(page).locator('[aria-current="step"]')
  await expect(current).toContainText('รออนุมัติ')
  await expect(current).toContainText(cast.approverName)
  await expect(current).toContainText(cast.approverRole)
  await expect(current).toContainText(/ค้างมา/)
  await expect(timeline(page).getByRole('listitem').last()).toContainText('ฝ่ายจัดซื้อออกใบสั่งซื้อ')

  // The actual route after submitting, with the rule and why (FR-DOA-003 AC2); a requester reads the rule as text
  const route = page.getByRole('region', { name: 'เส้นทางอนุมัติ' })
  await expect(route.getByText(DOA_REF, { exact: true })).toBeVisible()
  await expect(route.getByRole('link', { name: DOA_REF })).toHaveCount(0)
  await expect(route).toContainText('ทำไมไปทางนี้')
  await expect(route).toContainText(`${DOA_REF}: คำขอซื้อยอด 23,000.00 บาท (รวม VAT) อยู่ในช่วงมากกว่า 20,000.00 ถึงไม่เกิน 100,000.00`)
  await expect(route).toContainText(`ขั้นที่ 1 · ${cast.approverName}`)
  await expect(route).toContainText('กำลังรออนุมัติ')
  await expect(page.getByRole('region', { name: 'ยอดเงิน' })).toContainText(/ยอดรวม VAT\s*23,000\.00/)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'request-waiting')
  // At laptop widths, where the request's column is narrow, its lines still fit it (§9.9)
  await expectLinesFitLaptops(page, testInfo, page.getByRole('region', { name: 'รายการ', exact: true }).getByRole('list'), 'request-waiting-lines')
})

test('@demo [FR-DOA-005/AC2] [FR-PLT-003/AC3] an approved request names the DOA rule it was approved under, and stamps who, when and through which channel', async ({ page, browser }, testInfo) => {
  const cast = castOf(testInfo)
  const r = requests(testInfo)
  await signIn(page, cast.requester, false)
  await page.goto(`/requests/${r.approved.requestId}`)
  await expect(heading(page)).toContainText('อนุมัติแล้ว')
  await expect(heading(page)).toContainText('อนุมัติภายใต้')
  await expect(heading(page).getByText(DOA_REF, { exact: true })).toBeVisible()
  // The requester may not open the DOA admin page, so the reference is text rather than a link that ends in a refusal
  await expect(heading(page).getByRole('link', { name: DOA_REF })).toHaveCount(0)
  await expect(heading(page)).toContainText('รอฝ่ายจัดซื้อออกใบสั่งซื้อ')

  // Who, what, which channel, when, and the DOA version and rule (FR-PLT-003 AC3)
  const items = timeline(page).getByRole('listitem')
  await expect(items.filter({ hasText: /ส่งขออนุมัติ ได้เลขที่ PR-2569-\d{5}/ })).toContainText(cast.requesterName)
  const stamp = items.filter({ hasText: DOA_REF })
  await expect(stamp).toContainText('อนุมัติ')
  await expect(stamp).toContainText(cast.approverName)
  await expect(stamp).toContainText(cast.approverRole)
  await expect(stamp).toContainText(/\d{1,2} \S+ 25\d\d \d\d:\d\d น\. · เว็บ/)
  await expect(page.getByRole('region', { name: 'งบประมาณ' })).toContainText('จองงบแล้ว')
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'request-approved')

  // An organization admin may open DOA versions: the same reference links to the version it cites (FR-DOA-005 AC2)
  const adminContext = await browser.newContext()
  const admin = await adminContext.newPage()
  await signIn(admin, cast.proposer, true)
  await admin.goto(`/requests/${r.approved.requestId}`)
  const link = heading(admin).getByRole('link', { name: DOA_REF })
  await expect(link).toHaveAttribute('href', /^\/admin\/doa\/[0-9a-f-]{36}$/)
  await expect(timeline(admin).getByRole('listitem').filter({ hasText: DOA_REF }).getByRole('link', { name: DOA_REF })).toHaveAttribute('href', /^\/admin\/doa\/[0-9a-f-]{36}$/)
  await link.click()
  await expect(admin.getByRole('heading', { level: 1, name: 'DOA-DEMO ฉบับ 1' })).toBeVisible()
  await shot(admin, testInfo, 'request-approved-doa-version')
  await adminContext.close()
})

test('[FR-INT-009/AC2] [FR-INT-009/AC1] a returned request shows the reason; the requester sends it again, then cancels it with a reason', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  const r = requests(testInfo)
  await signIn(page, cast.requester, false)
  await page.goto(`/requests/${r.returned.requestId}`)
  await expect(page.getByRole('heading', { level: 3, name: 'ผู้อนุมัติตีกลับให้แก้ไข' })).toBeVisible()
  await expect(page.getByText('เหตุผล: แยกรายการให้ชัดเจนก่อนส่งอีกครั้ง')).toBeVisible()
  await expect(page.getByRole('link', { name: 'แก้ไขคำขอ' })).toHaveAttribute('href', `/requests/${r.returned.requestId}/edit`)
  const returnedStamp = timeline(page).getByRole('listitem').filter({ hasText: 'แยกรายการให้ชัดเจนก่อนส่งอีกครั้ง' })
  await expect(returnedStamp).toContainText('ตีกลับให้แก้ไข')
  await expect(returnedStamp).toContainText(cast.approverName)
  // The route says the step was returned, in words and with the return icon of the timeline
  await expect(page.getByRole('region', { name: 'เส้นทางอนุมัติ' })).toContainText('ตีกลับ')
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'request-returned')

  // §9.9 principle 3: a returned request is sent again only from the edit page's "ตรวจและส่ง", which shows first what is
  // left on the budget line, the route the DOA in effect gives now and the documents to attach — nothing on the request
  // page sends it at once
  await expect(page.getByRole('button', { name: 'ส่งขออนุมัติอีกครั้ง' })).toHaveCount(0)
  await expect(page.getByText('กด แก้ไขคำขอ แล้วตรวจงบคงเหลือ เส้นทางอนุมัติใหม่ และเอกสารที่ต้องแนบในขั้นตรวจและส่ง ก่อนกด ส่งขออนุมัติอีกครั้ง')).toBeVisible()
  await page.getByRole('link', { name: 'แก้ไขคำขอ' }).click()
  await expect(page).toHaveURL(new RegExp(`/requests/${r.returned.requestId}/edit$`))
  for (const step of ['รายการ ราคา และงบ', 'ผู้ขายและใบเสนอราคา', 'เอกสาร', 'ตรวจและส่ง']) await page.getByRole('button', { name: `ถัดไป: ${step}`, exact: true }).click()
  await expect(page.getByRole('heading', { level: 2, name: /^ขั้นที่ \d จาก \d: ตรวจและส่ง$/ })).toBeVisible()
  await expect(page.getByRole('region', { name: 'เส้นทางอนุมัติที่คาดไว้' })).toContainText(cast.approverName)
  await page.getByRole('button', { name: 'ส่งขออนุมัติอีกครั้ง', exact: true }).click()
  // §9.9 rule 7: the confirmation repeats the button's words, with who decides it now
  await expect(page.getByRole('status').filter({ hasText: 'ส่งขออนุมัติอีกครั้งแล้ว' })).toContainText(`ส่งขออนุมัติอีกครั้งแล้ว รอ ${cast.approverName}`)
  await page.goto(`/requests/${r.returned.requestId}`)
  await expect(heading(page)).toContainText(`รอ ${cast.approverName}`)
  await expect(timeline(page)).toContainText('ส่งขออนุมัติอีกครั้ง')
  await expect(page.getByRole('region', { name: 'เส้นทางอนุมัติ' })).toContainText('รอบที่ 2')

  // Cancelling cannot be undone: a reason and a tick first; each message goes once its field is fixed
  await page.getByText('ยกเลิกคำขอ', { exact: true }).click()
  await page.getByRole('button', { name: 'ยกเลิกคำขอนี้' }).click()
  await expect(page.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')).toBeVisible()
  await expect(page.getByText('ติ๊กยืนยันก่อน เพราะย้อนกลับไม่ได้')).toBeVisible()
  await page.getByLabel('เหตุผลที่ยกเลิก').fill('ใช้ของที่มีอยู่แทน')
  await expect(page.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')).toHaveCount(0)
  await page.getByLabel('ฉันต้องการยกเลิกคำขอนี้ และเข้าใจว่าย้อนกลับไม่ได้').check()
  await expect(page.getByText('ติ๊กยืนยันก่อน เพราะย้อนกลับไม่ได้')).toHaveCount(0)
  await shot(page, testInfo, 'request-cancel-form')
  await page.getByRole('button', { name: 'ยกเลิกคำขอนี้' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'ยกเลิกคำขอแล้ว' })).toBeVisible()
  await expect(heading(page)).toContainText('ยกเลิกแล้ว เหตุผล: ใช้ของที่มีอยู่แทน')
  await expect(page.getByRole('region', { name: 'งบประมาณ' })).toContainText('คืนงบแล้ว')
  // Nothing is left to do: the box of the requester's actions is gone with its old message
  await expect(page.getByRole('heading', { name: 'สิ่งที่ต้องทำ' })).toHaveCount(0)
  await expect(page.getByText('ส่งขออนุมัติอีกครั้งแล้ว')).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'request-cancelled')
})

test('[FR-INT-008/AC2] the requester, a follower and the approver see the same status; anybody else may not view the request', async ({ page, browser }, testInfo) => {
  const cast = castOf(testInfo)
  const r = requests(testInfo)

  await signIn(page, cast.stranger, false)
  await page.goto(`/requests/${r.pending.requestId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('คุณไม่มีสิทธิ์ดูคำขอนี้')
  await expect(page.getByText('วัสดุสิ้นเปลือง (รออนุมัติ)')).toHaveCount(0)
  await expect(page.getByText('ติดต่อผู้ขอ หรือผู้ดูแลระบบขององค์กร')).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'request-forbidden')

  /** Where the request is now and its current step, as one member sees them */
  const seenBy = async (code: string, withTotp: boolean) => {
    const context = await browser.newContext()
    const viewer = await context.newPage()
    await signIn(viewer, code, withTotp)
    await viewer.goto(`/requests/${r.pending.requestId}`)
    await expect(viewer.getByRole('heading', { level: 1 })).toHaveText('วัสดุสิ้นเปลือง (รออนุมัติ)')
    // The step's title and who it waits for (the minutes waited move on while the test runs)
    const step = await timeline(viewer).locator('[aria-current="step"] p').evaluateAll((lines) => lines.slice(0, 2).map((p) => p.textContent))
    const seen = { now: await nowLine(viewer).innerText(), step }
    return { context, viewer, seen }
  }

  const requester = await seenBy(cast.requester, false)
  expect(requester.seen.now).toContain(`รอ ${cast.approverName} (${cast.approverRole}) อนุมัติ`)
  await requester.context.close()

  // A follower: the request is in their list as followed, and its page says the same as the requester's
  const follower = await seenBy(cast.follower, false)
  expect(follower.seen).toEqual(requester.seen)
  // Only the requester gets the requester's actions
  await expect(follower.viewer.getByText('ยกเลิกคำขอ', { exact: true })).toHaveCount(0)
  await follower.viewer.goto('/requests')
  await expect(rowWith(mine(follower.viewer), r.pending.number)).toContainText('คุณติดตามคำขอนี้')
  await expect(rowWith(mine(follower.viewer), r.pending.number)).toContainText(`รอ ${cast.approverName}`)
  await expectNoBlockingAxe(follower.viewer)
  await shot(follower.viewer, testInfo, 'requests-follower')
  await follower.context.close()

  // The approver who holds the task sees the same status and the same current step
  const approver = await seenBy(cast.approver, true)
  expect(approver.seen).toEqual(requester.seen)
  await expect(approver.viewer.getByText('ยกเลิกคำขอ', { exact: true })).toHaveCount(0)
  await approver.context.close()
})
