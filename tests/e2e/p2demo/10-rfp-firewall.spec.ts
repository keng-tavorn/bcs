import { deskAs } from '../p1demo/money-steps'
import { p1Sheet } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { bahtText, p2Expected, p2SceneOf, p2Sheet, rfxRowsOf, s10, type AwardFacts, type RfxFacts } from './support'

// Scene 10 of the day of phase 2 (S10-18 · core · docs/sub-specs/S10.md "Demo ของขั้น" 2): the seed played the RFP of a
// need of IT (RFx_Scenarios RFX-IT-FIREWALL) to its approved award. Procurement (the row's actor) reads it: the question
// of SP0142 and its answer to everyone without the asker's name (BR-RFX-04), the comparison before VAT, the totals where
// SP0142 wins without the lowest price (TECHNICAL SERVICE weigh 60%), the approved award under RA-01 by dm_proc — no PO,
// for a need has no request: an agreed price of ITM-006 with SP0142 instead, and SP0142 the preferred supplier of IT
// (BR-RFX-13 · FR-SRC-204 AC9). Then it_01 starts a request for the firewall: the catalogue item fills the agreed price,
// locked, and the form suggests SP0142 (BR-FORM-02 · BR-PRC-06 · FR-SRC-204 AC7).

test('@p2demo [FR-SRC-201/AC4] [FR-SRC-204/AC7] [FR-SRC-204/AC9] scene 10: the RFP is won on its total score, makes an agreed price instead of a PO, and the request form takes it', async ({ browser }) => {
  test.setTimeout(240_000)
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 10)
  const ref = p2Expected<string>(scene, 'rfx')
  const [rfx, rows] = [s10<RfxFacts>('rfx', ref), await rfxRowsOf(ref)]
  expect(rfx.status).toBe('AWARDED')
  const nameOf = new Map(rfx.invites.filter((i) => i.supplierCode).map((i) => [i.supplierCode!, i.supplierName!]))
  const winner = p2Expected<string[]>(scene, 'ranking')[0]!
  expect(winner).toBe(scene.supplier)

  // the award as the approval left it
  const award = s10<AwardFacts>('award', rfx.id)
  expect(award).toMatchObject({ status: 'APPROVED', net: p2Expected<string>(scene, 'awardNet'), gross: p2Expected<string>(scene, 'awardGross') })
  expect(award.route).toMatchObject({ rule: p2Expected<string>(scene, 'rule'), approvers: [p2Expected<string>(scene, 'approver')] })
  expect(award.pos).toHaveLength(p2Expected<number>(scene, 'poCount'))
  const agreed = p2Expected<{ item: string; supplier: string; unitPrice: string }>(scene, 'priceAgreement')
  expect(award.agreements).toContainEqual(agreed)
  expect(award.preferred).toContainEqual(expect.objectContaining({ category: p2Expected<string>(scene, 'preferredCategory'), supplier: winner }))

  // procurement reads it on the screens
  const page = await deskAs(browser, p1, scene.actor)
  await page.goto(`/sourcing/${rfx.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(rfx.number!)
  await page.goto(`/sourcing/${rfx.id}?tab=questions`)
  expect(rows.questions.length).toBeGreaterThan(0)
  for (const q of rows.questions) {
    await expect(page.getByText(q.question).first()).toBeVisible()
    await expect(page.getByText(q.answer, { exact: false }).first()).toBeVisible()
  }
  await expect(page.getByText('ตอบทุกราย').first()).toBeVisible()
  await page.goto(`/sourcing/${rfx.id}?tab=bids`)
  for (const net of Object.values(p2Expected<Record<string, string>>(scene, 'compareNet'))) await expect(page.getByText(bahtText(net)).first()).toBeVisible()
  await page.goto(`/sourcing/${rfx.id}?tab=scores`)
  for (const total of Object.values(p2Expected<Record<string, string>>(scene, 'totals'))) await expect(page.getByText(total).first()).toBeVisible()
  await page.goto(`/sourcing/${rfx.id}/award`)
  await expect(page.locator('main')).toContainText(award.number!)
  await expect(page.getByText(/^สร้างราคาตกลง 1 รายการจากผลนี้/)).toBeVisible()
  await page.context().close()

  // it_01 asks for the firewall: the catalogue item takes the agreed price, locked, and the form suggests the winner
  const requester = scene.others.find((c) => c.startsWith('it_'))!
  const form = await deskAs(browser, p1, requester)
  await form.goto('/requests/new/BUY_GOODS')
  await form.getByLabel('ชื่อคำขอ').fill('ไฟร์วอลล์สำนักงานตามผล RFP')
  await form.getByRole('button', { name: 'ถัดไป: รายการ ราคา และงบ', exact: true }).click()
  const budget = form.getByLabel('บรรทัดงบที่ใช้')
  if (!(await budget.inputValue())) await budget.selectOption((await budget.locator('option[value]:not([value=""])').first().getAttribute('value'))!)
  const line = form.getByRole('group', { name: 'รายการที่ 1' })
  await line.getByRole('button', { name: 'เลือกรายการที่ 1 จากแคตตาล็อก' }).click()
  const picker = form.getByRole('dialog', { name: 'เลือกจากแคตตาล็อกสำหรับรายการที่ 1' })
  await picker.getByLabel('ค้นหาในแคตตาล็อก', { exact: true }).fill(agreed.item)
  await picker.getByRole('button', { name: 'ค้นหา', exact: true }).click()
  await picker.getByRole('button', { name: new RegExp(`^เลือก .+ \\(${agreed.item}\\)$`) }).click()
  await expect(picker).toBeHidden()
  const price = line.getByLabel(/^ราคาต่อหน่วย/)
  await expect(price).toHaveValue(bahtText(agreed.unitPrice))
  await expect(price).toHaveAttribute('readonly', '')
  await expect(line).toContainText(`ราคาตกลงกับ ${nameOf.get(winner)} (ก่อน VAT) แก้ไม่ได้`)
  await line.getByLabel(/^จำนวน/).fill('2')
  await form.getByRole('button', { name: 'ถัดไป: ผู้ขายและใบเสนอราคา', exact: true }).click()
  await expect(form.getByLabel('ผู้ขายในทะเบียน (ไม่บังคับ)').locator('option:checked')).toHaveText(`${winner} · ${nameOf.get(winner)}`)
  await form.context().close()
})
