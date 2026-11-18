import { p1Sheet, signInAs } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { p2Expected, p2SceneOf, p2Sheet, s11Status } from './support'

// Scene 18 of the day of phase 2 (S11-15 · BR-RSK-12 · GC-RSK-44 GC-RSK-45 GC-RSK-49 · docs/sub-specs/S11.md "Demo ของขั้น"
// 18): the row's supplier carries the registry flag of sheet SupplierPayment (expectJson.registryFlag · the seed sets it
// after the history, so the history's PO of that supplier went out before it). The actor (PROCUREMENT) has a new PO of
// that supplier — the scene script drafts it through the real commands, like the supplier's last one — and opens it to
// send it for approval: the PO's band "ความเสี่ยงคู่ค้า" refuses with the row's reason (expectJson.gate), the submit
// stays disabled and "ขออนุมัติข้าม" is not offered (expectJson.overrideButton); called anyway, po.submit refuses with
// the row's code and riskOverride.request is refused too (expectJson.overrideRefused · BR-RSK-12: an override is for a
// tier, never for a supplier the registry says is gone). /risk lists a reassessment of reason STATUS_CHANGED for each
// supplier the row names (expectJson.statusChanged · reviewReason). Which flag a reassessment clears
// (expectJson.unblockByReassessment) is read from the gate of core with the supplier's own flag: VAT_CANCELLED clears with
// an assessment completed after the flag, CEASED never (the golden cases GC-RSK-45 GC-RSK-49 hold the rest).

const REASON_TH: Readonly<Record<string, string>> = {
  REGISTRY_CEASED: 'ผู้ขายรายนี้เลิกกิจการตามทะเบียนแล้ว ออกใบสั่งซื้อใหม่และขออนุมัติข้ามไม่ได้',
  REGISTRY_FLAGGED: 'สถานะทะเบียนของผู้ขายรายนี้เปลี่ยน (ออกจากระบบ VAT หรือหาไม่พบในทะเบียน) ต้องประเมินความเสี่ยงซ้ำให้เสร็จก่อน',
}
const REVIEW_REASON_TH: Readonly<Record<string, string>> = { STATUS_CHANGED: 'สถานะทะเบียนเปลี่ยน', SCHEDULED: 'ครบรอบ', OVERRIDE_EXPIRED: 'การอนุมัติข้ามหมดอายุ' }

interface SupplierFacts {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly registryFlag: string
  readonly reviews: readonly { readonly reason: string; readonly status: string }[]
}
type Refusal = { readonly ok: boolean; readonly code: string | null; readonly reason: string | null }

test('@p2demo [FR-RSK-203/AC4] [FR-RSK-203/AC6] [FR-RSK-205/AC3] scene 18: a supplier the registry says ceased is blocked on the PO, no override is offered or taken, /risk lists the reassessments', async ({ page }) => {
  test.setTimeout(4 * 60_000)
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 18)
  const gate = p2Expected<{ error: string; reason: string }>(scene, 'gate')
  const reviewReason = p2Expected<string>(scene, 'reviewReason')
  const supplier = s11Status<SupplierFacts>('supplier', scene.supplier!)
  expect(supplier.registryFlag).toBe(p2Expected<string>(scene, 'registryFlag'))

  // a new PO of the supplier, still a draft: the actor sends it for approval on its page
  const po = s11Status<{ id: string; status: string }>('po-like', supplier.code, scene.actor)
  expect(po.status).toBe('DRAFT')
  await signInAs(page, p1, scene.actor)
  await page.goto(`/procurement/pos/${po.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(supplier.nameTh)
  const band = page.getByRole('status').filter({ hasText: 'ความเสี่ยงคู่ค้า' })
  await expect(band).toContainText(REASON_TH[gate.reason]!)
  await expect(band.getByRole('link', { name: 'ขออนุมัติข้าม', exact: true })).toHaveCount(p2Expected<boolean>(scene, 'overrideButton') ? 1 : 0)
  await expect(page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true })).toBeDisabled()

  // the commands themselves, called anyway: the gate's refusal, and no override for a flagged supplier
  expect(s11Status<Refusal>('submit', po.id, scene.actor)).toEqual({ ok: false, code: gate.error, reason: gate.reason })
  const asked = s11Status<Refusal>('override', po.id, scene.actor)
  expect(asked.ok).toBe(!p2Expected<boolean>(scene, 'overrideRefused'))
  expect(asked.code).toBe('VALIDATION_FAILED')
  expect(asked.reason).toBe('REGISTRY_BLOCKED')

  // /risk: a reassessment for each supplier whose registry status changed
  await page.goto('/risk?tab=reviews')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ความเสี่ยงคู่ค้า')
  for (const code of p2Expected<string[]>(scene, 'statusChanged')) {
    const s = s11Status<SupplierFacts>('supplier', code)
    expect(s.reviews.filter((r) => r.reason === reviewReason && r.status === 'OPEN')).toHaveLength(1)
    await expect(page.getByRole('link', { name: `${s.code} ${s.nameTh} · ${REVIEW_REASON_TH[reviewReason]}`, exact: true })).toBeVisible()
  }

  // which flag a reassessment clears (BR-RSK-12): the gate of core on the supplier's own flag
  for (const [code, clears] of Object.entries(p2Expected<Record<string, boolean>>(scene, 'unblockByReassessment'))) {
    expect(s11Status<{ allowed: boolean }>('unblock', code).allowed, code).toBe(clears)
  }
})
