import { signInAs, p1Sheet, userOf } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { applicationOf, p2Expected, p2SceneOf, p2Sheet, s7 } from './support'

// Scene 2 of the day of phase 2 (S7-17 · S7 · FR-SUP-101 AC6 · BR-SUP-12): an application the supplier stopped filling in
// (the row's supplier, a ref of Supplier_Applications) waited past its reminder — the supplier got it, listing what is
// missing — and past its escalation, so its inviter and PROCUREMENT were told; the actor (PROCUREMENT) finds it under
// "ค้างเกินกำหนด" in /suppliers/applications and opens it: the required documents it still lacks are listed
// (expectJson.missing · BR-SUP ข้อ 11 · the bank book is not required). The seed played its timers back in time (S7-13)
// with the real SLA steps; on the day the reminder e-mail is in Mailpit once the notice job runs (the e2e app has none).

const TYPE_NAMES: Readonly<Record<string, string>> = { COMPANY_CERT: 'หนังสือรับรองบริษัท', VAT_CERT: 'ภ.พ.20', BANK_BOOK: 'หน้าสมุดบัญชีธนาคาร' }

test('@p2demo [FR-SUP-101/AC6] scene 2: an application waiting past its escalation shows as overdue with what it lacks; the supplier was reminded and procurement told', async ({ page }) => {
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 2)
  const app = applicationOf(sheet, p2Expected<string>(scene, 'application'))
  const missing = p2Expected<string[]>(scene, 'missing')
  const escalatedTo = p2Expected<string>(scene, 'escalatedTo')

  // what the timers did, in the database: reminded once with the list, escalated once to the inviter and PROCUREMENT
  const facts = s7<{ applicationId: string; status: string; escalatedAt: string | null; remindedAt: string | null; invitedBy: string | null; notices: Array<{ templateKey: string }>; told: Array<{ templateKey: string; to: string | null }> }>('stuck', app.contactEmail)
  expect(facts.status).toBe(app.status)
  expect(facts.remindedAt, 'the supplier was reminded (BR-SUP-12)').not.toBeNull()
  expect(facts.escalatedAt, 'the application was passed to procurement (BR-SUP-12)').not.toBeNull()
  expect(facts.notices.map((n) => n.templateKey)).toContain('supplier.application_reminder')
  expect(facts.invitedBy).toBe(app.invitedBy)
  expect(facts.told.filter((n) => n.templateKey === 'supplier.application_escalated').map((n) => n.to)).toEqual(expect.arrayContaining([escalatedTo]))

  // the actor's list: the application under the overdue badge
  await signInAs(page, p1, scene.actor)
  expect(userOf(p1, scene.actor).roles).toContain('PROCUREMENT')
  await page.goto('/suppliers/applications')
  const list = page.getByRole('list', { name: 'ใบสมัครผู้ขาย' })
  const item = list.getByRole('listitem').filter({ hasText: app.nameTh })
  await expect(item).toBeVisible()
  await expect(item).toContainText(p2Expected<string>(scene, 'badge'))
  await item.getByRole('link').first().click()
  await expect(page).toHaveURL(new RegExp(`/suppliers/applications/${facts.applicationId}$`))
  await expect(page.getByRole('heading', { level: 1 })).toContainText(app.nameTh)
  await expect(page.getByText(p2Expected<string>(scene, 'badge'), { exact: true }).filter({ visible: true }).first()).toBeVisible()
  // what it lacks before it can be sent: the required documents of the row, by their names
  for (const code of missing) await expect(page.getByText(new RegExp(TYPE_NAMES[code] ?? code)).first()).toBeVisible()
})
