import { p1Sheet, signInAs } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { dayFromToday, p2Expected, p2SceneOf, p2Sheet } from './support'

// Scene 7 of the day of phase 2 (S7-17 · S7-16 · BR-SUP ข้อ 13 · KPI G-7): the actor opens /reports/suppliers for the 90
// days up to yesterday — the approvals of the seed only, whatever scene 1 approved today — and reads the lower median of
// the business days from invitation to approval (expectJson.g7Median) of the approvals the row lists, each of them in the
// table, the median of the ones filled in by the supplier and by procurement beside it. The numbers come from the code.

test('@p2demo [BR-SUP-13] scene 7: G-7 of the seed\'s approvals is the row\'s median, each approval in the table', async ({ page }) => {
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 7)
  const approved = p2Expected<number[]>(scene, 'approved').map((d) => d.toFixed(1))
  await signInAs(page, p1, scene.actor)
  await page.goto(`/reports/suppliers?from=${dayFromToday(-90)}&to=${dayFromToday(-1)}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('รายงานผู้ขาย')
  const medians = page.getByRole('definition')
  await expect(medians.nth(0)).toHaveText(`${p2Expected<string>(scene, 'g7Median')} วันทำการ`)
  await expect(page.getByText(`ใบสมัครที่อนุมัติในช่วงนี้ (${approved.length} ใบ)`)).toBeVisible()
  const table = page.getByRole('region', { name: `ใบสมัครที่อนุมัติในช่วงนี้ (${approved.length} ใบ)` })
  for (const days of approved) await expect(table.getByText(days, { exact: true }).filter({ visible: true }).first()).toBeVisible()
})
