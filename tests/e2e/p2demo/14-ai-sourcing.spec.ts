import { confirmAiValues } from '../p1demo/ai-steps'
import { deskAs } from '../p1demo/money-steps'
import { p1Sheet, userOf } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { bahtText, p2Expected, p2SceneOf, p2Sheet, s10, type RfxFacts } from './support'

// Scene 14 of the day of phase 2 (S10-18 · docs/sub-specs/S10.md "Demo ของขั้น" 6 · FR-AI-305 · BR-AI-31 BR-AI-32 · EG-1),
// with module AI on (AI_MODE=fixture: recorded answers). The row's actor (procurement):
//   - drafts a new steel RFQ with "ร่าง RFx ด้วย AI": the Sourcing Agent writes the title, the description and each
//     line's English (tests/fixtures/ai/RFX_DRAFT, keyed by the RFx's kind, category and lines); the kind and each line's
//     English are confirmed one by one, the rest together, then saved (BR-AI-31)
//   - on the RFQ of scene 9 (closed, scored, awarded by 09-rfq-steel.spec.ts) asks for the summary of the bids and the
//     points to negotiate: every number in the words is filled in by code from the facts (BR-AI-27) — the spread
//     300,950.00 to 305,500.00 is 151 bp, and the incumbent nearest the lowest (S10-09: a supplier of a STEEL PO within
//     the price window — SP0024 and SP0029 both, SP0024 the nearer) is 2,788.32 above it, 93 bp (scripts/s10.ts
//     ai-answers files the recording under the key of the facts as played)
//   - with module AI off, the three buttons are gone and the RFx's pages work as before; AI is switched back on after

test('@p2demo [FR-AI-305/AC1] [FR-AI-305/AC2] [FR-AI-305/AC3] [FR-AI-305/AC6] scene 14: the Sourcing Agent drafts an RFx, summarizes the bids of scene 9 and points to negotiate; without AI the buttons are gone', async ({ browser }) => {
  test.setTimeout(240_000)
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 14)
  expect(p2Expected<string>(scene, 'agent')).toBe('SOURCING')
  expect(p2Expected<string[]>(scene, 'purposes')).toEqual(['RFX_DRAFT', 'BID_SUMMARY', 'NEGOTIATION_POINTS'])
  const spread = p2Expected<{ low: string; high: string; bp: number }>(scene, 'spread')
  const negotiation = p2Expected<{ supplier: string; gap: string; gapBp: number }>(scene, 'negotiation')
  const steel = s10<RfxFacts>('rfx', p2Expected<string>(p2SceneOf(sheet, 9), 'rfx'))
  expect(steel.status).not.toBe('OPEN')
  const incumbent = steel.invites.find((i) => i.supplierCode === negotiation.supplier)!.supplierName!
  const { rfxEventId: draftId } = s10<{ rfxEventId: string }>('ai-draft-rfx', userOf(p1, scene.actor).email)

  const page = await deskAs(browser, p1, scene.actor)
  try {
    // RFX_DRAFT (L1): proposed, confirmed, saved
    await page.goto(`/sourcing/${draftId}/edit?step=general`)
    await page.getByRole('button', { name: 'ร่าง RFx ด้วย AI' }).click()
    await expect(page.getByRole('status').filter({ hasText: /^ผู้ช่วยร่างแล้ว/ }).first()).toBeVisible({ timeout: 30_000 })
    const box = page.getByRole('region', { name: 'ค่าที่ผู้ช่วยจัดหาร่าง' })
    await confirmAiValues(box, ['ชนิด RFx', 'คำอธิบายภาษาอังกฤษ บรรทัด 1', 'คำอธิบายภาษาอังกฤษ บรรทัด 2'])
    await expect(page.getByLabel(/^คำอธิบายภาษาอังกฤษ บรรทัด 1$/)).toHaveValue('Deformed steel bar DB12 SD40')
    await page.getByRole('button', { name: 'บันทึกข้อมูลทั่วไป' }).click()
    await expect(page.getByText('บันทึกข้อมูลทั่วไปแล้ว')).toBeVisible()

    // BID_SUMMARY NEGOTIATION_POINTS (L0) on the RFQ of scene 9
    const filed = s10<{ filed: Array<{ key: string; written: boolean }> }>('ai-answers', steel.id).filed
    expect(filed.map((f) => f.key.split('/')[0])).toEqual(['BID_SUMMARY', 'NEGOTIATION_POINTS'])
    await page.goto(`/sourcing/${steel.id}?tab=bids`)
    const ai = page.getByRole('region', { name: 'สรุปโดย AI' })
    await ai.getByRole('button', { name: 'สรุปข้อเสนอ' }).click()
    const summary = ai.getByRole('list').first()
    await expect(summary).toContainText(bahtText(spread.low), { timeout: 30_000 })
    await expect(summary).toContainText(bahtText(spread.high))
    await expect(summary).toContainText(`${spread.bp} bp`)
    await ai.getByRole('button', { name: 'เสนอประเด็นเจรจา' }).click()
    const points = ai.getByRole('list').nth(1)
    await expect(points).toContainText(incumbent, { timeout: 30_000 })
    await expect(points).toContainText(bahtText(negotiation.gap))
    await expect(points).toContainText(`${negotiation.gapBp} bp`)

    // EG-1: module AI off, the buttons are gone and the pages stay whole
    s10('ai-module', 'off')
    await page.reload()
    await expect(page.getByRole('region', { name: 'สรุปโดย AI' })).toHaveCount(0)
    await expect(page.getByText(bahtText(spread.low)).first()).toBeVisible()
    await page.goto(`/sourcing/${draftId}/edit?step=general`)
    await expect(page.getByRole('button', { name: 'บันทึกข้อมูลทั่วไป' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'ร่าง RFx ด้วย AI' })).toHaveCount(0)
  } finally {
    s10('ai-module', 'on')
    await page.context().close()
  }
})
