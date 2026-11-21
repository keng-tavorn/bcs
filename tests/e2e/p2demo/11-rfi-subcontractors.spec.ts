import { deskAs } from '../p1demo/money-steps'
import { p1Sheet } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { p2Expected, p2SceneOf, p2Sheet, rfxRowsOf, s10, type RfxFacts } from './support'

// Scene 11 of the day of phase 2 (S10-18 · docs/sub-specs/S10.md "Demo ของขั้น" 3): the seed played an RFI to five
// subcontractors to its close and procurement's conclusion (RFx_Scenarios RFX-SUB-RFI). Its creator (the row's actor)
// filters the list by kind RFI: the RFI is concluded, with no price, no award and no PO (BR-RFX-02).

test('@p2demo [FR-SRC-201/AC4] scene 11: an RFI of five subcontractors ends with procurement\'s conclusion, without an award or a PO', async ({ browser }) => {
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 11)
  const rfx = s10<RfxFacts>('rfx', p2Expected<string>(scene, 'rfx'))
  expect(rfx.status).toBe(p2Expected<string>(scene, 'status'))
  expect(rfx.invites.map((i) => i.supplierCode).sort()).toEqual([...p2Expected<string[]>(scene, 'invited')].sort())
  expect(p2Expected<null>(scene, 'award')).toBeNull()
  expect(p2Expected<number>(scene, 'poCount')).toBe(0)

  const page = await deskAs(browser, p1, scene.actor)
  await page.goto('/sourcing?kind=RFI')
  const row = page.getByRole('list', { name: 'รายการ RFx' }).getByRole('listitem').filter({ hasText: rfx.number! })
  await expect(row).toContainText('สรุปผลแล้ว')
  await row.getByRole('link').first().click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(rfx.number!)
  // no scores and no award of an RFI: its page has no tab for them, and shows procurement's conclusion
  await expect(page.getByText('ขอข้อมูล (RFI) จากผู้ขาย ไม่มีการมอบงาน')).toBeVisible()
  const tabs = page.getByRole('tablist', { name: 'ส่วนของการจัดหา' })
  await expect(tabs.getByRole('tab', { name: 'ข้อเสนอ' })).toBeVisible()
  await expect(tabs.getByRole('tab', { name: 'ผล', exact: true })).toHaveCount(0)
  await expect(tabs.getByRole('tab', { name: 'คะแนน', exact: true })).toHaveCount(0)
  const note = (await rfxRowsOf(p2Expected<string>(scene, 'rfx'))).conclusionNote
  expect(note).toBeTruthy()
  await expect(page.getByText(note!).first()).toBeVisible()
  await page.context().close()
})
